from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import unquote


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


def _is_within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def resolve_selected_repo(repo_id_or_name: str, explicit_path: str = "") -> str | None:
    repo_id_or_name = unquote(repo_id_or_name)
    state = load_state()
    roots = state.get("roots", {})
    if not isinstance(roots, dict):
        return None

    candidate = os.path.expanduser(explicit_path.strip()) if explicit_path.strip() else ""
    if not candidate:
        candidate = decode_repo_id(repo_id_or_name) or ""
    if not candidate:
        if any(separator in repo_id_or_name for separator in ("/", "\\")) or repo_id_or_name in {
            ".",
            "..",
        }:
            return None
        matches: list[str] = []
        for entry in roots.values():
            if not isinstance(entry, dict):
                continue
            selected = entry.get("selectedRepoPaths", [])
            if isinstance(selected, list):
                matches.extend(
                    str(item)
                    for item in selected
                    if isinstance(item, str) and os.path.basename(item) == repo_id_or_name
                )
        if len(matches) != 1:
            return None
        candidate = matches[0]

    candidate_abs = os.path.abspath(os.path.expanduser(candidate))
    for root_path, entry in roots.items():
        if not isinstance(root_path, str) or not isinstance(entry, dict):
            continue
        selected = entry.get("selectedRepoPaths", [])
        if not isinstance(selected, list):
            continue
        if not any(
            isinstance(item, str)
            and os.path.abspath(os.path.expanduser(item)) == candidate_abs
            for item in selected
        ):
            continue
        root_real = os.path.realpath(os.path.expanduser(root_path))
        candidate_real = os.path.realpath(candidate_abs)
        if os.path.isdir(candidate_real) and _is_within(candidate_real, root_real):
            return candidate_real
        return None
    return None
