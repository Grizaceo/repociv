"""RepoCiv — JSONL Event Store.

Appends every Command lifecycle event to a single JSONL file.
One JSON object per line. File survives bridge restart so sessions are replayable.

Event types persisted:
  CommandCreated, CommandQueued, CommandStarted,
  AgentOutputChunk, CommandCompleted, CommandFailed, CommandRejected
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any


_logger = logging.getLogger(__name__)
_lock = threading.Lock()
_store_path: Path | None = None
_REVERSE_CHUNK = 8192
_command_contexts: dict[str, dict[str, Any]] = {}

# ── Dual-write to DuckDB Ledger (best-effort) ─────────────────────────────────
# Imported lazily to avoid circular imports and to allow the ledger to be
# disabled gracefully when duckdb is not installed.
def _ledger_ingest(event: dict[str, Any]) -> None:
    """Forward a terminal event to the ResearchLedger (best-effort).

    Never raises. If DuckDB is unavailable the event is logged and skipped.
    The JSONL write already succeeded at this point.
    """
    try:
        from server import research_ledger as _rl  # noqa: PLC0415
        _rl.get_ledger().ingest_event(event)
    except Exception:
        _logger.warning(
            "ledger ingest failed for %s event",
            event.get("type"),
            exc_info=True,
        )


def init(store_dir: Path) -> None:
    global _store_path
    store_dir.mkdir(parents=True, exist_ok=True)
    _store_path = store_dir / "events.jsonl"
    _command_contexts.clear()
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
        "schemaVersion": 1,
        "id": str(uuid.uuid4())[:12],
        "commandId": command_id,
        "type": event_type,
        "timestamp": time.time(),
        "actor": actor,
        "data": data,
    }


# ─── Public API ───────────────────────────────────────────────────────────────

def _context_from_command(cmd_dict: dict[str, Any]) -> dict[str, Any]:
    raw_payload = cmd_dict.get("payload")
    payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else {}
    return {
        "commandType": str(cmd_dict.get("type") or ""),
        "target": str(cmd_dict.get("target") or ""),
        "repoPath": str(payload.get("repoPath") or payload.get("cwd") or ""),
        "unitId": str(payload.get("unit") or "MAIN"),
        "model": str(payload.get("model") or ""),
        "startedAt": 0.0,
    }


def _load_command_context(command_id: str) -> dict[str, Any]:
    cached = _command_contexts.get(command_id)
    if cached is not None:
        return dict(cached)
    context: dict[str, Any] = {}
    for event in read_command_events(command_id):
        if event.get("type") == "CommandCreated":
            context.update(_context_from_command(event.get("data") or {}))
        elif event.get("type") == "CommandStarted":
            context["startedAt"] = float((event.get("data") or {}).get("startedAt") or 0.0)
    if context:
        _command_contexts[command_id] = dict(context)
    return context


def _terminal_event(
    command_id: str,
    event_type: str,
    *,
    result: str = "",
    error: str = "",
    reason: str = "",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    context = _load_command_context(command_id)
    extra = dict(metadata or {})
    finished_at = float(extra.pop("finishedAt", 0.0) or time.time())
    started_at = float(extra.pop("startedAt", 0.0) or context.get("startedAt") or finished_at)
    duration_s = float(extra.pop("durationS", 0.0) or max(0.0, finished_at - started_at))
    outcome_by_type = {
        "CommandCompleted": ("completed", "success"),
        "CommandFailed": ("failed", "failed"),
        "CommandRejected": ("rejected", "rejected"),
    }
    status, outcome = outcome_by_type[event_type]
    artifact_refs = extra.pop("artifactRefs", [])
    data = {
        "status": status,
        "outcome": outcome,
        "commandType": str(extra.pop("commandType", "") or context.get("commandType") or ""),
        "target": str(extra.pop("target", "") or context.get("target") or ""),
        "repoPath": str(extra.pop("repoPath", "") or context.get("repoPath") or ""),
        "unitId": str(extra.pop("unitId", "") or context.get("unitId") or "MAIN"),
        "model": str(extra.pop("model", "") or context.get("model") or ""),
        "startedAt": started_at,
        "finishedAt": finished_at,
        "durationS": duration_s,
        "result": result[:1024],
        "error": error[:1024],
        "reason": reason[:1024],
        "artifactRefs": artifact_refs if isinstance(artifact_refs, list) else [],
        **extra,
    }
    return _event(event_type, command_id, data["unitId"], data)


def record_created(command_id: str, actor: str, cmd_dict: dict[str, Any]) -> None:
    _command_contexts[command_id] = _context_from_command(cmd_dict)
    _append(_event("CommandCreated", command_id, actor, cmd_dict))


def record_queued(command_id: str) -> None:
    _append(_event("CommandQueued", command_id, "system", {}))


def record_waiting_approval(command_id: str) -> None:
    _append(_event("CommandWaitingApproval", command_id, "system", {}))


def record_approved(command_id: str, approver: str = "user") -> None:
    _append(_event("CommandApproved", command_id, approver, {}))


def record_rejected(
    command_id: str, reason: str = "", metadata: dict[str, Any] | None = None
) -> None:
    evt = _terminal_event(
        command_id, "CommandRejected", reason=reason, metadata=metadata
    )
    _append(evt)
    _ledger_ingest(evt)


def record_started(command_id: str) -> None:
    started_at = time.time()
    context = _load_command_context(command_id)
    context["startedAt"] = started_at
    _command_contexts[command_id] = context
    _append(_event("CommandStarted", command_id, "system", {"startedAt": started_at}))


def record_output_chunk(command_id: str, actor: str, text: str) -> None:
    _append(_event("AgentOutputChunk", command_id, actor, {"text": text[:2048]}))


def record_completed(
    command_id: str, result: str = "", metadata: dict[str, Any] | None = None
) -> None:
    evt = _terminal_event(
        command_id, "CommandCompleted", result=result, metadata=metadata
    )
    _append(evt)
    _ledger_ingest(evt)


def record_failed(
    command_id: str, error: str = "", metadata: dict[str, Any] | None = None
) -> None:
    evt = _terminal_event(command_id, "CommandFailed", error=error, metadata=metadata)
    _append(evt)
    _ledger_ingest(evt)


def record_event(event_type: str, data: dict[str, Any]) -> None:
    """Record a free-form named event (e.g. 'HarnessRecoveryRequested')."""
    _append({
        "schemaVersion": 1,
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


def _iter_lines_reverse(path: Path) -> Iterator[str]:
    """Yield non-empty JSONL lines from newest to oldest."""
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        position = stream.tell()
        buffer = b""
        while position > 0:
            read_size = min(_REVERSE_CHUNK, position)
            position -= read_size
            stream.seek(position)
            buffer = stream.read(read_size) + buffer
            parts = buffer.split(b"\n")
            buffer = parts[0]
            for raw_line in reversed(parts[1:]):
                text = raw_line.decode("utf-8").strip()
                if text:
                    yield text
        text = buffer.decode("utf-8").strip()
        if text:
            yield text


def read_events(since: float = 0.0, limit: int = 500) -> list[dict[str, Any]]:
    """Return events newer than `since` (unix timestamp), up to `limit`.

    Reads from the tail of the JSONL file backwards so callers with a recent
    ``since`` filter do not load the entire audit log into memory.
    """
    if _store_path is None or not _store_path.exists():
        return []
    if limit <= 0:
        return []
    collected: list[dict[str, Any]] = []
    with _lock:
        try:
            for line in _iter_lines_reverse(_store_path):
                try:
                    evt = json.loads(line)
                except Exception:
                    continue
                ts = evt.get("timestamp", 0)
                if ts < since:
                    break
                collected.append(evt)
                if len(collected) >= limit:
                    break
        except Exception:
            return []
    collected.reverse()
    return collected


def read_command_events(command_id: str) -> list[dict[str, Any]]:
    if _store_path is None or not _store_path.exists() or not command_id:
        return []
    collected: list[dict[str, Any]] = []
    with _lock:
        try:
            for line in _iter_lines_reverse(_store_path):
                try:
                    event = json.loads(line)
                except Exception:
                    continue
                if command_id == str(event.get("commandId") or event.get("command_id") or ""):
                    collected.append(event)
                    if event.get("type") == "CommandCreated":
                        break
        except Exception:
            return []
    collected.reverse()
    return collected


def command_evidence(command_id: str) -> dict[str, Any] | None:
    events = read_command_events(command_id)
    if not events:
        return None
    terminal_types = {"CommandCompleted", "CommandFailed", "CommandRejected"}
    terminal = next((event for event in reversed(events) if event.get("type") in terminal_types), None)
    created = next((event for event in events if event.get("type") == "CommandCreated"), None)
    terminal_data = terminal.get("data") if isinstance(terminal, dict) else {}
    if not isinstance(terminal_data, dict):
        terminal_data = {}
    artifact_refs = terminal_data.get("artifactRefs")
    return {
        "schemaVersion": 1,
        "commandId": command_id,
        "createdEvent": created,
        "terminalEvent": terminal,
        "artifactRefs": artifact_refs if isinstance(artifact_refs, list) else [],
        "events": events,
    }


def command_id(event: dict[str, Any]) -> str:
    """Return a command id from either current or legacy event shapes.

    The public event schema uses camelCase (`commandId`). A previous recovery
    path accidentally looked for `command_id`, which made restart recovery blind
    to already-terminal commands. Keeping this helper here prevents the two
    spellings from drifting again.
    """
    return str(event.get("commandId") or event.get("command_id") or "")
