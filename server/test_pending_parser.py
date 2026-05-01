"""Tests dedicados al parser de PENDING_TRACKER.md (load_pending_tasks).

Verifica que todos los estilos de bullet GFM sean reconocidos,
que las tareas completadas se excluyan, y que las prioridades funcionen.
"""
import pytest
from unittest.mock import patch
from pathlib import Path
from server import bridge


def _make_tracker(tmp_path: Path, content: str) -> Path:
    p = tmp_path / "PENDING_TRACKER.md"
    p.write_text(content, encoding="utf-8")
    return p


def test_dash_bullet(tmp_path: Path) -> None:
    p = _make_tracker(tmp_path, "- [ ] tarea dash\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert len(tasks) == 1
    assert tasks[0]["title"] == "tarea dash"


def test_asterisk_bullet(tmp_path: Path) -> None:
    p = _make_tracker(tmp_path, "* [ ] tarea asterisk\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert len(tasks) == 1
    assert tasks[0]["title"] == "tarea asterisk"


def test_plus_bullet(tmp_path: Path) -> None:
    p = _make_tracker(tmp_path, "+ [ ] tarea plus\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert len(tasks) == 1
    assert tasks[0]["title"] == "tarea plus"


def test_completed_lowercase_x_excluded(tmp_path: Path) -> None:
    p = _make_tracker(tmp_path, "- [x] ya hecho\n- [ ] pendiente\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    titles = [t["title"] for t in tasks]
    assert "pendiente" in titles
    assert "ya hecho" not in titles


def test_completed_uppercase_x_excluded(tmp_path: Path) -> None:
    p = _make_tracker(tmp_path, "- [X] también hecho\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert len(tasks) == 0


def test_high_priority_exclamation(tmp_path: Path) -> None:
    p = _make_tracker(tmp_path, "- [ ] ! urgente ahora\n- [ ] normal\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    priorities = {t["title"]: t["priority"] for t in tasks}
    assert priorities.get("urgente ahora") == "high"
    assert priorities.get("normal") == "normal"


def test_high_priority_bracket_tag(tmp_path: Path) -> None:
    p = _make_tracker(tmp_path, "- [ ] [HIGH] revisar auth\n")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert tasks[0]["priority"] == "high"


def test_missing_file_returns_empty(tmp_path: Path) -> None:
    with patch.object(bridge, "PENDING_TRACKER", tmp_path / "no_existe.md"):
        tasks = bridge.load_pending_tasks()
    assert tasks == []


def test_empty_file_returns_empty(tmp_path: Path) -> None:
    p = _make_tracker(tmp_path, "")
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert tasks == []


def test_mixed_bullets_and_completed(tmp_path: Path) -> None:
    content = "- [ ] uno\n* [ ] dos\n+ [ ] tres\n- [x] skip\n# Header\nsome text\n"
    p = _make_tracker(tmp_path, content)
    with patch.object(bridge, "PENDING_TRACKER", p):
        tasks = bridge.load_pending_tasks()
    assert len(tasks) == 3
    titles = {t["title"] for t in tasks}
    assert titles == {"uno", "dos", "tres"}
