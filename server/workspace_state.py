"""RepoCiv — workspace-level state store.

Tracks operational state per workspace (working directory): active missions,
run history, and resource usage. Sits above sessions/run_state in the hierarchy.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from . import locks as _locks


_base_dir: Path | None = None


def init(store_dir: Path) -> None:
    global _base_dir
    _base_dir = store_dir / "workspace-state"
    _base_dir.mkdir(parents=True, exist_ok=True)


def _require_base() -> Path:
    if _base_dir is None:
        raise RuntimeError("workspace-state store not initialized")
    return _base_dir


def _workspace_dir(workspace_id: str) -> Path:
    safe_id = workspace_id.replace("/", "_").replace("\\", "_")
    return _require_base() / safe_id


def _state_path(workspace_id: str) -> Path:
    return _workspace_dir(workspace_id) / "state.json"


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def _now_iso(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or time.time()))


def _default_state(workspace_id: str) -> dict[str, Any]:
    return {
        "workspaceId": workspace_id,
        "activeMissions": [],
        "runHistory": [],
        "resourceUsage": {
            "totalRuns": 0,
            "totalMessages": 0,
            "totalInputChars": 0,
            "totalOutputChars": 0,
        },
        "lastMissionId": "",
        "lastRunAt": "",
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
    }


def load(workspace_id: str) -> dict[str, Any] | None:
    path = _state_path(workspace_id)
    if not path.exists():
        return None
    with _locks.hold(f"workspace:{workspace_id}"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
    return data if isinstance(data, dict) else None


def get_or_create(workspace_id: str) -> dict[str, Any]:
    with _locks.hold(f"workspace:{workspace_id}"):
        existing = load(workspace_id)
        if existing:
            return existing
        data = _default_state(workspace_id)
        _atomic_write(_state_path(workspace_id), json.dumps(data, ensure_ascii=False, indent=2))
        return data


def save(workspace_id: str, state: dict[str, Any]) -> dict[str, Any]:
    with _locks.hold(f"workspace:{workspace_id}"):
        data = dict(state)
        data["workspaceId"] = workspace_id
        data["updatedAt"] = _now_iso()
        _atomic_write(_state_path(workspace_id), json.dumps(data, ensure_ascii=False, indent=2))
        return data


def patch(workspace_id: str, **fields: Any) -> dict[str, Any]:
    with _locks.hold(f"workspace:{workspace_id}"):
        current = get_or_create(workspace_id)
        current.update(fields)
        current["updatedAt"] = _now_iso()
        _atomic_write(_state_path(workspace_id), json.dumps(current, ensure_ascii=False, indent=2))
        return current


def add_active_mission(workspace_id: str, mission_id: str, mission_meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """Add a mission to the active missions list for this workspace."""
    with _locks.hold(f"workspace:{workspace_id}"):
        current = get_or_create(workspace_id)
        active = current.get("activeMissions", [])
        if mission_id not in active:
            active.append(mission_id)
            current["activeMissions"] = active
        if mission_meta:
            current[f"mission_{mission_id}_meta"] = mission_meta
        current["lastMissionId"] = mission_id
        current["updatedAt"] = _now_iso()
        _atomic_write(_state_path(workspace_id), json.dumps(current, ensure_ascii=False, indent=2))
        return current


def remove_active_mission(workspace_id: str, mission_id: str) -> dict[str, Any]:
    """Remove a mission from the active missions list and move to history."""
    with _locks.hold(f"workspace:{workspace_id}"):
        current = get_or_create(workspace_id)
        active = current.get("activeMissions", [])
        if mission_id in active:
            active.remove(mission_id)
            current["activeMissions"] = active
        history = current.get("runHistory", [])
        history.append({
            "missionId": mission_id,
            "endedAt": _now_iso(),
        })
        current["runHistory"] = history[-50:]  # Keep last 50
        # Update resource usage
        res = current.get("resourceUsage", {})
        res["totalRuns"] = res.get("totalRuns", 0) + 1
        current["resourceUsage"] = res
        current["updatedAt"] = _now_iso()
        _atomic_write(_state_path(workspace_id), json.dumps(current, ensure_ascii=False, indent=2))
        return current


def update_resource_usage(workspace_id: str, messages: int = 0, input_chars: int = 0, output_chars: int = 0) -> dict[str, Any]:
    """Update resource counters for this workspace."""
    with _locks.hold(f"workspace:{workspace_id}"):
        current = get_or_create(workspace_id)
        res = current.get("resourceUsage", {})
        res["totalMessages"] = res.get("totalMessages", 0) + messages
        res["totalInputChars"] = res.get("totalInputChars", 0) + input_chars
        res["totalOutputChars"] = res.get("totalOutputChars", 0) + output_chars
        current["resourceUsage"] = res
        current["updatedAt"] = _now_iso()
        _atomic_write(_state_path(workspace_id), json.dumps(current, ensure_ascii=False, indent=2))
        return current


def list_workspaces() -> list[str]:
    """List all workspace IDs that have state stored."""
    base = _require_base()
    if not base.exists():
        return []
    out = []
    for d in base.iterdir():
        if d.is_dir() and (d / "state.json").exists():
            out.append(d.name.replace("_", "/"))
    return sorted(out)


def get_active_missions(workspace_id: str) -> list[str]:
    """Get list of active mission IDs for a workspace."""
    state = load(workspace_id)
    if not state:
        return []
    return list(state.get("activeMissions", []))


def get_run_history(workspace_id: str, limit: int = 20) -> list[dict[str, Any]]:
    """Get recent run history for a workspace."""
    state = load(workspace_id)
    if not state:
        return []
    history = state.get("runHistory", [])
    return history[-limit:]