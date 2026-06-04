"""RepoCiv — Observability Metrics (Fase 7).

Computes health metrics from the event store and scheduler state.
Called by GET /metrics in bridge.py — no side effects.
"""
from __future__ import annotations

import collections
import os
import threading
import time
from typing import Any


# ─── Duration computation ─────────────────────────────────────────────────────

def _event_command_id(ev: dict[str, Any]) -> str:
    """Return command id from current or legacy/nested event shapes."""
    data = ev.get("data", {}) if isinstance(ev.get("data", {}), dict) else {}
    return str(ev.get("commandId") or ev.get("command_id") or data.get("id") or "")


def _smoke_command_ids(events: list[dict[str, Any]]) -> set[str]:
    """Return command ids created by synthetic smoke tests.

    Smoke checks must validate the bridge without poisoning operational health.
    Older smoke scripts enqueued real `inspect_repo` commands against target
    `smoke-test`; filter those out of metrics retroactively.
    """
    ids: set[str] = set()
    for ev in events:
        if ev.get("type") != "CommandCreated":
            continue
        data = ev.get("data", {})
        payload = data.get("payload", {}) if isinstance(data.get("payload", {}), dict) else {}
        if data.get("target") == "smoke-test" or payload.get("smoke") is True:
            cid = _event_command_id(ev)
            if cid:
                ids.add(cid)
    return ids


def _compute_durations(events: list[dict[str, Any]]) -> list[float]:
    """Return list of completed-command durations in seconds (last 200 events)."""
    started: dict[str, float] = {}
    durations: list[float] = []
    for ev in events[-200:]:
        etype = ev.get("type", "")
        cid = ev.get("commandId", "")
        data = ev.get("data", {})
        if etype == "CommandStarted":
            started[cid] = data.get("startedAt", ev.get("timestamp", 0.0))
        elif etype == "CommandCompleted" and cid in started:
            finished = data.get("finishedAt", ev.get("timestamp", 0.0))
            dur = finished - started.pop(cid)
            if 0 < dur < 3600:
                durations.append(dur)
    return durations


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    sorted_v = sorted(values)
    idx = int(len(sorted_v) * pct / 100)
    return round(sorted_v[min(idx, len(sorted_v) - 1)], 1)


# ─── Error rate ───────────────────────────────────────────────────────────────

def _compute_error_rate(events: list[dict[str, Any]], window: int = 50) -> float:
    smoke_ids = _smoke_command_ids(events)
    terminal = [
        e for e in events[-window:]
        if e.get("type") in ("CommandCompleted", "CommandFailed", "CommandRejected")
        and _event_command_id(e) not in smoke_ids
    ]
    if not terminal:
        return 0.0
    failures = sum(1 for e in terminal if e.get("type") in ("CommandFailed", "CommandRejected"))
    return round(failures / len(terminal), 3)


# ─── Tool calls per agent ─────────────────────────────────────────────────────

def _tool_calls_per_agent(events: list[dict[str, Any]]) -> dict[str, int]:
    smoke_ids = _smoke_command_ids(events)
    counts: dict[str, int] = {}
    for ev in events:
        if ev.get("type") == "CommandCreated":
            if _event_command_id(ev) in smoke_ids:
                continue
            data = ev.get("data", {})
            unit = str(data.get("unit", data.get("created_by", "unknown")))
            base = unit.split("-")[0].upper()
            counts[base] = counts.get(base, 0) + 1
    return counts


# ─── Recent failures ──────────────────────────────────────────────────────────

def _recent_failures(events: list[dict[str, Any]], n: int = 8) -> list[dict[str, Any]]:
    smoke_ids = _smoke_command_ids(events)
    failures = [
        e for e in events
        if e.get("type") == "CommandFailed"
        and _event_command_id(e) not in smoke_ids
    ]
    result = []
    for ev in failures[-n:]:
        data = ev.get("data", {})
        result.append({
            "commandId": ev.get("commandId", ""),
            "error": str(data.get("error", ""))[:120],
            "ts": ev.get("timestamp", 0.0),
            "age": round(time.time() - ev.get("timestamp", time.time())),
        })
    return list(reversed(result))  # newest first


# ─── Model usage ──────────────────────────────────────────────────────────────

def _compute_model_usage(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Aggregate model usage from CommandCompleted events.

    Observability should answer "how much did we spend/use?", not just show the
    latest sample per model. Keep insertion order by first occurrence so output
    remains stable for the frontend and tests.
    """
    usage_by_model: dict[str, dict[str, Any]] = {}
    for ev in events:
        if ev.get("type") != "CommandCompleted":
            continue
        data = ev.get("data", {})
        model = str(data.get("model", ""))
        if not model:
            continue
        bucket = usage_by_model.setdefault(
            model,
            {"model": model, "tokensIn": 0, "tokensOut": 0, "costEstimate": 0.0, "calls": 0},
        )
        bucket["tokensIn"] += int(data.get("tokensIn") or 0)
        bucket["tokensOut"] += int(data.get("tokensOut") or 0)
        bucket["costEstimate"] += float(data.get("costEstimate") or 0.0)
        bucket["costEstimate"] = round(bucket["costEstimate"], 6)
        bucket["calls"] += 1
    return list(usage_by_model.values())


# ─── Health score ─────────────────────────────────────────────────────────────

def _health(error_rate: float, queue_depth: int, disk_used_pct: float) -> str:
    if error_rate > 0.30 or queue_depth > 20:
        return "critical"
    if error_rate > 0.10 or queue_depth > 8 or disk_used_pct > 90:
        return "degraded"
    return "ok"


# ─── System resources ─────────────────────────────────────────────────────────

# ─── Step latency storage ─────────────────────────────────────────────────────
# In-memory circular buffer of the last 1000 step latency measurements.
# Not persisted across restarts — monitoring only.

_MAX_LATENCY_SAMPLES = 1000

_latency_lock = threading.Lock()
# deque acts as circular buffer when maxlen is set
_latency_samples: collections.deque[dict[str, Any]] = collections.deque(
    maxlen=_MAX_LATENCY_SAMPLES
)


def record_step_latency(
    repo: str,
    issue_id: str,
    step_idx: int,
    agent: str,
    duration_s: float,
) -> None:
    """Record the latency of a single orchestrator step.

    Thread-safe. Oldest entry is automatically evicted when the buffer is full.

    Args:
        repo:       Repository name.
        issue_id:   Issue identifier.
        step_idx:   Zero-based step index within the plan.
        agent:      Agent type that executed the step (e.g. "DAVI", "WORKER").
        duration_s: Wall-clock duration in seconds.
    """
    entry: dict[str, Any] = {
        "repo": repo,
        "issue_id": issue_id,
        "step_idx": step_idx,
        "agent": agent.upper() if agent else "UNKNOWN",
        "duration_s": float(duration_s),
        "ts": time.time(),
    }
    with _latency_lock:
        _latency_samples.append(entry)


def _percentile_from_list(values: list[float], pct: float) -> float:
    """Return pct-th percentile from a sorted list (0-100 scale)."""
    if not values:
        return 0.0
    sorted_v = sorted(values)
    idx = max(0, int(len(sorted_v) * pct / 100) - 1)
    return round(sorted_v[min(idx, len(sorted_v) - 1)], 3)


def get_step_latency_stats() -> dict[str, Any]:
    """Return aggregate latency statistics over all recorded step samples.

    Returns:
        {
          "p50": float,   — 50th-percentile duration in seconds
          "p95": float,   — 95th-percentile duration in seconds
          "p99": float,   — 99th-percentile duration in seconds
          "count": int,   — total number of samples
          "by_agent": {
              "DAVI":   {"p50": float, "p95": float, "p99": float, "count": int},
              "WORKER": {...},
              ...
          }
        }
    """
    with _latency_lock:
        samples = list(_latency_samples)

    all_durations = [s["duration_s"] for s in samples]

    by_agent: dict[str, list[float]] = {}
    for s in samples:
        by_agent.setdefault(s["agent"], []).append(s["duration_s"])

    agent_stats = {
        agent: {
            "p50": _percentile_from_list(durations, 50),
            "p95": _percentile_from_list(durations, 95),
            "p99": _percentile_from_list(durations, 99),
            "count": len(durations),
        }
        for agent, durations in by_agent.items()
    }

    return {
        "p50": _percentile_from_list(all_durations, 50),
        "p95": _percentile_from_list(all_durations, 95),
        "p99": _percentile_from_list(all_durations, 99),
        "count": len(all_durations),
        "by_agent": agent_stats,
    }


# ─── Hook result tracking ─────────────────────────────────────────────────────

_hook_lock = threading.Lock()
# by_hook[hook_name] = {"total": int, "failures": int}
_hook_stats: dict[str, dict[str, int]] = {}


def record_hook_result(hook_name: str, repo: str, returncode: int, duration_s: float) -> None:
    """Record the result of a hook execution.

    Thread-safe. Aggregates totals and failure counts per hook name.

    Args:
        hook_name:   Hook identifier (e.g. "pre_step", "post_step", "on_circuit_open").
        repo:        Repository name (currently used for future per-repo breakdown).
        returncode:  Process return code (0 = success, non-zero = failure).
        duration_s:  Wall-clock duration in seconds (reserved for future use).
    """
    with _hook_lock:
        bucket = _hook_stats.setdefault(hook_name, {"total": 0, "failures": 0})
        bucket["total"] += 1
        if returncode != 0:
            bucket["failures"] += 1


def get_hook_stats() -> dict[str, Any]:
    """Return aggregate hook execution statistics.

    Returns:
        {
          "total":   int,   — total hook executions across all hook types
          "failures": int,  — total hook failures across all hook types
          "by_hook": {
              "pre_step":        {"total": int, "failures": int},
              "post_step":       {"total": int, "failures": int},
              "on_circuit_open": {"total": int, "failures": int},
              ...
          }
        }
    """
    with _hook_lock:
        by_hook = {name: dict(counts) for name, counts in _hook_stats.items()}

    total = sum(v["total"] for v in by_hook.values())
    failures = sum(v["failures"] for v in by_hook.values())
    return {"total": total, "failures": failures, "by_hook": by_hook}


def get_sys_info() -> dict[str, Any]:
    info: dict[str, Any] = {
        "loadAvg1": None,
        "memUsedGb": None,
        "memTotalGb": None,
        "diskUsedPct": None,
    }
    try:
        load = os.getloadavg()
        info["loadAvg1"] = round(load[0], 2)
    except (AttributeError, OSError):
        pass

    try:
        mem: dict[str, int] = {}
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    mem[parts[0].rstrip(":")] = int(parts[1])
        total_kb = mem.get("MemTotal", 0)
        avail_kb = mem.get("MemAvailable", 0)
        used_kb = total_kb - avail_kb
        info["memTotalGb"] = round(total_kb / 1_048_576, 1)
        info["memUsedGb"] = round(used_kb / 1_048_576, 1)
    except Exception:
        pass

    try:
        st = os.statvfs("/")
        total = st.f_blocks * st.f_frsize
        free = st.f_bfree * st.f_frsize
        used = total - free
        info["diskUsedPct"] = round(used / total * 100, 1) if total else None
    except Exception:
        pass

    return info


# ─── Token budget endpoint (Fase 0) ──────────────────────────────────────────

def get_token_budget(limit: int = 0) -> dict[str, Any]:
    """Return current token usage from the TokenLedger.

    Args:
        limit: Optional hard budget cap (total tokens). Pass 0 to skip pct calc.

    Returns::

        {
          "total_prompt_tokens":     int,
          "total_completion_tokens": int,
          "total_tokens":            int,
          "total_cost_estimate":     float,
          "budget_limit":            int | None,
          "budget_used_pct":         float | None,   # 0.0–100.0
          "budget_violated":         bool | None,
        }
    """
    from server import token_ledger as _tl  # local import to avoid circular deps

    ledger = _tl.get_ledger()
    summary = ledger.get_summary()

    if limit > 0:
        summary["budget_limit"] = limit
        summary["budget_used_pct"] = round(ledger.get_budget_used_pct(limit), 2)
        summary["budget_violated"] = ledger.check_budget_violation(limit)
    else:
        summary["budget_limit"] = None
        summary["budget_used_pct"] = None
        summary["budget_violated"] = None

    return summary


# ─── Main entry point ─────────────────────────────────────────────────────────

def compute_metrics(
    events: list[dict[str, Any]],
    agent_status: list[dict[str, Any]],
    queue_depth: int,
    gpu_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    durations = _compute_durations(events)
    error_rate = _compute_error_rate(events)
    sys_info = get_sys_info()
    smoke_ids = _smoke_command_ids(events)

    # Map scheduler agent_status {id, status, activeTasks} → frontend {id, state, activeTask}
    mapped_agents = []
    for a in agent_status:
        mapped_agents.append({
            "id": a.get("id", ""),
            "state": a.get("status", a.get("state", "offline")),
            "activeTask": a.get("activeTasks", a.get("activeTask", None)),
            "lastSeenAgo": a.get("lastSeenAgo"),
        })

    return {
        "health":             _health(error_rate, queue_depth, sys_info.get("diskUsedPct") or 0.0),
        "errorRate":          error_rate,
        "durationP50":        _percentile(durations, 50),
        "durationP95":        _percentile(durations, 95),
        "completedCount":     sum(1 for e in events if e.get("type") == "CommandCompleted" and _event_command_id(e) not in smoke_ids),
        "failedCount":        sum(1 for e in events if e.get("type") == "CommandFailed" and _event_command_id(e) not in smoke_ids),
        "queueDepth":         queue_depth,
        "toolCallsPerAgent":  _tool_calls_per_agent(events),
        "recentFailures":     _recent_failures(events),
        "modelUsage":         _compute_model_usage(events),
        "agentStatus":        mapped_agents,
        "gpu":                gpu_info,
        "sys":                sys_info,
        "stepLatency":        get_step_latency_stats(),
        "hookStats":          get_hook_stats(),
        "tokenBudget":        get_token_budget(),
        "ts":                 time.time(),
    }
