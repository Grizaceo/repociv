"""Tests for server/kanban_reader.py — Hermes kanban read-only access."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from server import kanban_reader as kb


def _make_board(root: Path, slug: str, tasks: list[dict]) -> Path:
    """Create a board store with the given tasks; return its db path."""
    if slug == "default":
        db_path = root / "kanban.db"
    else:
        board_dir = root / "boards" / slug
        board_dir.mkdir(parents=True, exist_ok=True)
        (board_dir / "board.json").write_text(
            json.dumps({"slug": slug, "name": f"Board {slug}"}), encoding="utf-8"
        )
        db_path = board_dir / "kanban.db"
    con = sqlite3.connect(db_path)
    con.execute(
        """CREATE TABLE tasks (
            id TEXT PRIMARY KEY, title TEXT, body TEXT, assignee TEXT,
            status TEXT, priority INTEGER, created_by TEXT, created_at REAL,
            started_at REAL, completed_at REAL, last_failure_error TEXT,
            consecutive_failures INTEGER
        )"""
    )
    for t in tasks:
        con.execute(
            "INSERT INTO tasks (id, title, assignee, status, priority, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (t["id"], t["title"], t.get("assignee", ""), t["status"], t.get("priority", 0), t.get("created_at", 0.0)),
        )
    con.commit()
    con.close()
    return db_path


@pytest.fixture
def kanban_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("REPOCIV_KANBAN_DIR", str(tmp_path))
    return tmp_path


def test_get_board_groups_by_canonical_columns(kanban_root: Path) -> None:
    _make_board(kanban_root, "default", [
        {"id": "t1", "title": "Task one", "status": "todo", "priority": 10},
        {"id": "t2", "title": "Task two", "status": "running", "priority": 20},
        {"id": "t3", "title": "Task three", "status": "done", "priority": 5},
    ])
    (kanban_root / "current").write_text("default", encoding="utf-8")

    board = kb.get_board()

    assert board["available"] is True
    assert board["active"] is True
    assert [t["id"] for t in board["columns"]["todo"]] == ["t1"]
    assert [t["id"] for t in board["columns"]["running"]] == ["t2"]
    assert [t["id"] for t in board["columns"]["done"]] == ["t3"]
    # Every canonical column is present, even empty ones.
    assert set(board["columns"].keys()) == set(kb.BOARD_COLUMNS)


def test_get_board_unknown_slug_falls_back_to_active(kanban_root: Path) -> None:
    _make_board(kanban_root, "default", [{"id": "t1", "title": "T", "status": "todo"}])
    (kanban_root / "current").write_text("default", encoding="utf-8")

    board = kb.get_board("nonexistent-board")

    assert board["slug"] == "default"
    assert board["active"] is True


def test_get_board_missing_store_returns_empty(kanban_root: Path) -> None:
    (kanban_root / "current").write_text("ghost", encoding="utf-8")

    board = kb.get_board()

    assert board["available"] is False
    assert all(cols == [] for cols in board["columns"].values())


def test_list_boards_includes_counts(kanban_root: Path) -> None:
    _make_board(kanban_root, "default", [
        {"id": "t1", "title": "A", "status": "todo"},
        {"id": "t2", "title": "B", "status": "done"},
    ])
    _make_board(kanban_root, "alpha", [{"id": "t3", "title": "C", "status": "running"}])

    boards = kb.list_boards()

    slugs = {b["slug"] for b in boards}
    assert slugs == {"default", "alpha"}
    by_slug = {b["slug"]: b for b in boards}
    assert by_slug["default"]["counts"] == {"todo": 1, "done": 1}
    assert by_slug["alpha"]["counts"] == {"running": 1}
    assert by_slug["alpha"]["name"] == "Board alpha"


def test_get_board_orders_by_priority_desc(kanban_root: Path) -> None:
    _make_board(kanban_root, "default", [
        {"id": "low", "title": "Low", "status": "todo", "priority": 1},
        {"id": "high", "title": "High", "status": "todo", "priority": 100},
    ])
    (kanban_root / "current").write_text("default", encoding="utf-8")

    board = kb.get_board()

    assert [t["id"] for t in board["columns"]["todo"]] == ["high", "low"]
