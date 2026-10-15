"""Audit-ready usage counters persisted in ~/.repociv/ui_telemetry.json.

Stores ONLY integer counts (no prompts, paths, payloads, or user content) so the
alpha exit criteria in docs/SCOPE.md can be audited outside the browser:
  - daysWithUsage
  - commandsIssued
  - chatsSent
  - approvalsResolved
  - panelsOpened (per panel)
  - hotkeysUsed (per hotkey)

Also provides :func:`pruning_candidates_query` to feed the second pruning round
after 3-4 weeks of real usage.
"""
from __future__ import annotations

import datetime
import json
import re
import threading
from pathlib import Path
from typing import Any

from server import endpoint_usage as _endpoint_usage

KNOWN_PANELS: tuple[str, ...] = (
    "approvals",
    "harness",
    "recovery",
    "tasks",
    "task-assign",
    "pending",
    "log",
    "priority",
    "settings",
    "construction",
    "kanban",
)

_KEY_RE = re.compile(r"^[A-Za-z0-9_+:-]{1,48}$")
_lock = threading.Lock()
_telemetry_path: Path | None = None
_state: dict[str, dict[str, int]] = {
    "panelsOpened": {},
    "hotkeysUsed": {},
    "dailyActivityCounts": {},
}


def _clean_int_map(raw: Any) -> dict[str, int]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, int] = {}
    for k, v in raw.items():
        if isinstance(k, str) and _KEY_RE.match(k) and isinstance(v, int) and not isinstance(v, bool) and v >= 0:
            out[k] = v
    return out


def init(config_dir: Path) -> None:
    global _telemetry_path, _state
    config_dir.mkdir(parents=True, exist_ok=True)
    _telemetry_path = config_dir / "ui_telemetry.json"
    loaded: dict[str, Any] = {}
    if _telemetry_path.exists():
        try:
            raw = json.loads(_telemetry_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                loaded = raw
        except Exception:
            loaded = {}
    with _lock:
        _state = {
            "panelsOpened": _clean_int_map(loaded.get("panelsOpened")),
            "hotkeysUsed": _clean_int_map(loaded.get("hotkeysUsed")),
            "dailyActivityCounts": _clean_int_map(loaded.get("dailyActivityCounts")),
        }


def _persist() -> None:
    if _telemetry_path is None:
        return
    try:
        _telemetry_path.write_text(
            json.dumps(_state, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except Exception:
        pass


def _today_key() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def record_ui_event(kind: str, name: str, count: int = 1) -> bool:
    """Increment a panel or hotkey counter by ``count`` (>= 1)."""
    if kind not in ("panel", "hotkey"):
        return False
    key = (name or "").strip()
    if not _KEY_RE.match(key):
        return False
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        return False
    bucket_name = "panelsOpened" if kind == "panel" else "hotkeysUsed"
    day = _today_key()
    with _lock:
        bucket = _state.setdefault(bucket_name, {})
        bucket[key] = int(bucket.get(key, 0)) + count
        daily = _state.setdefault("dailyActivityCounts", {})
        daily[day] = int(daily.get(day, 0)) + count
        _persist()
    return True


def _event_store_counts() -> tuple[set[str], int, int]:
    """Derive (active_days, commands_created, execute_agent_chats) from events.jsonl."""
    days: set[str] = set()
    commands_created = 0
    chat_missions = 0
    try:
        from server import event_store as _es

        path = getattr(_es, "_store_path", None)
        if path and Path(path).exists():
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(ev, dict):
                        continue
                    ts = ev.get("timestamp")
                    if isinstance(ts, (int, float)) and ts > 0:
                        day = datetime.datetime.fromtimestamp(
                            float(ts), tz=datetime.timezone.utc
                        ).strftime("%Y-%m-%d")
                        days.add(day)
                    etype = ev.get("type")
                    if etype == "CommandCreated":
                        commands_created += 1
                        data = ev.get("data") or {}
                        if isinstance(data, dict) and data.get("type") == "execute_agent":
                            chat_missions += 1
    except Exception:
        pass
    return days, commands_created, chat_missions


def get_usage_summary() -> dict[str, Any]:
    """Return the audit-ready alpha metrics summary (counts only)."""
    with _lock:
        panels = dict(_state.get("panelsOpened", {}))
        hotkeys = dict(_state.get("hotkeysUsed", {}))
        daily = dict(_state.get("dailyActivityCounts", {}))

    ep_rows = _endpoint_usage.get_stats(limit=500)
    ep_by_key = {f"{r.get('method')} {r.get('path')}": int(r.get("count", 0)) for r in ep_rows}

    ev_days, ev_commands, ev_chat_missions = _event_store_counts()
    all_days = {d for d, c in daily.items() if c > 0} | ev_days

    post_commands = ep_by_key.get("POST /commands", 0)
    commands_issued = max(post_commands, ev_commands)

    ext_chats = (
        ep_by_key.get("POST /api/external-agents/:id/chat", 0)
        + ep_by_key.get("POST /api/external-agents/:id/reply", 0)
    )
    chats_sent = ext_chats + max(ev_chat_missions, post_commands)

    approvals_resolved = (
        ep_by_key.get("POST /approvals/:id/approve", 0)
        + ep_by_key.get("POST /approvals/:id/reject", 0)
    )

    panel_report = sorted(
        [{"panel": p, "opens": int(panels.get(p, 0))} for p in KNOWN_PANELS],
        key=lambda item: (item["opens"], item["panel"]),
    )

    return {
        "daysWithUsage": len(all_days),
        "commandsIssued": commands_issued,
        "chatsSent": chats_sent,
        "approvalsResolved": approvals_resolved,
        "panelsOpened": panels,
        "hotkeysUsed": hotkeys,
        "panelUsageReport": panel_report,
    }


def pruning_candidates_query() -> dict[str, Any]:
    """Query feeding the second pruning round (after 3-4 weeks of Phase 4 metrics).

    Identifies KNOWN_PANELS with 0 opens and registered HTTP endpoints with 0 hits.
    """
    summary = get_usage_summary()
    unused_panels = [
        row["panel"] for row in summary["panelUsageReport"] if row["opens"] == 0
    ]
    ep_rows = _endpoint_usage.get_stats(limit=500)
    called_routes = {f"{r.get('method')} {r.get('path')}" for r in ep_rows if int(r.get("count", 0)) > 0}

    registered: list[str] = []
    try:
        from server.routes import registry as _reg

        for path in sorted(_reg.GET_EXACT):
            registered.append(f"GET {path}")
        for path in sorted(_reg.POST_EXACT):
            registered.append(f"POST {path}")
    except Exception:
        pass

    unused_endpoints = [route for route in registered if route not in called_routes]
    return {
        "unusedPanels": unused_panels,
        "unusedEndpoints": unused_endpoints,
        "daysWithUsage": summary["daysWithUsage"],
    }
