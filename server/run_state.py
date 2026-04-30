"""RepoCiv — resumable run-state store.

Stores a summarized operational snapshot per mission/run, separate from the append-
only event log. Optimized for restart/recovery and UI status.
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
    _base_dir = store_dir / "run-state"
    _base_dir.mkdir(parents=True, exist_ok=True)


def _require_base() -> Path:
    if _base_dir is None:
        raise RuntimeError("run-state store not initialized")
    return _base_dir


def _path(run_id: str) -> Path:
    return _require_base() / f"{run_id}.json"


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def _now_iso(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or time.time()))


def load(run_id: str) -> dict[str, Any] | None:
    path = _path(run_id)
    if not path.exists():
        return None
    with _locks.hold(f"run:{run_id}"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
    return data if isinstance(data, dict) else None


def save(run_id: str, state: dict[str, Any]) -> dict[str, Any]:
    with _locks.hold(f"run:{run_id}"):
        data = dict(state)
        data["missionId"] = run_id
        data["updatedAt"] = _now_iso()
        _atomic_write(_path(run_id), json.dumps(data, ensure_ascii=False, indent=2))
        return data


def patch(run_id: str, **fields: Any) -> dict[str, Any]:
    with _locks.hold(f"run:{run_id}"):
        current = load(run_id) or {"missionId": run_id}
        current.update(fields)
        current["updatedAt"] = _now_iso()
        _atomic_write(_path(run_id), json.dumps(current, ensure_ascii=False, indent=2))
        return current
