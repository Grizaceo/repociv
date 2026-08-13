"""RepoCiv — Hermes Kanban reader (read-only).

Reads the Hermes kanban SQLite stores directly (``~/.hermes/kanban``) so the
dashboard can render the board without touching the Hermes dashboard's
session-cookie auth. The kanban is a set of SQLite files:

- ``~/.hermes/kanban/current``            — slug of the active board
- ``~/.hermes/kanban/boards/<slug>/kanban.db`` — per-board store + board.json
- ``~/.hermes/kanban/kanban.db``         — the "default" board store

Read-only by design: RepoCiv visualizes; mutations stay in the Hermes CLI
(``hermes kanban ...``) or the Hermes dashboard.
"""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

# Canonical column order — mirrors plugins/kanban/dashboard/plugin_api.py.
BOARD_COLUMNS: list[str] = [
    "triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done",
]

_TASK_FIELDS = (
    "id", "title", "status", "assignee", "priority", "created_at",
    "started_at", "completed_at", "last_failure_error", "consecutive_failures",
)


def _kanban_dir() -> Path:
    explicit = os.environ.get("REPOCIV_KANBAN_DIR", "").strip()
    base = Path(explicit).expanduser() if explicit else Path.home() / ".hermes" / "kanban"
    return base


def _current_board_slug() -> str:
    pointer = _kanban_dir() / "current"
    try:
        slug = pointer.read_text(encoding="utf-8").strip()
        if slug:
            return slug
    except OSError:
        pass
    return "default"


def _board_db_path(slug: str) -> Path:
    if slug == "default":
        return _kanban_dir() / "kanban.db"
    return _kanban_dir() / "boards" / slug / "kanban.db"


def _board_meta(slug: str) -> dict[str, Any]:
    meta_path = _kanban_dir() / "boards" / slug / "board.json"
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {"slug": slug, "name": slug}


def list_boards() -> list[dict[str, Any]]:
    """Every board on disk: slug, display name, and per-status counts."""
    boards: list[dict[str, Any]] = []
    root = _kanban_dir()
    if (root / "kanban.db").exists():
        boards.append(_board_meta("default"))
    boards_dir = root / "boards"
    if boards_dir.is_dir():
        for entry in sorted(boards_dir.iterdir()):
            if entry.is_dir() and (entry / "kanban.db").exists():
                boards.append(_board_meta(entry.name))
    for board in boards:
        board["counts"] = _status_counts(board["slug"])
    return boards


def _status_counts(slug: str) -> dict[str, int]:
    db_path = _board_db_path(slug)
    if not db_path.exists():
        return {}
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = con.execute("SELECT status, COUNT(*) FROM tasks GROUP BY status").fetchall()
            return {status: count for status, count in rows}
        finally:
            con.close()
    except sqlite3.Error:
        return {}


def get_board(slug: str = "") -> dict[str, Any]:
    """Return the board grouped by canonical column, plus board metadata.

    ``slug`` empty → the active board (``current`` pointer). Unknown slugs
    fall back to the active board. Returns ``None``-safe shape: missing
    stores yield empty columns, never an error.
    """
    active = _current_board_slug()
    target = slug or active
    db_path = _board_db_path(target)
    if not db_path.exists():
        # Unknown slug → fall back to the active board so the panel never
        # renders empty because of a stale slug.
        if target != active:
            target = active
            db_path = _board_db_path(target)
    if not db_path.exists():
        return {
            "slug": target,
            "name": target,
            "active": target == active,
            "columns": {c: [] for c in BOARD_COLUMNS},
            "available": False,
        }

    columns: dict[str, list[dict[str, Any]]] = {c: [] for c in BOARD_COLUMNS}
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute(
                f"SELECT {', '.join(_TASK_FIELDS)} FROM tasks ORDER BY priority DESC, created_at ASC"
            ).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        rows = []

    for row in rows:
        task = dict(row)
        status = task.get("status") or "todo"
        if status not in columns:
            columns[status] = []
        columns[status].append(task)

    meta = _board_meta(target)
    return {
        "slug": target,
        "name": meta.get("name", target),
        "active": target == active,
        "columns": columns,
        "available": True,
    }
