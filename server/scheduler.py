"""RepoCiv — Mission Scheduler (Sprint B / Fase 4).

Priority-based queue with:
  - One active mission per agent (configurable concurrency per type)
  - Priority score from priorityMatrix logic (age + type + debt)
  - Cancel queued commands (running commands log but can't be interrupted)
  - Heartbeat tracking per agent
  - Worker loop dispatches when slots are free
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable

from .command_schema import Command, CommandStatus
from . import event_store as _es

# ─── Concurrency limits per agent type ────────────────────────────────────────
# WORKER can run multiple parallel tasks; others are single-threaded.
AGENT_CONCURRENCY: dict[str, int] = {
    "DAVI":     1,
    "LEXO":     1,
    "SCOUT":    1,
    "OPENCLAW": 1,
    "WORKER":   3,   # batch workers can run in parallel
}

_DEFAULT_CONCURRENCY = 1


def _agent_base(unit_id: str) -> str:
    return unit_id.split("-")[0].upper()


# ─── Priority scoring (mirrors priorityMatrix.ts) ────────────────────────────
_WEIGHTS = {"age": 20, "test": 15, "debt": 25, "extension": 5}
_EXT_SCORE = {"ts": 3, "tsx": 3, "js": 2, "jsx": 2, "py": 1, "rs": 1, "go": 1,
               "json": -1, "yaml": -1, "yml": -1, "md": -1, "css": -1}


def _priority_score(cmd: dict[str, Any], now: float) -> float:
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


def enqueue(cmd: Command) -> None:
    """Add a command to the priority queue."""
    with _queue_lock:
        _queue.append(cmd.to_dict())
        _resort()


def cancel(command_id: str) -> bool:
    """Remove a queued command. Returns True if found and removed."""
    with _queue_lock:
        before = len(_queue)
        _queue[:] = [c for c in _queue if c.get("id") != command_id]
        removed = len(_queue) < before
    if removed:
        _es.record_failed(command_id, "cancelled by user")
    return removed


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
    """Pick highest-priority queued command that has a free agent slot. Returns True if dispatched."""
    now = time.time()
    with _queue_lock:
        _resort()
        for i, cmd in enumerate(_queue):
            unit = cmd.get("payload", {}).get("unit", "DAVI")
            base = _agent_base(unit)
            if _acquire_slot(base):
                _queue.pop(i)
                break
        else:
            return False  # nothing dispatched

    # Run in a thread so we don't block the worker loop
    def _run() -> None:
        heartbeat(base)
        _es.record_started(cmd.get("id", ""))
        try:
            if _dispatcher:
                _dispatcher(cmd)
        finally:
            _release_slot(base)
            heartbeat(base)

    threading.Thread(target=_run, daemon=True).start()
    return True


# ─── Worker loop ─────────────────────────────────────────────────────────────
def start_worker() -> None:
    """Start the background scheduler loop. Call once at bridge startup."""
    global _worker_running
    if _worker_running:
        return
    _worker_running = True
    threading.Thread(target=_worker_loop, daemon=True).start()


def _worker_loop() -> None:
    while True:
        try:
            dispatched = True
            while dispatched:
                dispatched = _dispatch_next()
        except Exception as e:
            print(f"[scheduler] error: {e}")
        time.sleep(2)
