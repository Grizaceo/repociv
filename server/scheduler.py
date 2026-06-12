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
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .command_schema import Command
from . import event_store as _es

# ─── Queue persistence (Fase 4) ──────────────────────────────────────────────
_CONFIG_DIR = Path(os.path.expanduser(os.environ.get("REPOCIV_CONFIG_DIR", "~/.repociv")))
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
        _QUEUE_FILE.write_text(json.dumps(queue, indent=2, ensure_ascii=False))


def _init_from_disk() -> None:
    """Pre-populate queue from persisted file at startup."""
    global _queue
    persisted = _load_queue()
    terminal = {"completed", "failed", "cancelled", "rejected"}
    filtered = [c for c in persisted if c.get("status") not in terminal]
    with _queue_lock:
        _queue = filtered
        _resort()
    n = len(filtered)
    if n:
        print(f"[scheduler] Recovered {n} queued mission(s) from disk.")

# ─── Concurrency limits per harness ────────────────────────────────────────
# Keyed by harness (looked up from the profile registry per unit). The
# shipped harnesses are the safe defaults; personal profiles inherit
# their harness's limit.
#
# Rationale: hermes/openclaw are stateful orchestrators → 1 each.
# Stateless harnesses (claude, codex, cursor) → 3 parallel.
AGENT_CONCURRENCY: dict[str, int] = {
    "hermes":   1,
    "claude":   3,
    "codex":    3,
    "cursor":   3,
    "openclaw": 1,
}

_DEFAULT_CONCURRENCY = 1


def _agent_base(unit_id: str) -> str:
    """Return the harness for a unit_id (lowercased).

    The profile registry maps the unit's name to a harness. Falls back
    to the unit_id prefix as a harness name when no profile is registered
    (backward-compat with the shipped baseline).
    """
    from . import config_store as _cs
    base = unit_id.split("-")[0].upper()
    profile = _cs.get_profile(base)
    if profile is not None and "harness" in profile:
        return profile["harness"].lower()
    return base.lower()


# ─── Priority weights — loaded from shared/priority-weights.json ─────────────
# TypeScript priorityMatrix.ts imports the same file → single source of truth.
_WEIGHTS_FILE = Path(__file__).parent.parent / "shared" / "priority-weights.json"
try:
    _WEIGHTS: dict[str, float] = json.loads(_WEIGHTS_FILE.read_text())
except (OSError, json.JSONDecodeError):
    # Fallback if file is missing or corrupt
    _WEIGHTS = {"age": 20, "test": 15, "debt": 25, "extension": 5, "fatigue": 15}
_EXT_SCORE = {"ts": 3, "tsx": 3, "js": 2, "jsx": 2, "py": 1, "rs": 1, "go": 1,
               "json": -1, "yaml": -1, "yml": -1, "md": -1, "css": -1}

# Fatigue provider — set by bridge.py so scheduler can query unit fatigue.
_fatigue_provider: Callable[[str], int | None] | None = None


def set_fatigue_provider(fn: Callable[[str], int | None]) -> None:
    """Register a function that returns fatigue (0-100) for a unit id, or None."""
    global _fatigue_provider
    _fatigue_provider = fn


def _priority_score(cmd: dict[str, Any], now: float) -> float:
    """Calculate task priority with age, debt, fatigue, and agent believability (Fase 2).
    
    Believability weighting (new in Fase 2):
      - Unreliable agents (believability < 0.5) get deprioritized
      - Multiplier: 0.5 + 0.5 * believability (range 0.5–1.0)
      - This ensures failing agents don't monopolize the queue
    """
    age_min = (now - cmd.get("created_at", now)) / 60.0
    target: str = cmd.get("target", "")
    score = _WEIGHTS["age"] * (1 + age_min / 10)  # linear growth
    if any(t in target for t in (".test.", ".spec.", "/test/", "/tests/")):
        score += _WEIGHTS["test"]
    if any(t in target for t in ("/debt/", "/legacy/", "/stale/")):
        score += _WEIGHTS["debt"]
    ext = target.rsplit(".", 1)[-1].lower() if "." in target else ""
    score += _WEIGHTS["extension"] * _EXT_SCORE.get(ext, 0)

    # ─── Phase 9: XCOM Context Fatigue ───────────────────────────────
    # Fatigued units get lower priority so rested units are dispatched first.
    if _fatigue_provider is not None:
        unit_id = cmd.get("payload", {}).get("unit", "")
        if unit_id:
            fatigue = _fatigue_provider(unit_id)
            if fatigue is not None:
                # fatigue 100 = fresh → multiplier 1.0
                # fatigue 0   = exhausted → multiplier ~0.0
                fatigue_ratio = max(0.0, min(1.0, fatigue / 100.0))
                score *= (0.3 + 0.7 * fatigue_ratio)  # floor at 0.3 so exhausted units still get served

    # ─── Fase 2: Agent Believability Weighting ──────────────────────
    # Query research ledger to adjust priority based on agent reliability
    try:
        from . import research_ledger as _rl
        ledger = _rl.get_instance()
        if ledger:
            agent_type = cmd.get("payload", {}).get("agent_type", "")
            if agent_type:
                agent_upper = agent_type.upper()
                believability_scores = ledger.get_agent_believability()
                believability = believability_scores.get(agent_upper, 1.0)
                # Multiplier ranges from 0.5 (unreliable) to 1.0 (reliable)
                believability_multiplier = 0.5 + 0.5 * believability
                score *= believability_multiplier
    except (ImportError, Exception):
        # If ledger unavailable, use default (no adjustment)
        pass

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
        _dump_queue(_queue)


def cancel(command_id: str) -> bool:
    """Remove a queued command. Returns True if found and removed."""
    with _queue_lock:
        before = len(_queue)
        _queue[:] = [c for c in _queue if c.get("id") != command_id]
        removed = len(_queue) < before
    if removed:
        _es.record_failed(command_id, "cancelled by user")
        _dump_queue(_queue)
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
    cmd_to_run: dict[str, Any] | None = None
    base_to_run: str = ""
    with _queue_lock:
        _resort()
        for i, cmd in enumerate(_queue):
            unit = cmd.get("payload", {}).get("unit") or "MAIN"
            base = _agent_base(unit)
            if _acquire_slot(base):
                cmd_to_run = dict(_queue.pop(i))  # explicit copy — safe across threads
                base_to_run = base
                _dump_queue(_queue)
                break
        else:
            return False

    def _run() -> None:
        heartbeat(base_to_run)
        _es.record_started(cmd_to_run.get("id", ""))
        try:
            if _dispatcher:
                _dispatcher(cmd_to_run)
        finally:
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
            print(f"[scheduler] error: {e}")
        time.sleep(2)
