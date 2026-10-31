from __future__ import annotations

import copy
import threading
from typing import Any

_lock = threading.Lock()
_entries: dict[str, dict[str, Any]] = {}


def put(command_id: str, entry: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        _entries[command_id] = copy.deepcopy(entry)
        return copy.deepcopy(_entries[command_id])


def get(command_id: str) -> dict[str, Any] | None:
    with _lock:
        entry = _entries.get(command_id)
        return copy.deepcopy(entry) if entry is not None else None
