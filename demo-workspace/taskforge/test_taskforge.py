"""Tests for TaskForge (demo: one intentionally failing)."""
from taskforge import Board, Task


def test_add_and_close():
    b = Board()
    t = b.add(Task("t1", "aria", "Wire the scheduler"))
    t.close("done")
    assert t.status == "done"


def test_by_hero_case_insensitive():
    b = Board()
    b.add(Task("t2", "aria", "Fix flaky probe"))
    found = b.by_hero("Aria")  # caller uses display-case name
    assert len(found) == 1    # FAILS today: stored as "aria"


def test_duplicate_add_rejected():
    b = Board()
    b.add(Task("t3", "aria", "First"))
    try:
        b.add(Task("t3", "aria", "Dup"))
        raise AssertionError("expected KeyError")
    except KeyError:
        pass