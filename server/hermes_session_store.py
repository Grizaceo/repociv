"""Best-effort JSON persistence for Hermes CLI session ids.

Path and key policies remain with the caller. Load resolves path, reads JSON,
then resolves the key if mapping lookup is possible. Save skips falsey ids;
otherwise it resolves path, checks existence, reads only if present, resolves
the key, creates the parent and writes JSON. Malformed data and IO errors
retain the legacy fallbacks; writes do not repair invalid existing payloads.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path


def load_session_id(*, state_file: Callable[[], Path], session_key: Callable[[], str]) -> str:
    try:
        data = json.loads(state_file().read_text(encoding="utf-8"))
        return str(data.get(session_key(), ""))
    except Exception:
        return ""


def save_session_id(
    session_id: str,
    *,
    state_file: Callable[[], Path],
    session_key: Callable[[], str],
) -> None:
    if not session_id:
        return
    try:
        path = state_file()
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        data[session_key()] = session_id
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass
