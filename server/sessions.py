"""RepoCiv — canonical session store.

Persists a small resumable session summary per unit plus an append-only transcript.
This is intentionally local-first and human-inspectable.
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
    _base_dir = store_dir / "sessions"
    _base_dir.mkdir(parents=True, exist_ok=True)


def _require_base() -> Path:
    if _base_dir is None:
        raise RuntimeError("sessions store not initialized")
    return _base_dir


def _session_dir(unit_id: str) -> Path:
    return _require_base() / unit_id


def _canonical_path(unit_id: str) -> Path:
    return _session_dir(unit_id) / "canonical.json"


def _transcript_path(unit_id: str) -> Path:
    return _session_dir(unit_id) / "transcript.jsonl"


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def _now_iso(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or time.time()))


def get_or_create(unit_id: str, *, defaults: dict[str, Any] | None = None) -> dict[str, Any]:
    with _locks.hold(f"session:{unit_id}"):
        path = _canonical_path(unit_id)
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    return data
            except Exception:
                pass
        data = {
            "unitId": unit_id,
            "runtimeId": "",
            "sessionKey": unit_id.lower(),
            "summary": "",
            "repo": "",
            "workingDirectory": "",
            "lastMissionId": "",
            "messageCount": 0,
            "inputChars": 0,
            "outputChars": 0,
            "updatedAt": _now_iso(),
        }
        if defaults:
            data.update(defaults)
        _atomic_write(path, json.dumps(data, ensure_ascii=False, indent=2))
        return data


def save(unit_id: str, data: dict[str, Any]) -> dict[str, Any]:
    with _locks.hold(f"session:{unit_id}"):
        canonical = dict(data)
        canonical["unitId"] = unit_id
        canonical["updatedAt"] = _now_iso()
        _atomic_write(_canonical_path(unit_id), json.dumps(canonical, ensure_ascii=False, indent=2))
        return canonical


def patch(unit_id: str, **fields: Any) -> dict[str, Any]:
    with _locks.hold(f"session:{unit_id}"):
        current = get_or_create(unit_id)
        current.update(fields)
        current["updatedAt"] = _now_iso()
        _atomic_write(_canonical_path(unit_id), json.dumps(current, ensure_ascii=False, indent=2))
        return current


def append_message(unit_id: str, role: str, content: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    meta = meta or {}
    with _locks.hold(f"session:{unit_id}"):
        canonical = get_or_create(unit_id)
        entry = {
            "ts": _now_iso(),
            "role": role,
            "content": content,
        }
        if meta:
            entry["meta"] = meta
        transcript = _transcript_path(unit_id)
        transcript.parent.mkdir(parents=True, exist_ok=True)
        with transcript.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

        canonical["messageCount"] = int(canonical.get("messageCount", 0)) + 1
        if role == "user":
            canonical["inputChars"] = int(canonical.get("inputChars", 0)) + len(content)
        else:
            canonical["outputChars"] = int(canonical.get("outputChars", 0)) + len(content)
        if meta.get("missionId"):
            canonical["lastMissionId"] = str(meta["missionId"])
        canonical["updatedAt"] = _now_iso()
        _atomic_write(_canonical_path(unit_id), json.dumps(canonical, ensure_ascii=False, indent=2))
        return canonical


def get_recent(unit_id: str, limit: int = 20) -> list[dict[str, Any]]:
    with _locks.hold(f"session:{unit_id}"):
        path = _transcript_path(unit_id)
        if not path.exists():
            return []
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except Exception:
            return []
    out: list[dict[str, Any]] = []
    for line in lines[-limit:]:
        try:
            row = json.loads(line)
        except Exception:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out
