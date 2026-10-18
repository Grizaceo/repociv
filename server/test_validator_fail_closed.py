"""A missing validator must block the task, never auto-pass it."""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pytest

import server
import server.locks as _locks
import server.run_state as _rs
import server.task_orchestrator as _to
import server.workspace_issue as _wi
import server.workspace_state as _ws


@pytest.fixture(autouse=True)
def _stores():
    _to._reset()
    _wi._reset()
    _locks._reset()
    tmp = Path(tempfile.mkdtemp())
    _wi.init(tmp)
    _ws.init(tmp)
    _rs.init(tmp)
    yield
    _to._reset()


def test_unavailable_validator_blocks_for_human_review(monkeypatch):
    _wi.init_issue_workspace("repo", "VAL-1")
    _wi.write_spec("repo", "VAL-1", "# Validate\n\nGoal: prove it.\n")
    _wi.write_plan("repo", "VAL-1", "# Plan\n\n- [ ] Coordinate with the team\n")
    _to.set_step_executor(lambda *a, **k: "step-ok")
    monkeypatch.delattr(server, "validator", raising=False)
    monkeypatch.setitem(sys.modules, "server.validator", None)  # import → ImportError

    state = _to.run_task("repo", "VAL-1")

    assert state["phase"] == "blocked"
    assert state.get("checkpointGate") == "post-validation"
    assert state["phase"] != "complete"
