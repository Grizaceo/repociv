"""RepoCiv — Observability Metrics (Fase 7).

Computes health metrics from the event store and scheduler state.
Called by GET /metrics in bridge.py — no side effects.
"""
from __future__ import annotations

import os
import statistics
import time
from typing import Any


# ─── Duration computation ─────────────────────────────────────────────────────

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
    terminal = [
        e for e in events[-window:]
        if e.get("type") in ("CommandCompleted", "CommandFailed", "CommandRejected")
    ]
    if not terminal:
        return 0.0
    failures = sum(1 for e in terminal if e.get("type") in ("CommandFailed", "CommandRejected"))
    return round(failures / len(terminal), 3)


# ─── Tool calls per agent ─────────────────────────────────────────────────────

def _tool_calls_per_agent(events: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for ev in events:
        if ev.get("type") == "CommandCreated":
            data = ev.get("data", {})
            unit = str(data.get("unit", data.get("created_by", "unknown")))
            base = unit.split("-")[0].upper()
            counts[base] = counts.get(base, 0) + 1
    return counts


# ─── Recent failures ──────────────────────────────────────────────────────────

def _recent_failures(events: list[dict[str, Any]], n: int = 8) -> list[dict[str, Any]]:
    failures = [
        e for e in events
        if e.get("type") == "CommandFailed"
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


# ─── Health score ─────────────────────────────────────────────────────────────

def _health(error_rate: float, queue_depth: int, disk_used_pct: float) -> str:
    if error_rate > 0.30 or queue_depth > 20:
        return "critical"
    if error_rate > 0.10 or queue_depth > 8 or disk_used_pct > 90:
        return "degraded"
    return "ok"


# ─── System resources ─────────────────────────────────────────────────────────

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

    # Map scheduler agent_status {id, status, activeTasks} → frontend {id, state, activeTask}
    mapped_agents = []
    for a in agent_status:
        mapped_agents.append({
            "id": a.get("id", ""),
            "state": a.get("status", a.get("state", "offline")),
            "activeTask": a.get("activeTasks", a.get("activeTask", None)),
        })

    return {
        "health":             _health(error_rate, queue_depth, sys_info.get("diskUsedPct") or 0.0),
        "errorRate":          error_rate,
        "durationP50":        _percentile(durations, 50),
        "durationP95":        _percentile(durations, 95),
        "completedCount":     sum(1 for e in events if e.get("type") == "CommandCompleted"),
        "failedCount":        sum(1 for e in events if e.get("type") == "CommandFailed"),
        "queueDepth":         queue_depth,
        "toolCallsPerAgent":  _tool_calls_per_agent(events),
        "recentFailures":     _recent_failures(events),
        "agentStatus":        mapped_agents,
        "gpu":                gpu_info,
        "sys":                sys_info,
        "ts":                 time.time(),
    }
