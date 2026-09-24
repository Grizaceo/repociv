"""RepoCiv — Onboarding HTTP route handlers.

Implements the multi-root / repo-selection endpoints that the onboarding
panel and settings UI call:

  GET  /api/map-roots               → list roots + active root
  POST /api/map-roots               → add a new root
  POST /api/map-roots/activate      → set active root
  POST /api/map-roots/remove        → remove a root
  POST /api/map-roots/pick          → open native folder picker (tkinter)
  GET  /api/map-root                → get current active root (singular)
  POST /api/map-root/pick           → legacy singular pick endpoint

  GET  /api/repo-selections         → full selection state (all roots)
  POST /api/repo-selections         → persist selection for a root
  POST /api/repo-selections/add     → add repo to active root selection
  POST /api/repo-selections/remove  → remove repo from active root selection

  GET  /api/repos                   → scan repos under active root
  GET  /api/repos/selected           → scan repos, filtered to selection
"""
from __future__ import annotations

import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from server.repo_roots_state import (
    active_root,
    add_root,
    add_selected,
    get_roots,
    get_selection,
    load_state,
    remove_root,
    remove_selected,
    set_active_root,
    set_selection,
)

# ── Skip directories when scanning for repos ─────────────────────────────────
_SKIP_DIRS = frozenset(
    {
        "node_modules",
        ".git",
        "__pycache__",
        ".venv",
        ".venv311",
        "venv",
        "env",
        "dist",
        "build",
        ".next",
        "target",
        "vendor",
        ".tox",
        ".mypy_cache",
        ".pytest_cache",
        "coverage",
        ".idea",
        ".vscode",
    }
)


def _error(status: int, error: str, cause: str = "", hint: str = "") -> tuple[int, dict[str, Any]]:
    return status, {"error": error, "cause": cause, "hint": hint}


def _ok(body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    return 200, body


# ── Repo scanner ──────────────────────────────────────────────────────────────


def _is_git_repo(path: Path) -> bool:
    return (path / ".git").is_dir() or (path / ".git").is_file() or (path / "HEAD").exists()


def _count_population(root_dir: Path) -> int:
    """Count non-skipped top-level items (files + dirs)."""
    count = 0
    try:
        for entry in root_dir.iterdir():
            if entry.name in _SKIP_DIRS or entry.name.startswith("."):
                continue
            count += 1
    except (OSError, PermissionError):
        pass
    return count


def _scan_extensions(root_dir: Path) -> dict[str, int]:
    """Count file extensions of immediate files inside the root."""
    exts: dict[str, int] = {}
    try:
        for entry in root_dir.iterdir():
            if entry.is_file() and not entry.name.startswith("."):
                ext = entry.suffix.lstrip(".") or "none"
                exts[ext] = exts.get(ext, 0) + 1
    except (OSError, PermissionError):
        pass
    return exts


def _last_commit_days(root_dir: Path) -> int:
    """Return days since last git commit, or -1 if no git."""
    if not _is_git_repo(root_dir):
        return -1
    try:
        result = subprocess.run(
            ["git", "log", "-1", "--format=%ct"],
            cwd=str(root_dir),
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return -1
        ts = int(result.stdout.strip())
        # Handle git's placeholder for unborn repos
        if ts == 0:
            return -1
        diff = (datetime.now(timezone.utc).timestamp() - ts) / 86400
        return max(0, int(diff))
    except Exception:
        return -1


def _scan_repos_in_root(root_path: str) -> list[dict[str, Any]]:
    """Scan a root directory and return a list of repo metadata dicts."""
    root = Path(os.path.expanduser(root_path))
    if not root.is_dir():
        return []

    repos: list[dict[str, Any]] = []
    try:
        children = sorted(root.iterdir(), key=lambda e: e.name.lower())
    except (OSError, PermissionError):
        return []

    for child in children:
        # Skip temp files, hidden dirs, and explicitly skipped dirs
        if child.name.startswith(".") or child.name in _SKIP_DIRS:
            continue
        if not child.is_dir():
            continue

        has_git = _is_git_repo(child)
        # Non-git dirs that are very small (no .py, no .ts, no package files) are probably not repos
        # Skip this filter — let the UI decide. A workspace folder counts as a repo for display purposes.

        repos.append(
            {
                "name": child.name,
                "path": str(child),
                "repoPath": str(child),
                "rootPath": str(root),
                "population": _count_population(child),
                "extensions": _scan_extensions(child),
                "gold": 0,
                "lastCommitDays": _last_commit_days(child),
                "isLegacy": False,
                "hasGit": has_git,
            }
        )
    return repos


# ── GET handlers ───────────────────────────────────────────────────────────────


def get_map_roots(ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /api/map-roots — return all roots + active root."""
    state = load_state()
    roots = get_roots()

    # Enrich with repoCount (scan count of each root for the UI badge)
    for r in roots:
        r["repoCount"] = len(_scan_repos_in_root(r["path"]))

    return _ok({
        "activeRoot": state.get("activeRoot", ""),
        "roots": roots,
    })


def get_map_root(ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /api/map-root — return the current active root (singular)."""
    return _ok({"path": active_root()})


def get_repo_selections(ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /api/repo-selections — return full selection state."""
    state = load_state()
    active = state.get("activeRoot", "")
    roots_data = get_roots()

    all_selected_paths: list[str] = []
    roots_out: list[dict[str, Any]] = []
    for r in roots_data:
        sel = r.get("selectedRepoPaths", [])
        all_selected_paths.extend(sel)
        roots_out.append(
            {
                "path": r["path"],
                "label": r.get("label"),
                "selectedRepoIds": [p for p in sel],
                "selectedRepoPaths": [p for p in sel],
            }
        )

    return _ok({
        "activeRoot": active,
        "roots": roots_out,
        "selectedRepoIds": [p for p in all_selected_paths if p],
        "selectedRepoPaths": [p for p in all_selected_paths if p],
        "hasSelections": len(all_selected_paths) > 0,
    })


def get_scanned_repos(ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /api/repos — return scanned repos under the active root."""
    root = active_root()
    if not root:
        return _ok({"repos": []})
    repos = _scan_repos_in_root(root)
    return _ok({"repos": repos})


def get_selected_repos(ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /api/repos/selected — return repos filtered to the active root's selection."""
    root = active_root()
    if not root:
        return _ok({"repos": []})
    repos = _scan_repos_in_root(root)
    selected = set(get_selection(root))
    filtered = [r for r in repos if r["path"] in selected]
    return _ok({"repos": filtered})


def get_all_roots_repos(ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """GET /api/repos/all-roots — scan ALL registered roots and return the union.

    Each repo dict includes ``rootPath`` so the UI can group by root.
    This is the endpoint the onboarding panel uses for true multi-root
    selection: you see repos from every folder you've added, not just
    the active one.
    """
    state = load_state()
    roots = state.get("roots", {})
    all_repos: list[dict[str, Any]] = []
    for root_path in roots:
        repos = _scan_repos_in_root(root_path)
        for r in repos:
            r["rootPath"] = root_path
        all_repos.extend(repos)
    return _ok({"repos": all_repos})


# ── POST handlers ──────────────────────────────────────────────────────────────


def post_add_map_root(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """POST /api/map-roots — add a new root."""
    path = str(body.get("path", "") or "").strip()
    if not path:
        return _error(400, "path is required")
    label = body.get("label")
    expanded = os.path.expanduser(path)

    # Validate the path exists
    if not os.path.isdir(expanded):
        return _error(400, "path does not exist", cause=str(expanded), hint="create the directory first or check the path")

    add_root(expanded, label)
    repos = _scan_repos_in_root(expanded)
    return _ok({"ok": True, "totalRepos": len(repos)})


def post_activate_map_root(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """POST /api/map-roots/activate — set active root."""
    path = str(body.get("path", "") or "").strip()
    if not path:
        return _error(400, "path is required")
    expanded = os.path.expanduser(path)
    state = load_state()
    if expanded not in state.get("roots", {}):
        # Auto-add if it exists on disk
        if not os.path.isdir(expanded):
            return _error(400, "path does not exist", cause=str(expanded))
        add_root(expanded)
    set_active_root(expanded)
    return _ok({"ok": True})


def post_remove_map_root(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """POST /api/map-roots/remove — remove a root."""
    path = str(body.get("path", "") or "").strip()
    if not path:
        return _error(400, "path is required")
    expanded = os.path.expanduser(path)
    remove_root(expanded)
    state = load_state()
    # Count total repos in remaining roots (best-effort)
    remaining_count = 0
    for r in state.get("roots", {}).keys():
        remaining_count += len(_scan_repos_in_root(r))
    return _ok({"ok": True, "totalRepos": remaining_count})


def post_pick_map_root(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """POST /api/map-roots/pick — open native folder picker (tkinter)."""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError:
        return _error(503, "folder picker not available", cause="tkinter not installed", hint="enter the path manually")

    try:
        # Run in a subprocess to avoid blocking the HTTP server
        # The folder dialog runs on the same display
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        folder = filedialog.askdirectory(
            title="Selecciona una carpeta para el mapa de RepoCiv",
            initialdir=os.path.expanduser("~"),
        )
        root.destroy()

        if not folder:
            return _ok({"ok": False, "root": "", "totalRepos": 0})

        expanded = os.path.expanduser(folder)
        add_root(expanded)
        # Make it the active root automatically
        set_active_root(expanded)
        repos = _scan_repos_in_root(expanded)
        return _ok({"ok": True, "root": expanded, "totalRepos": len(repos)})
    except Exception as e:
        return _error(500, "folder picker failed", cause=str(e))


def post_persist_selection(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """POST /api/repo-selections — persist selection for a root."""
    root_path = str(body.get("rootPath", "") or "").strip()
    repo_ids = body.get("selectedRepoIds", [])
    if not isinstance(repo_ids, list):
        repo_ids = []
    if not root_path:
        # Use the active root if not specified
        root_path = active_root()
        if not root_path:
            return _error(400, "rootPath is required (no active root set)")

    expanded = os.path.expanduser(root_path)
    set_selection(expanded, [str(p) for p in repo_ids])

    # Build the response state (same shape as get_repo_selections)
    state = load_state()
    roots_data = get_roots()
    all_selected_paths: list[str] = []
    for r in roots_data:
        sel = r.get("selectedRepoPaths", [])
        all_selected_paths.extend(sel)

    return _ok({
        "activeRoot": state.get("activeRoot", ""),
        "roots": [
            {
                "path": r["path"],
                "label": r.get("label"),
                "selectedRepoIds": r.get("selectedRepoPaths", []),
                "selectedRepoPaths": r.get("selectedRepoPaths", []),
            }
            for r in roots_data
        ],
        "selectedRepoIds": all_selected_paths,
        "selectedRepoPaths": all_selected_paths,
        "hasSelections": len(all_selected_paths) > 0,
    })


def post_add_selected_repo(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """POST /api/repo-selections/add — add a repo to the active root selection."""
    repo_id = str(body.get("repoId", "") or "").strip()
    if not repo_id:
        return _error(400, "repoId is required")
    add_selected(repo_id)

    state = load_state()
    roots_data = get_roots()
    roots_out: list[dict[str, Any]] = []
    all_selected_paths: list[str] = []
    for r in roots_data:
        sel = r.get("selectedRepoPaths", [])
        all_selected_paths.extend(sel)
        roots_out.append(
            {
                "path": r["path"],
                "label": r.get("label"),
                "selectedRepoIds": [p for p in sel],
                "selectedRepoPaths": [p for p in sel],
            }
        )
    return _ok({
        "activeRoot": state.get("activeRoot", ""),
        "roots": roots_out,
        "selectedRepoIds": all_selected_paths,
        "selectedRepoPaths": all_selected_paths,
        "hasSelections": len(all_selected_paths) > 0,
    })


def post_remove_selected_repo(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """POST /api/repo-selections/remove — remove a repo from the active root selection."""
    repo_id = str(body.get("repoId", "") or "").strip()
    if not repo_id:
        return _error(400, "repoId is required")
    remove_selected(repo_id)

    state = load_state()
    roots_data = get_roots()
    roots_out: list[dict[str, Any]] = []
    all_selected_paths: list[str] = []
    for r in roots_data:
        sel = r.get("selectedRepoPaths", [])
        all_selected_paths.extend(sel)
        roots_out.append(
            {
                "path": r["path"],
                "label": r.get("label"),
                "selectedRepoIds": [p for p in sel],
                "selectedRepoPaths": [p for p in sel],
            }
        )
    return _ok({
        "activeRoot": state.get("activeRoot", ""),
        "roots": roots_out,
        "selectedRepoIds": all_selected_paths,
        "selectedRepoPaths": all_selected_paths,
        "hasSelections": len(all_selected_paths) > 0,
    })
