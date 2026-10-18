"""Crash-safe replacement: old or new content, never a truncated store."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from server import atomic_io


def test_new_file_is_private_and_complete(tmp_path: Path):
    target = tmp_path / "nested" / "queue.json"
    atomic_io.atomic_write_json(target, [{"id": "a"}], durable=True, indent=2)
    assert json.loads(target.read_text()) == [{"id": "a"}]
    assert target.stat().st_mode & 0o777 == 0o600


def test_existing_mode_is_preserved(tmp_path: Path):
    target = tmp_path / "missions.json"
    target.write_text("[]")
    target.chmod(0o644)
    atomic_io.atomic_write_json(target, [1, 2])
    assert target.stat().st_mode & 0o777 == 0o644
    assert json.loads(target.read_text()) == [1, 2]


def test_failed_replace_keeps_old_content_and_leaves_no_temp(tmp_path: Path, monkeypatch):
    target = tmp_path / "token_usage.json"
    target.write_text('{"old": true}')

    def boom(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(atomic_io.os, "replace", boom)
    with pytest.raises(OSError):
        atomic_io.atomic_write_json(target, {"new": True})
    assert json.loads(target.read_text()) == {"old": True}
    assert sorted(os.listdir(tmp_path)) == ["token_usage.json"]


def test_scheduler_queue_and_missions_use_atomic_writes():
    """The two stores whose corruption silently empties state (queue, missions)."""
    root = Path(__file__).parent
    for name in ("scheduler.py", "missions_store.py"):
        source = (root / name).read_text(encoding="utf-8")
        assert "atomic_write_json(" in source and ".write_text(json.dumps" not in source, name
