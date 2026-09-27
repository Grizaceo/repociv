"""RepoCiv — Persistent multi-root state (onboarding).

Stores the user's registered map roots and per-root repo selections in
``~/.local/state/repociv/state.json`` (XDG-aware, overridable via
``REPOCIV_STATE_FILE``).

Schema:
  {
    "version": 1,
    "activeRoot": "/home/gris/.hermes/workspace/repos",
    "roots": {
      "/home/gris/.hermes/workspace/repos": {
        "selectedRepoPaths": ["/.../repo-a", "/.../repo-b"],
        "addedAt": "2026-06-06T14:22:23.531Z",
        "lastSeen": "2026-07-05T20:13:15.088Z"
      },
      ...
    }
  }

Public API:
  load_state() → dict
  active_root() → str
  set_active_root(path) → dict
  add_root(path, label?) → dict
  remove_root(path) → dict
  get_roots() → list[dict]
  get_selection(root_path) → list[str]
  set_selection(root_path, repo_paths) → dict
  add_selected(path) → dict        # add to active root
  remove_selected(path) → dict     # remove from active root
  decode_repo_id(repo_id) → str | None
  state_file() → Path
"""
from __future__ import annotations

import base64
import json
import os
from datetime import datetime, timezone
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


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _empty_state() -> dict[str, Any]:
    return {"version": 1, "activeRoot": "", "roots": {}}


def load_state() -> dict[str, Any]:
    path = _state_file()
    if not path.exists():
        return _empty_state()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return _empty_state()
        # Ensure required keys
        data.setdefault("version", 1)
        data.setdefault("activeRoot", "")
        data.setdefault("roots", {})
        if not isinstance(data["roots"], dict):
            data["roots"] = {}
        return data
    except Exception:
        return _empty_state()


def _save_state(data: dict[str, Any]) -> dict[str, Any]:
    path = _state_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=False), encoding="utf-8")
    os.replace(tmp, path)
    return data


def active_root() -> str:
    state = load_state()
    root = str(state.get("activeRoot", "") or "").strip()
    return os.path.expanduser(root) if root else ""


def state_file() -> Path:
    """Return the resolved state file path (for tests)."""
    return _state_file()


# ── Write operations ────────────────────────────────────────────────────────


def set_active_root(path: str) -> dict[str, Any]:
    """Set the active root. The path must exist in roots (or will be auto-added)."""
    expanded = os.path.expanduser(path.strip())
    state = load_state()
    state["activeRoot"] = expanded
    if expanded and expanded not in state["roots"]:
        state["roots"][expanded] = {
            "selectedRepoPaths": [],
            "addedAt": _now_iso(),
            "lastSeen": _now_iso(),
        }
    # Update lastSeen for the active root
    if expanded in state["roots"]:
        state["roots"][expanded]["lastSeen"] = _now_iso()
    return _save_state(state)


def add_root(path: str, label: str | None = None) -> dict[str, Any]:
    """Register a new map root. Returns the updated state."""
    expanded = os.path.expanduser(path.strip())
    if not expanded:
        raise ValueError("root path must not be empty")
    state = load_state()
    now = _now_iso()
    if expanded not in state["roots"]:
        entry: dict[str, Any] = {
            "selectedRepoPaths": [],
            "addedAt": now,
            "lastSeen": now,
        }
        if label:
            entry["label"] = label
        state["roots"][expanded] = entry
    else:
        state["roots"][expanded]["lastSeen"] = now
        if label:
            state["roots"][expanded]["label"] = label
    # If no active root yet, make this the active one
    if not state.get("activeRoot"):
        state["activeRoot"] = expanded
    return _save_state(state)


def remove_root(path: str) -> dict[str, Any]:
    """Remove a root and its selections. If it was active, clear activeRoot."""
    expanded = os.path.expanduser(path.strip())
    state = load_state()
    if expanded in state["roots"]:
        del state["roots"][expanded]
    if state.get("activeRoot") == expanded:
        # Pick the first remaining root, or empty
        remaining = sorted(state["roots"].keys())
        state["activeRoot"] = remaining[0] if remaining else ""
    return _save_state(state)


def get_roots() -> list[dict[str, Any]]:
    """Return roots as a list of dicts with metadata."""
    state = load_state()
    active = state.get("activeRoot", "")
    out: list[dict[str, Any]] = []
    for path, entry in state.get("roots", {}).items():
        selected = entry.get("selectedRepoPaths", [])
        if not isinstance(selected, list):
            selected = []
        out.append(
            {
                "path": path,
                "label": entry.get("label"),
                "isActive": path == active,
                "repoCount": 0,  # filled by the scanner
                "selectedCount": len(selected),
                "selectedRepoPaths": selected,
                "addedAt": entry.get("addedAt", ""),
                "lastSeen": entry.get("lastSeen", ""),
            }
        )
    return out


def get_selection(root_path: str) -> list[str]:
    """Return the selected repo paths for a given root."""
    state = load_state()
    expanded = os.path.expanduser(root_path.strip())
    entry = state.get("roots", {}).get(expanded)
    if not entry:
        return []
    selected = entry.get("selectedRepoPaths", [])
    if not isinstance(selected, list):
        return []
    return selected


def set_selection(root_path: str, repo_paths: list[str]) -> dict[str, Any]:
    """Persist the selected repo paths for a given root."""
    expanded = os.path.expanduser(root_path.strip())
    state = load_state()
    now = _now_iso()
    if expanded not in state["roots"]:
        state["roots"][expanded] = {
            "selectedRepoPaths": [],
            "addedAt": now,
            "lastSeen": now,
        }
    state["roots"][expanded]["selectedRepoPaths"] = list(repo_paths)
    state["roots"][expanded]["lastSeen"] = now
    return _save_state(state)


def add_selected(repo_path: str) -> dict[str, Any]:
    """Add a repo path to the active root's selection."""
    state = load_state()
    active = state.get("activeRoot", "")
    if not active:
        raise ValueError("no active root set")
    entry = state["roots"].get(active)
    if not entry:
        entry = {"selectedRepoPaths": [], "addedAt": _now_iso(), "lastSeen": _now_iso()}
        state["roots"][active] = entry
    selected = entry.get("selectedRepoPaths", [])
    if not isinstance(selected, list):
        selected = []
    if repo_path not in selected:
        selected.append(repo_path)
    entry["selectedRepoPaths"] = selected
    entry["lastSeen"] = _now_iso()
    return _save_state(state)


def remove_selected(repo_path: str) -> dict[str, Any]:
    """Remove a repo path from the active root's selection."""
    state = load_state()
    active = state.get("activeRoot", "")
    if not active:
        return state
    entry = state["roots"].get(active)
    if not entry:
        return state
    selected = entry.get("selectedRepoPaths", [])
    if not isinstance(selected, list):
        selected = []
    entry["selectedRepoPaths"] = [p for p in selected if p != repo_path]
    entry["lastSeen"] = _now_iso()
    return _save_state(state)


def decode_repo_id(repo_id: str) -> str | None:
    if not repo_id.startswith("repo:"):
        return None
    encoded = repo_id[len("repo:") :]
    try:
        padding = "=" * (-len(encoded) % 4)
        decoded = base64.urlsafe_b64decode((encoded + padding).encode("ascii")).decode(
            "utf-8"
        )
        return os.path.expanduser(decoded)
    except Exception:
        return None


def _is_within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def _canonical(path: str) -> str:
    """Resolve symlinks while retaining a normalized fallback for stale paths."""
    if not path:
        return ""
    try:
        return os.path.realpath(os.path.expanduser(path))
    except Exception:
        return os.path.abspath(os.path.expanduser(path))


def resolve_selected_repo(repo_id_or_name: str, explicit_path: str = "") -> str | None:
    """Resolve a selected repository and reject unselected or escaping paths."""
    repo_id_or_name = unquote(repo_id_or_name)
    state = load_state()
    roots = state.get("roots", {})
    if not isinstance(roots, dict):
        return None

    explicit = explicit_path.strip()
    if explicit.startswith("repo:"):
        candidate = decode_repo_id(explicit) or ""
    else:
        candidate = os.path.expanduser(explicit) if explicit else ""
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
        unique = list(dict.fromkeys(_canonical(match) for match in matches))
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
            isinstance(item, str) and _canonical(item) == candidate_real for item in selected
        ):
            continue
        root_real = _canonical(root_path)
        if os.path.isdir(candidate_real) and _is_within(candidate_real, root_real):
            return candidate_real
    return None
