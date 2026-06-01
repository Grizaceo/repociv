"""Tests for server/checkpoint.py — D1 task snapshot/checkpoint.

≥8 tests covering:
  - save/load round-trip
  - atomic write (tmp file then rename)
  - load non-existent returns None
  - delete removes the file
  - delete on non-existent is silent
  - resuming from saved step index
  - overwrite an existing checkpoint
  - load returns None on corrupt file
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

import server.checkpoint as cp


# ─── Fixture: redirect checkpoints to a temp directory ───────────────────────

@pytest.fixture(autouse=True)
def _tmp_dir(tmp_path: Path):
    """Redirect _CHECKPOINTS_DIR to a temporary directory per test."""
    with patch.object(cp, "_CHECKPOINTS_DIR", tmp_path / "checkpoints"):
        yield


# ─── Tests ────────────────────────────────────────────────────────────────────

def test_save_load_round_trip():
    """Saved state can be loaded back unchanged."""
    state = {"stepIndex": 2, "stepCount": 5, "repo": "my-repo", "issueId": "ISSUE-1"}
    cp.save_checkpoint("my-repo", "ISSUE-1", state)
    loaded = cp.load_checkpoint("my-repo", "ISSUE-1")
    assert loaded == state


def test_load_nonexistent_returns_none():
    """load_checkpoint returns None when no checkpoint file exists."""
    result = cp.load_checkpoint("no-repo", "ISSUE-999")
    assert result is None


def test_delete_removes_file():
    """delete_checkpoint removes the persisted file."""
    cp.save_checkpoint("repo-x", "ISSUE-2", {"stepIndex": 0})
    path = cp._checkpoint_path("repo-x", "ISSUE-2")
    assert path.exists()
    cp.delete_checkpoint("repo-x", "ISSUE-2")
    assert not path.exists()


def test_delete_nonexistent_is_silent():
    """delete_checkpoint does not raise when the file does not exist."""
    cp.delete_checkpoint("ghost-repo", "GHOST-1")  # should not raise


def test_atomic_write_no_tmp_files_left():
    """After save, no .tmp files should remain in the checkpoint directory."""
    cp.save_checkpoint("repo-a", "ISSUE-3", {"stepIndex": 1})
    parent = cp._checkpoint_path("repo-a", "ISSUE-3").parent
    tmp_files = list(parent.glob("*.tmp"))
    assert tmp_files == [], f"Leftover tmp files: {tmp_files}"


def test_atomic_write_file_is_valid_json():
    """The checkpoint file must be parseable JSON."""
    state = {"stepIndex": 3, "savedAt": "2026-05-01T00:00:00Z"}
    cp.save_checkpoint("repo-b", "ISSUE-4", state)
    path = cp._checkpoint_path("repo-b", "ISSUE-4")
    raw = path.read_text(encoding="utf-8")
    parsed = json.loads(raw)
    assert parsed["stepIndex"] == 3


def test_overwrite_checkpoint():
    """Saving a checkpoint twice overwrites the previous one."""
    cp.save_checkpoint("repo-c", "ISSUE-5", {"stepIndex": 0})
    cp.save_checkpoint("repo-c", "ISSUE-5", {"stepIndex": 4})
    loaded = cp.load_checkpoint("repo-c", "ISSUE-5")
    assert loaded is not None
    assert loaded["stepIndex"] == 4


def test_load_corrupt_file_returns_none():
    """load_checkpoint returns None if the file is not valid JSON."""
    path = cp._checkpoint_path("repo-d", "ISSUE-6")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("NOT JSON {{{{", encoding="utf-8")
    result = cp.load_checkpoint("repo-d", "ISSUE-6")
    assert result is None


def test_resume_step_index():
    """Saved stepIndex can be used to resume from the next step."""
    cp.save_checkpoint("repo-e", "ISSUE-7", {"stepIndex": 2, "stepCount": 5})
    ckpt = cp.load_checkpoint("repo-e", "ISSUE-7")
    assert ckpt is not None
    resume_from = ckpt["stepIndex"] + 1
    assert resume_from == 3


def test_checkpoints_isolated_per_issue():
    """Different issue_ids are stored independently."""
    cp.save_checkpoint("repo-f", "ISSUE-A", {"stepIndex": 0})
    cp.save_checkpoint("repo-f", "ISSUE-B", {"stepIndex": 7})
    a = cp.load_checkpoint("repo-f", "ISSUE-A")
    b = cp.load_checkpoint("repo-f", "ISSUE-B")
    assert a is not None and a["stepIndex"] == 0
    assert b is not None and b["stepIndex"] == 7
    # Delete one does not affect the other
    cp.delete_checkpoint("repo-f", "ISSUE-A")
    assert cp.load_checkpoint("repo-f", "ISSUE-A") is None
    assert cp.load_checkpoint("repo-f", "ISSUE-B") is not None
