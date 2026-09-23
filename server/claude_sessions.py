"""Claude Code sessions that RepoCiv launches itself (agent_runner).

Every mission runs with an explicit session id instead of ``--continue``:

  * a stateful unit resumes its own thread per (unit, city) with
    ``--resume <id>``. ``--continue`` picked the most recent conversation in
    the directory, which could be the user's own Claude Code session there;
  * the external-agents tracker can tell these sessions apart from the ones
    the user runs by hand and skip them. The mission's unit already stands
    on the map, and Suvadu's hooks would otherwise add an ``ext-claude-code-*``
    twin next to it.

State: ``$REPOCIV_CONFIG_DIR/claude-sessions.json`` (default ``~/.repociv``):
``{"threads": {"<unit>|<city>": "<uuid>"}, "owned": ["<uuid>", …]}``, with
``owned`` capped to the most recent ``_MAX_OWNED`` ids.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from pathlib import Path
from typing import Any

_MAX_OWNED = 500
_lock = threading.Lock()


def state_file() -> Path:
    config_dir = os.environ.get("REPOCIV_CONFIG_DIR", "") or str(Path.home() / ".repociv")
    return Path(config_dir).expanduser() / "claude-sessions.json"


def _is_uuid(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value.lower()
    except ValueError:
        return False


def _load() -> dict[str, Any]:
    try:
        data = json.loads(state_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    threads = data.get("threads") if isinstance(data, dict) else None
    owned = data.get("owned") if isinstance(data, dict) else None
    return {
        "threads": {k: v for k, v in (threads or {}).items() if isinstance(k, str) and _is_uuid(v)},
        "owned": [v for v in (owned or []) if _is_uuid(v)],
    }


def _save(data: dict[str, Any]) -> None:
    path = state_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass


def thread_key(unit_id: str, city_slug: str) -> str:
    unit = (unit_id or "main").strip().lower() or "main"
    return f"{unit}|{city_slug or 'main'}"


def session_for(unit_id: str, city_slug: str, *, stateful: bool) -> tuple[str, bool]:
    """``(session_id, resume)`` for the next mission of this unit in this city.

    Stateful: the stored thread (``resume=True``) or a new one, stored now.
    Stateless: a fresh id every time. Either way the id is recorded as owned.
    """
    with _lock:
        data = _load()
        key = thread_key(unit_id, city_slug)
        stored = data["threads"].get(key) if stateful else None
        session_id = stored or str(uuid.uuid4())
        if stateful:
            data["threads"][key] = session_id
        data["owned"] = ([s for s in data["owned"] if s != session_id] + [session_id])[-_MAX_OWNED:]
        _save(data)
    return session_id, stored is not None


def forget_thread(unit_id: str, city_slug: str) -> None:
    """Drop a stored thread (e.g. its transcript is gone), so the next mission starts fresh."""
    with _lock:
        data = _load()
        if data["threads"].pop(thread_key(unit_id, city_slug), None) is not None:
            _save(data)


def owned_ids() -> frozenset[str]:
    """Every Claude Code session id RepoCiv started (threads + recent one-offs)."""
    data = _load()
    return frozenset(data["owned"]) | frozenset(data["threads"].values())


def record_owned(session_id: str) -> None:
    """Remember one more session RepoCiv launched outside a mission (live channel)."""
    if not _is_uuid(session_id):
        return
    with _lock:
        data = _load()
        data["owned"] = ([s for s in data["owned"] if s != session_id] + [session_id])[-_MAX_OWNED:]
        _save(data)
