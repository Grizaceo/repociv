"""RepoCiv endpoint usage telemetry.

Local-only counters used for dogfooding decisions. This intentionally stores a
small aggregate JSON document instead of a request log so it cannot grow without
bound.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

_lock = threading.Lock()
_stats_path: Path | None = None
_stats: dict[str, dict[str, Any]] = {}


def init(config_dir: Path) -> None:
    global _stats_path, _stats
    config_dir.mkdir(parents=True, exist_ok=True)
    _stats_path = config_dir / "endpoint_usage.json"
    try:
        raw = json.loads(_stats_path.read_text(encoding="utf-8")) if _stats_path.exists() else {}
        _stats = raw if isinstance(raw, dict) else {}
    except Exception:
        _stats = {}


def _persist() -> None:
    if _stats_path is None:
        return
    try:
        _stats_path.write_text(json.dumps(_stats, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def normalize_path(path: str) -> str:
    path = path.split("?", 1)[0] or "/"
    parts = [p for p in path.split("/") if p]
    if not parts:
        return "/"
    if parts[0] == "commands" and len(parts) >= 3 and parts[2] == "cancel":
        return "/commands/:id/cancel"
    if parts[0] == "approvals" and len(parts) >= 3 and parts[2] in {"approve", "reject"}:
        return f"/approvals/:id/{parts[2]}"
    if parts[0] == "tasks" and len(parts) >= 2:
        if parts[-1] == "cancel":
            return "/tasks/:key/cancel"
        if parts[-1] == "circuit-status":
            return "/tasks/:repo/:issue/circuit-status"
        return "/tasks/:repo/:issue"
    if parts[:2] == ["api", "wonders"] and len(parts) >= 3:
        return "/api/wonders/:id/health" if len(parts) >= 4 and parts[3] == "health" else "/api/wonders/:id"
    if parts[0] == "wonders" and len(parts) >= 2:
        return "/wonders/:id/health" if len(parts) >= 3 and parts[2] == "health" else "/wonders/:id"
    if parts[:3] == ["api", "foreign", "reports"] and len(parts) >= 4:
        return "/api/foreign/reports/:id"
    if parts[:2] == ["api", "labhub"] and len(parts) >= 3 and parts[2] == "status":
        return "/api/labhub/status/:city_id" if len(parts) >= 4 else "/api/labhub/status"
    if parts[:2] == ["api", "graph-relations"] and len(parts) >= 3:
        return "/api/graph-relations/:from_id/evidence" if parts[-1] == "evidence" else path
    if parts[0] == "harnesses" and len(parts) >= 2:
        return "/harnesses/:id/recovery-command" if len(parts) >= 3 and parts[2] == "recovery-command" else "/harnesses/:id"
    return path


def record(method: str, path: str, status: int) -> None:
    if _stats_path is None:
        return
    route = normalize_path(path)
    key = f"{method.upper()} {route}"
    now = time.time()
    with _lock:
        entry = _stats.setdefault(
            key,
            {
                "method": method.upper(),
                "path": route,
                "count": 0,
                "statusCounts": {},
                "lastAt": 0.0,
            },
        )
        entry["count"] = int(entry.get("count", 0)) + 1
        status_counts = entry.setdefault("statusCounts", {})
        status_key = str(int(status))
        status_counts[status_key] = int(status_counts.get(status_key, 0)) + 1
        entry["lastAt"] = now
        _persist()


def get_stats(limit: int = 50) -> list[dict[str, Any]]:
    with _lock:
        rows = [dict(v) for v in _stats.values()]
    rows.sort(key=lambda row: (-int(row.get("count", 0)), str(row.get("method", "")), str(row.get("path", ""))))
    return rows[:limit]
