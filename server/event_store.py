"""RepoCiv — JSONL Event Store.

Appends every Command lifecycle event to a single JSONL file.
One JSON object per line. File survives bridge restart so sessions are replayable.

Event types persisted:
  CommandCreated, CommandQueued, CommandStarted,
  AgentOutputChunk, CommandCompleted, CommandFailed, CommandRejected
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any


_lock = threading.Lock()
_store_path: Path | None = None

# ── Dual-write to DuckDB Ledger (best-effort) ─────────────────────────────────
# Imported lazily to avoid circular imports and to allow the ledger to be
# disabled gracefully when duckdb is not installed.
def _ledger_ingest(event: dict[str, Any]) -> None:
    """Forward a terminal event to the ResearchLedger (best-effort).

    Never raises. If DuckDB is unavailable the event is silently skipped.
    The JSONL write already succeeded at this point.
    """
    try:
        from server import research_ledger as _rl  # noqa: PLC0415
        _rl.get_ledger().ingest_event(event)
    except Exception:
        pass  # ledger failure must never break the event store


def init(store_dir: Path) -> None:
    global _store_path
    store_dir.mkdir(parents=True, exist_ok=True)
    _store_path = store_dir / "events.jsonl"
    _migrate_legacy_davi()


# One-shot migration: rewrite the persisted JSONL so historical events
# that referenced the legacy personal agent name "DAVI" now point at the
# generic "MAIN" slot. The migration is idempotent (the marker file prevents
# a second pass even if init() runs again) and is safe to run before the
# bridge accepts any new traffic.
_MIGRATION_MARKER = ".migrated-davi-to-main"
_LEGACY_AGENT_FIELDS = ("actor", "unit", "unitId", "unit_id", "agentId", "agent_id")


def _migrate_legacy_davi() -> None:
    global _store_path
    if _store_path is None:
        return
    marker_path = _store_path.parent / _MIGRATION_MARKER
    if marker_path.exists():
        return
    if not _store_path.exists():
        # Nothing to migrate, but write the marker so future boots are cheap.
        marker_path.touch()
        return
    try:
        rewritten = 0
        scanned = 0
        tmp = _store_path.with_suffix(_store_path.suffix + ".tmp")
        with _store_path.open("r", encoding="utf-8") as src, tmp.open("w", encoding="utf-8") as dst:
            for raw in src:
                scanned += 1
                line = raw.rstrip("\n")
                if not line:
                    dst.write("\n")
                    continue
                try:
                    evt = json.loads(line)
                except ValueError:
                    dst.write(raw)
                    continue
                if _rewrite_event_actor(evt):
                    rewritten += 1
                dst.write(json.dumps(evt, ensure_ascii=False) + "\n")
        os.replace(tmp, _store_path)
        marker_path.touch()
        if rewritten:
            # Best-effort: this message goes to stdout, the bridge logger may
            # or may not be wired yet at init() time.
            print(
                f"[event_store] migrated {rewritten}/{scanned} events: DAVI → MAIN",
                flush=True,
            )
    except Exception as exc:  # pragma: no cover — defensive
        # If migration fails, leave the file untouched and let the bridge
        # continue. The legacy "DAVI" name simply won't be routable anymore,
        # which is exactly what we want for a personal profile cleanup.
        print(f"[event_store] DAVI→MAIN migration skipped: {exc}", flush=True)


def _rewrite_event_actor(evt: dict[str, Any]) -> bool:
    """Return True if the event was rewritten."""
    changed = False
    actor = evt.get("actor")
    if actor == "DAVI":
        evt["actor"] = "MAIN"
        changed = True
    # Some events carry the unit identifier under different keys depending on
    # the producer (game UI, bridge, agent_runner). Normalize them all.
    for field in _LEGACY_AGENT_FIELDS[1:]:
        value = evt.get(field)
        if value == "DAVI":
            evt[field] = "MAIN"
            changed = True
    data = evt.get("data")
    if isinstance(data, dict):
        for field in _LEGACY_AGENT_FIELDS:
            value = data.get(field)
            if value == "DAVI":
                data[field] = "MAIN"
                changed = True
    return changed


def _append(event: dict[str, Any]) -> None:
    if _store_path is None:
        return
    line = json.dumps(event, ensure_ascii=False) + "\n"
    with _lock:
        with _store_path.open("a", encoding="utf-8") as f:
            f.write(line)


def _event(event_type: str, command_id: str, actor: str, data: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(uuid.uuid4())[:12],
        "commandId": command_id,
        "type": event_type,
        "timestamp": time.time(),
        "actor": actor,
        "data": data,
    }


# ─── Public API ───────────────────────────────────────────────────────────────

def record_created(command_id: str, actor: str, cmd_dict: dict[str, Any]) -> None:
    _append(_event("CommandCreated", command_id, actor, cmd_dict))


def record_queued(command_id: str) -> None:
    _append(_event("CommandQueued", command_id, "system", {}))


def record_waiting_approval(command_id: str) -> None:
    _append(_event("CommandWaitingApproval", command_id, "system", {}))


def record_approved(command_id: str, approver: str = "user") -> None:
    _append(_event("CommandApproved", command_id, approver, {}))


def record_rejected(command_id: str, reason: str = "") -> None:
    evt = _event("CommandRejected", command_id, "system", {"reason": reason})
    _append(evt)
    _ledger_ingest(evt)


def record_started(command_id: str) -> None:
    _append(_event("CommandStarted", command_id, "system", {"startedAt": time.time()}))


def record_output_chunk(command_id: str, actor: str, text: str) -> None:
    _append(_event("AgentOutputChunk", command_id, actor, {"text": text[:2048]}))


def record_completed(command_id: str, result: str = "") -> None:
    evt = _event("CommandCompleted", command_id, "system", {"result": result[:1024], "finishedAt": time.time()})
    _append(evt)
    _ledger_ingest(evt)


def record_failed(command_id: str, error: str = "") -> None:
    evt = _event("CommandFailed", command_id, "system", {"error": error[:1024], "finishedAt": time.time()})
    _append(evt)
    _ledger_ingest(evt)


def record_event(event_type: str, data: dict[str, Any]) -> None:
    """Record a free-form named event (e.g. 'HarnessRecoveryRequested')."""
    _append({
        "id": str(uuid.uuid4())[:12],
        "commandId": "",
        "type": event_type,
        "timestamp": time.time(),
        "actor": "system",
        "data": data,
    })


def record_subagent_spawn(subagent_id: str, run: dict[str, Any]) -> None:
    """Persist subagent spawn to JSONL (canonical, before DuckDB dual-write)."""
    record_event("SubagentSpawned", {"subagentId": subagent_id, **run})


def record_subagent_complete(subagent_id: str, run: dict[str, Any]) -> None:
    """Persist subagent completion to JSONL."""
    evt_data = {"subagentId": subagent_id, **run}
    record_event("SubagentCompleted", evt_data)
    _ledger_ingest({"type": "SubagentCompleted", "commandId": subagent_id, "data": evt_data})


def read_events(since: float = 0.0, limit: int = 500) -> list[dict[str, Any]]:
    """Return events newer than `since` (unix timestamp), up to `limit`."""
    if _store_path is None or not _store_path.exists():
        return []
    results: list[dict[str, Any]] = []
    with _lock:
        try:
            lines = _store_path.read_text(encoding="utf-8").splitlines()
        except Exception:
            return []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except Exception:
            continue
        if evt.get("timestamp", 0) >= since:
            results.append(evt)
    return results[-limit:]


def command_id(event: dict[str, Any]) -> str:
    """Return a command id from either current or legacy event shapes.

    The public event schema uses camelCase (`commandId`). A previous recovery
    path accidentally looked for `command_id`, which made restart recovery blind
    to already-terminal commands. Keeping this helper here prevents the two
    spellings from drifting again.
    """
    return str(event.get("commandId") or event.get("command_id") or "")
