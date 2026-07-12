"""RepoCiv — Mission Scheduler (Sprint B / Fase 4).

Priority-based queue with:
  - One active mission per agent (configurable concurrency per type)
  - Priority score from priorityMatrix logic (age + type + debt)
  - Cancel queued commands (running commands log but can't be interrupted)
  - Heartbeat tracking per agent
  - Worker loop dispatches when slots are free
  - Persistent queue survives bridge restart (Fase 4)
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable
from dataclasses import asdict

from .command_schema import Command
from . import event_store as _es

logger = logging.getLogger(__name__)

# ─── Queue persistence (Fase 4) ──────────────────────────────────────────────
_STATE_ROOT = (
    os.environ.get("REPOCIV_STATE_DIR")
    or os.environ.get("REPOCIV_DATA_DIR")
    or os.environ.get("REPOCIV_CONFIG_DIR")
    or "~/.repociv"
)
_CONFIG_DIR = Path(os.path.expanduser(_STATE_ROOT))
_CONFIG_DIR.mkdir(exist_ok=True, parents=True)
_QUEUE_FILE = _CONFIG_DIR / "scheduler-queue.json"
_queue_file_lock = threading.Lock()


def _load_queue() -> list[dict[str, Any]]:
    """Load persisted queue from disk. Returns empty list if file missing."""
    if not _QUEUE_FILE.exists():
        return []
    try:
        data = json.loads(_QUEUE_FILE.read_text())
        if isinstance(data, list):
            return data
        return []
    except Exception:
        return []


def _dump_queue(queue: list[dict[str, Any]]) -> None:
    """Atomically write queue state to disk."""
    with _queue_file_lock:
        _QUEUE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = _QUEUE_FILE.with_suffix(_QUEUE_FILE.suffix + ".tmp")
        tmp.write_text(json.dumps(queue, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, _QUEUE_FILE)


def _init_from_disk() -> None:
    """Pre-populate queue from persisted file at startup."""
    global _queue
    persisted = _load_queue()
    terminal = {"completed", "failed", "cancelled", "rejected"}
    filtered = [dict(command) for command in persisted if command.get("status") not in terminal]
    for command in filtered:
        if command.get("status") in {"running", "dispatching"}:
            command["status"] = "queued"
            command.pop("started_at", None)
    with _queue_lock:
        _queue = filtered
        _resort()
        if filtered != persisted:
            _dump_queue(_queue)
    n = len(filtered)
    if n:
        logger.info(f"[scheduler] Recovered {n} queued mission(s) from disk.")

# ─── Concurrency limits per agent type ────────────────────────────────────────
# WORKER can run multiple parallel tasks; others are single-threaded.
AGENT_CONCURRENCY: dict[str, int] = {
    "MAIN":     1,
    "SCOUT":    2,   # read-only: safe to run 2 parallel scans (matches agent card)
    "OPENCLAW": 1,
    "WORKER":   3,   # stateless executor: safe to batch in parallel
}

_DEFAULT_CONCURRENCY = 1


def _agent_base(unit_id: str) -> str:
    return unit_id.split("-")[0].upper()


# ─── Priority weights — loaded from shared/priority-weights.json ─────────────
# TypeScript priorityMatrix.ts imports the same file → single source of truth.
_WEIGHTS_FILE = Path(__file__).parent.parent / "shared" / "priority-weights.json"
try:
    _WEIGHTS: dict[str, float] = json.loads(_WEIGHTS_FILE.read_text())
except (OSError, json.JSONDecodeError):
    # Fallback if file is missing or corrupt
    _WEIGHTS = {"age": 20, "test": 15, "debt": 25, "extension": 5}
_EXT_SCORE = {"ts": 3, "tsx": 3, "js": 2, "jsx": 2, "py": 1, "rs": 1, "go": 1,
               "json": -1, "yaml": -1, "yml": -1, "md": -1, "css": -1}

def _priority_score(cmd: dict[str, Any], now: float) -> float:
    """Calculate task priority with age, debt, and extension weights."""
    age_min = (now - cmd.get("created_at", now)) / 60.0
    target: str = cmd.get("target", "")
    score = _WEIGHTS["age"] * (1 + age_min / 10)  # linear growth
    if any(t in target for t in (".test.", ".spec.", "/test/", "/tests/")):
        score += _WEIGHTS["test"]
    if any(t in target for t in ("/debt/", "/legacy/", "/stale/")):
        score += _WEIGHTS["debt"]
    ext = target.rsplit(".", 1)[-1].lower() if "." in target else ""
    score += _WEIGHTS["extension"] * _EXT_SCORE.get(ext, 0)

    return round(score, 2)


# ─── Scheduler state ──────────────────────────────────────────────────────────
_queue_lock = threading.Lock()
_queue: list[dict[str, Any]] = []           # list of command dicts, sorted by score desc
_leases: dict[str, int] = {}                # agent_base → active_task_count
_lease_lock = threading.Lock()

_heartbeat: dict[str, float] = {}          # agent_id → last_activity timestamp
_heartbeat_lock = threading.Lock()

_dispatcher: Callable[[dict[str, Any]], None] | None = None
_worker_running = False


def set_dispatcher(fn: Callable[[dict[str, Any]], None]) -> None:
    """Register the function that actually runs a command dict."""
    global _dispatcher
    _dispatcher = fn


def enqueue(cmd: Command) -> bool:
    """Durably add a command once. Return True only for a new queue item."""
    with _queue_lock:
        if any(item.get("id") == cmd.id for item in _queue):
            return False
        candidate = [*_queue, asdict(cmd)]
        candidate[-1]["status"] = "queued"
        candidate.sort(key=lambda item: _priority_score(item, time.time()), reverse=True)
        _dump_queue(candidate)
        _queue[:] = candidate
    return True


def cancel(command_id: str) -> bool:
    """Transactionally remove a queued command. Running commands are not cancelled."""
    with _queue_lock:
        candidate = [
            item
            for item in _queue
            if not (item.get("id") == command_id and item.get("status", "queued") == "queued")
        ]
        removed = len(candidate) < len(_queue)
        if not removed:
            return False
        _dump_queue(candidate)
        _queue[:] = candidate
    _es.record_failed(command_id, "cancelled by user")
    return True


def queue_snapshot() -> list[dict[str, Any]]:
    """Return sorted queue snapshot (safe copy)."""
    with _queue_lock:
        return list(_queue)


def heartbeat(agent_id: str) -> None:
    """Called by executor to record agent activity."""
    with _heartbeat_lock:
        _heartbeat[agent_id] = time.time()


def get_agent_status() -> list[dict[str, Any]]:
    """Return current status of all known agents.

    Heartbeats are recorded with concrete unit ids (e.g. DAVI-2), while leases
    are tracked by base agent (DAVI). Aggregate heartbeats by base so cloned
    units do not appear as `never_seen`.
    """
    now = time.time()
    with _heartbeat_lock:
        hb_raw = dict(_heartbeat)
    with _lease_lock:
        leases = dict(_leases)

    hb_by_base: dict[str, float] = {}
    for agent_id, ts in hb_raw.items():
        base = _agent_base(agent_id)
        hb_by_base[base] = max(hb_by_base.get(base, 0.0), ts)

    known_bases = set(leases.keys()) | set(hb_by_base.keys())
    result = []
    for base in sorted(known_bases):
        last_ts = hb_by_base.get(base)
        active = leases.get(base, 0)
        if last_ts is None:
            status = "never_seen"
        elif now - last_ts < 30:
            status = "working" if active > 0 else "idle"
        elif now - last_ts < 120:
            status = "idle"
        else:
            status = "offline"
        result.append({
            "id": base,
            "status": status,
            "activeTasks": active,
            "lastSeen": last_ts,
            "lastSeenAgo": round(now - last_ts) if last_ts else None,
        })
    return result


def _resort() -> None:
    """Sort queue by score descending. Must be called under _queue_lock."""
    now = time.time()
    _queue.sort(key=lambda c: _priority_score(c, now), reverse=True)


def _acquire_slot(agent_base: str) -> bool:
    """Return True if we can dispatch another task for this agent."""
    limit = AGENT_CONCURRENCY.get(agent_base, _DEFAULT_CONCURRENCY)
    with _lease_lock:
        current = _leases.get(agent_base, 0)
        if current >= limit:
            return False
        _leases[agent_base] = current + 1
        return True


def _release_slot(agent_base: str) -> None:
    with _lease_lock:
        _leases[agent_base] = max(0, _leases.get(agent_base, 1) - 1)


def _dispatch_next() -> bool:
    """Durably mark the highest-priority queued command running, then dispatch it."""
    cmd_to_run: dict[str, Any] | None = None
    base_to_run = ""
    command_id = ""
    with _queue_lock:
        _resort()
        for index, command in enumerate(_queue):
            if command.get("status", "queued") != "queued":
                continue
            unit = command.get("payload", {}).get("unit", "MAIN")
            base = _agent_base(unit)
            if not _acquire_slot(base):
                continue
            candidate = [dict(item) for item in _queue]
            candidate[index]["status"] = "running"
            candidate[index]["started_at"] = time.time()
            try:
                _dump_queue(candidate)
            except Exception:
                _release_slot(base)
                raise
            _queue[:] = candidate
            cmd_to_run = dict(candidate[index])
            base_to_run = base
            command_id = str(cmd_to_run.get("id") or "")
            break
        else:
            return False

    def _run() -> None:
        heartbeat(base_to_run)
        _es.record_started(command_id)
        try:
            if _dispatcher is None:
                raise RuntimeError("scheduler dispatcher is not configured")
            _dispatcher(cmd_to_run)
        except Exception as exc:
            logger.exception("[scheduler] dispatch failed for %s", command_id)
            _es.record_failed(command_id, str(exc))
        finally:
            with _queue_lock:
                candidate = [item for item in _queue if item.get("id") != command_id]
                try:
                    _dump_queue(candidate)
                except Exception:
                    logger.exception(
                        "[scheduler] could not persist completion removal for %s; "
                        "running item remains recoverable",
                        command_id,
                    )
                else:
                    _queue[:] = candidate
            _release_slot(base_to_run)
            heartbeat(base_to_run)

    threading.Thread(target=_run, daemon=True).start()
    return True


# ─── Worker loop ─────────────────────────────────────────────────────────────
def start_worker() -> None:
    """Start the background scheduler loop. Call once at bridge startup."""
    global _worker_running
    if _worker_running:
        return
    _init_from_disk()
    _worker_running = True
    threading.Thread(target=_worker_loop, daemon=True).start()


def _worker_loop() -> None:
    while True:
        try:
            dispatched = True
            while dispatched:
                dispatched = _dispatch_next()
        except Exception as e:
            logger.error(f"[scheduler] error: {e}")
        time.sleep(2)
