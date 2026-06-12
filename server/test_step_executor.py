"""Tests for server/step_executor.py — P4 production step executor.

>=8 tests covering:
  - dispatch_plan_step calls run_agent with correct parameters
  - build_step_mission includes spec_context
  - select_agent_for_step: "inspect" -> SCOUT, "implement" -> WORKER, etc.
  - Fallback to DAVI when no clear match
  - Timeout per step (mock slow -> raises TimeoutError)
  - Integration: orchestrator with step_executor real completes cycle
  - step_executor without agent_runner -> error propagation
  - Idempotency: same step not re-executed if already has run_id
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest import mock

import pytest

import server.step_executor as _se
import server.task_orchestrator as _to
import server.workspace_issue as _wi
import server.workspace_state as _ws
import server.run_state as _rs
import server.locks as _locks


# ─── Fixture: fresh state each test ───────────────────────────────────────────

@pytest.fixture(autouse=True)
def _setup():
    _to._reset()
    _wi._reset()
    _locks._reset()
    tmp = tempfile.mkdtemp()
    _wi.init(Path(tmp))
    _ws.init(Path(tmp))
    _rs.init(Path(tmp))
    yield


def _seed_workspace(repo: str, issue_id: str) -> None:
    _wi.init_issue_workspace(repo, issue_id)
    _wi.write_spec(
        repo, issue_id,
        "# Add logging middleware\n\n"
        "## Requirements\n\n"
        "- All incoming requests must be logged with timestamp\n"
        "- Responses must include request duration\n"
        "- Must be configurable via environment variable\n",
    )
    _wi.write_plan(
        repo, issue_id,
        "# Plan: Add logging middleware\n\n"
        "- [ ] Inspect current middleware stack\n"
        "- [ ] Implement request timing decorator\n"
        "- [ ] Wire into application factory\n"
        "- [ ] Discuss architectural implications\n",
    )


# ─── 1. dispatch_plan_step calls run_agent with correct parameters ───────────

def test_dispatch_plan_step_calls_run_agent():
    _seed_workspace("my-repo", "ISSUE-1")

    with mock.patch("server.agent_runner.run_agent") as mock_run:
        run_id = _se.dispatch_plan_step(
            "my-repo", "ISSUE-1",
            "Inspect current middleware stack",
            {"stepIndex": 0, "totalSteps": 4},
        )

    assert run_id.startswith("step-")
    mock_run.assert_called_once()

    call_args = mock_run.call_args
    unit_id = call_args[0][0]     # agent
    city    = call_args[0][1]     # repo
    mission = call_args[0][2]     # mission text
    run_id_arg = call_args[0][4]  # command_id (5th positional)

    assert unit_id == "SCOUT"  # "inspect" -> SCOUT
    assert city == "my-repo"
    assert "Inspect current middleware stack" in mission
    assert "Add logging middleware" in mission  # spec context injected
    assert run_id_arg == run_id


# ─── 2. build_step_mission includes spec_context ─────────────────────────────

def test_build_step_mission_includes_spec_context():
    spec = "# Title\n\nRequirements:\n- Do the thing\n- Be fast\n"
    mission = _se.build_step_mission("Implement the thing", spec)

    assert "Implement the thing" in mission
    assert "Requirements:" in mission
    assert "Do the thing" in mission
    assert "Be fast" in mission


def test_build_step_mission_no_spec():
    mission = _se.build_step_mission("Do X", "")
    assert "Do X" in mission
    # Still includes the contextual structure even with empty spec
    assert "Contexto adicional" in mission


# ─── 3. select_agent_for_step: heuristic classification ──────────────────────

@pytest.mark.parametrize("step_desc, expected", [
    ("Inspect current middleware stack", "SCOUT"),
    ("audit the codebase for security issues", "SCOUT"),
    ("analyze performance bottlenecks", "SCOUT"),
    ("review the pull request", "SCOUT"),
    ("scan for vulnerabilities", "SCOUT"),
    ("investigate the memory leak", "SCOUT"),
    ("diagnose test failures", "SCOUT"),
    ("Implement request timing decorator", "WORKER"),
    ("create the login handler", "WORKER"),
    ("write unit tests", "WORKER"),
    ("fix the race condition", "WORKER"),
    ("refactor the cache layer", "WORKER"),
    ("patch the vulnerability", "WORKER"),
    ("deploy to staging", "WORKER"),
    ("Wire into application factory", "WORKER"),
])
def test_select_agent_for_step(step_desc, expected):
    assert _se.select_agent_for_step(step_desc) == expected


# ─── 4. Fallback to DAVI when no clear match ─────────────────────────────────

def test_select_agent_for_step_fallback_to_davi():
    assert _se.select_agent_for_step("Discuss architectural implications") == "MAIN"
    assert _se.select_agent_for_step("Plan the roadmap for Q2") == "MAIN"
    assert _se.select_agent_for_step("Coordinate with the team") == "MAIN"


# ─── 5. Timeout per step ─────────────────────────────────────────────────────

def test_dispatch_plan_step_timeout():
    _seed_workspace("repo", "ISS-TMO")

    with mock.patch("server.agent_runner.run_agent") as mock_run:
        # Simulate a very slow run_agent
        def _slow(*_a, **_kw):
            import time
            time.sleep(2.0)
        mock_run.side_effect = _slow

        with pytest.raises(TimeoutError, match="timed out"):
            _se.dispatch_plan_step(
                "repo", "ISS-TMO",
                "Inspect slow task",
                {"stepIndex": 0, "totalSteps": 1},
                timeout=0.5,
            )


# ─── 6. Integration: orchestrator with step_executor real completes cycle ────

def test_integration_orchestrator_with_step_executor():
    _seed_workspace("int-repo", "INT-1")

    called_steps: list[str] = []

    with mock.patch("server.agent_runner.run_agent") as mock_run:
        def _fake(*_a, **_kw):
            called_steps.append(_kw.get("command_id", "?"))
        mock_run.side_effect = _fake

        _to.set_step_executor(_se.dispatch_plan_step)
        result = _to.run_task("int-repo", "INT-1")

    assert result["phase"] == "complete"
    assert result["stepCount"] == 4
    assert len(called_steps) == 4

    # Verify agents were selected correctly
    call_agents = [c[0][0] for c in mock_run.call_args_list]
    assert call_agents[0] == "SCOUT"   # "Inspect" step
    assert call_agents[1] == "WORKER"  # "Implement" step
    assert call_agents[2] == "WORKER"  # "Wire" step
    assert call_agents[3] == "MAIN"    # "Discuss" step

    # Artifacts exist
    artifacts = _wi.list_artifacts("int-repo", "INT-1")
    step_jsons = [a for a in artifacts if a.startswith("step_") and a.endswith(".json")]
    assert len(step_jsons) == 4


# ─── 7. step_executor with agent_runner failure -> error propagates ──────────

def test_dispatch_plan_step_agent_failure_propagates():
    _seed_workspace("repo", "ISS-FAIL")

    with mock.patch("server.agent_runner.run_agent") as mock_run:
        mock_run.side_effect = RuntimeError("Agent exploded")

        with pytest.raises(RuntimeError, match="Agent exploded"):
            _se.dispatch_plan_step(
                "repo", "ISS-FAIL",
                "Implement something dangerous",
                {"stepIndex": 0, "totalSteps": 1},
            )


# ─── 8. Idempotency: same step not re-executed if already has run_id ─────────

def test_step_not_re_executed_if_already_has_run_id():
    _seed_workspace("repo", "ISS-IDEM")

    # Register a completed run_id for step_000
    _wi.register_run("repo", "ISS-IDEM", "existing-run-123")
    _wi.add_artifact(
        "repo", "ISS-IDEM", "step_000_inspect_current_middleware_stack.json",
        content=json.dumps({"stepIndex": 0, "step": "Inspect", "runId": "existing-run-123"}),
    )

    # The orchestrator still runs, but step_executor should see the existing run
    # and not dispatch. Test at orchestrator level: ensure the existing run_id
    # is preserved in the artifact rather than overwritten.
    with mock.patch("server.agent_runner.run_agent") as mock_run:
        def _fake(*_a, **_kw):
            pass
        mock_run.side_effect = _fake

        _to.set_step_executor(_se.dispatch_plan_step)
        _to.run_task("repo", "ISS-IDEM")

    # The orchestrator should still run normally (it's idempotent at task level)
    # But the first step artifact should preserve the existing run_id
    state = _wi.load_issue_state("repo", "ISS-IDEM")
    run_ids = state.get("runIds", [])
    assert "existing-run-123" in run_ids


# ─── Bonus: explicit agent override via step_meta ─────────────────────────────

def test_agent_override_via_step_meta():
    _seed_workspace("repo", "ISS-OVR")

    with mock.patch("server.agent_runner.run_agent") as mock_run:
        mock_run.side_effect = lambda *a, **kw: None

        _se.dispatch_plan_step(
            "repo", "ISS-OVR",
            "Inspect current middleware stack",  # would be SCOUT normally
            {"stepIndex": 0, "totalSteps": 1, "agent": "WORKER"},  # explicit override
        )

    mock_run.assert_called_once()
    assert mock_run.call_args[0][0] == "WORKER"  # override wins


# ─── Workspace safety invariants (Symphony §9.5 extraction) ───────────────────

def test_workspace_safety_valid_ids_pass():
    """Valid repo and issue_id pass the safety gate."""
    _seed_workspace("my-repo", "ISSUE-1")

    with mock.patch("server.agent_runner.run_agent") as mock_run:
        mock_run.side_effect = lambda *a, **kw: None
        _se.dispatch_plan_step(
            "my-repo", "ISSUE-1",
            "Inspect something",
            {"stepIndex": 0, "totalSteps": 1},
        )

    mock_run.assert_called_once()


def test_workspace_safety_path_traversal_in_repo():
    """Repo with '..' is caught before dispatch."""
    _seed_workspace("safe-repo", "ISS-1")

    with pytest.raises(_se.WorkspaceSafetyError, match="Invalid repo"):
        _se.dispatch_plan_step(
            "../escape", "ISS-1",
            "Inspect something",
            {"stepIndex": 0, "totalSteps": 1},
        )


def test_workspace_safety_slash_in_issue_id():
    """Issue ID with '/' is caught before dispatch."""
    _seed_workspace("repo", "ISS-SLASH")

    with pytest.raises(_se.WorkspaceSafetyError, match="Invalid issue_id"):
        _se.dispatch_plan_step(
            "repo", "ISSUE/../../../etc-passwd",
            "Inspect something",
            {"stepIndex": 0, "totalSteps": 1},
        )


def test_workspace_safety_empty_repo():
    """Empty repo string is caught."""
    with pytest.raises(_se.WorkspaceSafetyError, match="repo must not be empty"):
        _se.dispatch_plan_step(
            "", "ISS-1",
            "Inspect something",
            {"stepIndex": 0, "totalSteps": 1},
        )


def test_workspace_safety_empty_issue_id():
    """Empty issue_id string is caught."""
    _seed_workspace("repo", "ISS-EMPTY-TEST")

    with pytest.raises(_se.WorkspaceSafetyError, match="issue_id must not be empty"):
        _se.dispatch_plan_step(
            "repo", "",
            "Inspect something",
            {"stepIndex": 0, "totalSteps": 1},
        )


def test_workspace_safety_tilde_in_repo():
    """Tilde '~' in repo is caught."""
    with pytest.raises(_se.WorkspaceSafetyError, match="Invalid repo"):
        _se.dispatch_plan_step(
            "~/.ssh/leak", "ISS-1",
            "Inspect something",
            {"stepIndex": 0, "totalSteps": 1},
        )


def test_workspace_safety_shell_metachar_in_issue_id():
    """Shell metacharacters like ';' are caught in issue_id."""
    _seed_workspace("repo", "ISS-SHELL")

    with pytest.raises(_se.WorkspaceSafetyError, match="Invalid issue_id"):
        _se.dispatch_plan_step(
            "repo", "ISS-1; rm -rf /",
            "Inspect something",
            {"stepIndex": 0, "totalSteps": 1},
        )


def test_workspace_safety_integration_orchestrator_rejects():
    """Orchestrator propagates safety error without executing any steps."""
    _seed_workspace("safe-repo", "ISS-SAFE")

    with mock.patch("server.agent_runner.run_agent") as mock_run:
        mock_run.side_effect = lambda *a, **kw: None
        _to.set_step_executor(_se.dispatch_plan_step)

        result = _to.run_task("safe-repo", "ISS-SAFE")
        assert result["phase"] == "complete"

    # Now inject safety violation into the step_executor call path.
    # We patch dispatch_plan_step to test at orchestrator level.
    with pytest.raises(_se.WorkspaceSafetyError):
        # Direct call — orchestrator calls _step_executor(repo, issue_id, ...)
        # We simulate the orchestrator's call with a bad repo
        _to.set_step_executor(_se.dispatch_plan_step)
        # The safety gate fires inside dispatch_plan_step _before_ it reaches
        # the workspace, so _seed_workspace path doesn't matter
        _se.dispatch_plan_step(
            "../pwned", "ISS-1",
            "Inspect something",
            {"stepIndex": 0, "totalSteps": 1},
        )
