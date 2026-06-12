"""RepoCiv — Directive Learner (Fase 9).

Analyses gesture→outcome records to:
  - compute success rates per (gesture, cmd_type) pair
  - generate ranked suggestions for a given gesture+agent context
  - extract top-used directive templates
  - return recent successful directives for replay

No ML. Pure frequency counting + success-rate scoring.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
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

def _context_sim(a: dict[str, Any] | None, b: dict[str, Any] | None) -> float:
    """Compute 0..1 context similarity between two context dicts.
    Features: repoType (exact match = 0.6 weight), testStatus (exact = 0.2),
    lastCmdType (exact = 0.2). Absent context = 0.0 bonus."""
    if not a or not b:
        return 0.0
    score = 0.0
    if a.get("repoType") and b.get("repoType") and a["repoType"] == b["repoType"]:
        score += 0.6
    if a.get("testStatus") and b.get("testStatus") and a["testStatus"] == b["testStatus"]:
        score += 0.2
    if a.get("lastCmdType") and b.get("lastCmdType") and a["lastCmdType"] == b["lastCmdType"]:
        score += 0.2
    return score


def suggest(
    gesture: str,
    agent_id: str,
    records: list[dict[str, Any]],
    n: int = 3,
    current_context: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """
    Return up to n ranked suggestions for (gesture, agent_id).
    Score = success_rate * log2(count + 2) * (1 + context_similarity)
    Filters to records from this agent or 'any' agent.
    If context is provided, entries matching context features get a boost.
    """
    base_agent = agent_id.split("-")[0].upper()
    joined = _correlate(records)

    # Accumulate per (cmd_type, target) with optional context bonus
    bucket: dict[tuple[str, str], dict[str, Any]] = {}
    for entry in joined:
        if entry.get("gesture") != gesture:
            continue
        rec_agent = entry.get("agent_id", "").split("-")[0].upper()
        if rec_agent not in (base_agent, "MAIN", ""):
            continue
        if entry["outcome"] == "pending":
            continue
        t = entry.get("cmd_type", "unknown")
        tg = entry.get("target", "")
        key = (t, tg)
        if key not in bucket:
            bucket[key] = {"count": 0, "success": 0, "contexts": []}
        bucket[key]["count"] += 1
        if entry["outcome"] == "success":
            bucket[key]["success"] += 1
        entry_ctx = entry.get("context")
        if entry_ctx:
            bucket[key]["contexts"].append(entry_ctx)

    if not bucket:
        return []

    scored = []
    for (cmd_type, target), s in bucket.items():
        rate  = s["success"] / s["count"] if s["count"] else 0.0
        base  = rate * math.log2(s["count"] + 2)
        # Context bonus: average sim across stored contexts for this pattern
        ctx_bonus = 0.0
        if current_context and s["contexts"]:
            ctx_bonus = sum(_context_sim(current_context, c) for c in s["contexts"]) / len(s["contexts"])
        score = base * (1.0 + ctx_bonus)
        scored.append({
            "cmdType":     cmd_type,
            "target":      target,
            "successRate": round(rate, 2),
            "count":       s["count"],
            "score":       round(score, 3),
        })

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:n]


# ─── Templates ───────────────────────────────────────────────────────────────

_TEMPLATES_PATH: Path | None = None


def set_templates_path(path: Path) -> None:
    global _TEMPLATES_PATH
    _TEMPLATES_PATH = path


def top_templates(
    records: list[dict[str, Any]],
    n: int = 5,
    min_count: int = 1,
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
        if s["count"] < min_count:
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


def save_templates(records: list[dict[str, Any]]) -> int:
    """Persist learned templates to disk. Returns number saved. Called on shutdown."""
    if _TEMPLATES_PATH is None:
        return 0
    templates = top_templates(records, n=20, min_count=2)
    _TEMPLATES_PATH.parent.mkdir(parents=True, exist_ok=True)
    _TEMPLATES_PATH.write_text(json.dumps(templates, ensure_ascii=False, indent=2))
    return len(templates)


def load_templates() -> list[dict[str, Any]]:
    """Load previously persisted templates. Returns empty list if none exist."""
    if _TEMPLATES_PATH is None or not _TEMPLATES_PATH.exists():
        return []
    try:
        return json.loads(_TEMPLATES_PATH.read_text())
    except (json.JSONDecodeError, FileNotFoundError):
        return []


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
