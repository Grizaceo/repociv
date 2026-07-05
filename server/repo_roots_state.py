from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any


def _state_file() -> Path:
    explicit = os.environ.get("REPOCIV_STATE_FILE", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    xdg = os.environ.get("XDG_STATE_HOME", "").strip()
    base = Path(xdg).expanduser() if xdg else Path.home() / ".local" / "state"
    return base / "repociv" / "state.json"


def load_state() -> dict[str, Any]:
    path = _state_file()
    if not path.exists():
        return {"version": 1, "activeRoot": "", "roots": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"version": 1, "activeRoot": "", "roots": {}}
        return data
    except Exception:
        return {"version": 1, "activeRoot": "", "roots": {}}


def active_root() -> str:
    state = load_state()
    root = str(state.get("activeRoot", "") or "").strip()
    return os.path.expanduser(root) if root else ""


def decode_repo_id(repo_id: str) -> str | None:
    if not repo_id.startswith("repo:"):
        return None
    encoded = repo_id[len("repo:") :]
    try:
        padding = "=" * (-len(encoded) % 4)
        decoded = base64.urlsafe_b64decode((encoded + padding).encode("ascii")).decode("utf-8")
        return os.path.expanduser(decoded)
    except Exception:
        return None
