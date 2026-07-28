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


def _canonical(path: str) -> str:
    """Resolve a path through symlinks and bind mounts to its inode-level path.

    Two paths that point at the same filesystem object (e.g. a bind-mount
    view of the same directory under two different parents) collapse to
    the same canonical string. Lets the validator accept any logically
    equivalent prefix for the same selected repo.
    """
    if not path:
        return ""
    try:
        return os.path.realpath(os.path.expanduser(path))
    except Exception:
        # If realpath fails (e.g. path no longer exists), fall back to abspath
        # so we at least compare on normalized strings rather than crashing.
        return os.path.abspath(os.path.expanduser(path))


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
        unique: list[str] = list(dict.fromkeys(_canonical(m) for m in matches))
        if len(unique) != 1:
            return None
        candidate = unique[0]

    candidate_real = _canonical(candidate)
    for root_path, entry in roots.items():
        if not isinstance(root_path, str) or not isinstance(entry, dict):
            continue
        selected = entry.get("selectedRepoPaths", [])
        if not isinstance(selected, list):
            continue
        if not any(
            isinstance(item, str) and _canonical(item) == candidate_real
            for item in selected
        ):
            continue
        root_real = _canonical(root_path)
        # candidate_real was set above via _canonical(candidate) — no need
        # to re-realpath here.
        if os.path.isdir(candidate_real) and _is_within(candidate_real, root_real):
            return candidate_real
        continue
    return None
