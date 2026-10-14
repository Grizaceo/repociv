"""R16 — direct red/green demonstration against the pre-R16 helpers.

This module deliberately reimplements the *old* path construction
verbatim (raw join in checkpoint, separator folding only in
workspace_issue) so the escape can be shown as a red result against the
current confined helpers without depending on module internals.

Everything runs inside per-test scratch roots (TMPDIR isolation).
"""
from __future__ import annotations

from pathlib import Path

import pytest

import server.checkpoint as cp
import server.workspace_issue as wi
import server.locks as _locks
from server.identifiers import IdentifierError


def _old_checkpoint_path(root: Path, repo: str, issue_id: str) -> Path:
    """checkpoint.py:61-62 before R16 — raw join, no validation."""
    return root / repo / f"{issue_id}.json"


def _old_issue_dir(root: Path, repo: str, issue_id: str) -> Path:
    """workspace_issue.py:36-42 before R16 — separator folding only."""
    return root / repo.replace("/", "_").replace("\\", "_") / \
        issue_id.replace("/", "_").replace("\\", "_")


def test_red_old_checkpoint_construction_escapes(tmp_path):
    root = tmp_path / "checkpoints"
    escaped = _old_checkpoint_path(root, "..", "ISS-1").resolve()
    assert escaped == (tmp_path / "ISS-1.json").resolve()
    assert escaped not in root.resolve().parents
    assert root.resolve() not in escaped.parents


def test_red_old_workspace_issue_construction_escapes(tmp_path):
    root = tmp_path / "workspaces"
    escaped = _old_issue_dir(root, "..", "ISS-1").resolve()
    assert escaped == (tmp_path / "ISS-1").resolve()
    assert root.resolve() not in escaped.parents


def test_green_confined_checkpoint_rejects_the_same_token(tmp_path):
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(cp, "_CHECKPOINTS_DIR", tmp_path / "checkpoints", raising=False)
        with pytest.raises(IdentifierError):
            cp.save_checkpoint("..", "ISS-1", {"stepIndex": 0})
        assert not (tmp_path / "ISS-1.json").exists()


def test_green_confined_workspace_issue_rejects_the_same_token(tmp_path):
    wi._reset()
    _locks._reset()
    try:
        wi.init(tmp_path / "store")
        with pytest.raises(IdentifierError):
            wi.init_issue_workspace("..", "ISS-1")
        assert not (tmp_path / "store" / "ISS-1").exists()
    finally:
        wi._reset()
        _locks._reset()
