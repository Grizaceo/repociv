"""RepoCiv — Directive Learner (Fase 9).

Analyses gesture→outcome records to:
  - compute success rates per (gesture, cmd_type) pair
  - generate ranked suggestions for a given gesture+agent context
  - extract top-used directive templates
  - return recent successful directives for replay

No ML. Pure frequency counting + success-rate scoring.
"""
from __future__ import annotations

import math
from typing import Any


# ─── Correlate gesture + outcome records ─────────────────────────────────────

def _correlate(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Join gesture and outcome records into unified dicts keyed by command_id."""
    gestures: dict[str, dict[str, Any]] = {}
    outcomes: dict[str, dict[str, Any]] = {}

    for r in records:
        cid = r.get("command_id", "")
        if r.get("type") == "gesture":
            gestures[cid] = r
        elif r.get("type") == "outcome":
            outcomes[cid] = r

    joined: list[dict[str, Any]] = []
    for cid, g in gestures.items():
        entry = {**g}
        if cid in outcomes:
            o = outcomes[cid]
            entry["outcome"]    = o.get("outcome", "unknown")
            entry["duration_s"] = o.get("duration_s", 0.0)
        else:
            entry["outcome"]    = "pending"
            entry["duration_s"] = 0.0
        joined.append(entry)

    return sorted(joined, key=lambda x: x.get("ts", 0.0))


# ─── Success rates by (gesture, cmd_type) ────────────────────────────────────

def success_rates(records: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Returns nested dict:
      {gesture: {cmd_type: {rate: float, count: int, success: int}}}
    Excludes 'pending' outcomes from rate calculations.
    """
    joined = _correlate(records)
    stats: dict[str, dict[str, dict[str, int]]] = {}

    for entry in joined:
        if entry["outcome"] == "pending":
            continue
        g = entry.get("gesture", "unknown")
        t = entry.get("cmd_type", "unknown")
        stats.setdefault(g, {}).setdefault(t, {"count": 0, "success": 0})
        stats[g][t]["count"] += 1
        if entry["outcome"] == "success":
            stats[g][t]["success"] += 1

    result: dict[str, Any] = {}
    for gesture, types in stats.items():
        result[gesture] = {}
        for cmd_type, s in types.items():
            rate = s["success"] / s["count"] if s["count"] else 0.0
            result[gesture][cmd_type] = {
                "rate":    round(rate, 3),
                "count":   s["count"],
                "success": s["success"],
            }
    return result


# ─── Suggestions ─────────────────────────────────────────────────────────────

def suggest(
    gesture: str,
    agent_id: str,
    records: list[dict[str, Any]],
    n: int = 3,
) -> list[dict[str, Any]]:
    """
    Return up to n ranked suggestions for (gesture, agent_id).
    Score = success_rate * log2(count + 2) — rewards accurate AND frequent patterns.
    Filters to records from this agent or 'any' agent.
    """
    base_agent = agent_id.split("-")[0].upper()
    joined = _correlate(records)

    # Accumulate per cmd_type
    bucket: dict[str, dict[str, int]] = {}
    for entry in joined:
        if entry.get("gesture") != gesture:
            continue
        rec_agent = entry.get("agent_id", "").split("-")[0].upper()
        if rec_agent not in (base_agent, "DAVI", ""):
            continue
        if entry["outcome"] == "pending":
            continue
        t = entry.get("cmd_type", "unknown")
        bucket.setdefault(t, {"count": 0, "success": 0})
        bucket[t]["count"] += 1
        if entry["outcome"] == "success":
            bucket[t]["success"] += 1

    if not bucket:
        return []

    scored = []
    for cmd_type, s in bucket.items():
        rate  = s["success"] / s["count"] if s["count"] else 0.0
        score = rate * math.log2(s["count"] + 2)
        scored.append({
            "cmdType":     cmd_type,
            "successRate": round(rate, 2),
            "count":       s["count"],
            "score":       round(score, 3),
        })

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:n]


# ─── Templates ───────────────────────────────────────────────────────────────

def top_templates(
    records: list[dict[str, Any]],
    n: int = 5,
) -> list[dict[str, Any]]:
    """
    Top n most-used successful directive patterns for quick-launch.
    A template = (gesture, agent_id base, cmd_type) with success_rate > 0.
    """
    joined = _correlate(records)
    bucket: dict[tuple[str, str, str], dict[str, int]] = {}

    for entry in joined:
        if entry["outcome"] not in ("success", "failure"):
            continue
        key = (
            entry.get("gesture", ""),
            entry.get("agent_id", "").split("-")[0].upper(),
            entry.get("cmd_type", ""),
        )
        bucket.setdefault(key, {"count": 0, "success": 0})
        bucket[key]["count"] += 1
        if entry["outcome"] == "success":
            bucket[key]["success"] += 1

    templates = []
    for (gesture, agent, cmd_type), s in bucket.items():
        if s["count"] < 1:
            continue
        rate = s["success"] / s["count"]
        templates.append({
            "gesture":     gesture,
            "agentId":     agent,
            "cmdType":     cmd_type,
            "successRate": round(rate, 2),
            "count":       s["count"],
        })

    templates.sort(key=lambda x: (x["count"], x["successRate"]), reverse=True)
    return templates[:n]


# ─── Recent successes for replay ─────────────────────────────────────────────

def recent_successes(
    records: list[dict[str, Any]],
    n: int = 8,
) -> list[dict[str, Any]]:
    """Last n successful directive records, newest first. Used for replay."""
    joined = _correlate(records)
    successes = [e for e in joined if e.get("outcome") == "success"]
    return list(reversed(successes[-n:]))


# ─── Full stats snapshot ──────────────────────────────────────────────────────

def stats_snapshot(records: list[dict[str, Any]]) -> dict[str, Any]:
    joined = _correlate(records)
    total   = len([e for e in joined if e["outcome"] != "pending"])
    success = len([e for e in joined if e["outcome"] == "success"])
    return {
        "totalRecorded": len(joined),
        "totalResolved": total,
        "overallSuccessRate": round(success / total, 3) if total else 0.0,
        "successRates": success_rates(records),
        "templates":    top_templates(records),
        "recentSuccesses": recent_successes(records),
    }
