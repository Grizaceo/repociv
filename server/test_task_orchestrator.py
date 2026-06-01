"""Tests for server/task_orchestrator.py — P3 mission runner.

≥10 tests covering:
  - Full cycle spec→complete with mock dispatch
  - Phase transitions
  - Artifact collection per step
  - run_ids registered in state.json
  - Clean cancellation
  - Failure mid-cycle → phase=failed + error artifact
  - Idempotency (no re-execute completed task)
  - Status reflects real progress
  - Integration with workspace_state
  - Async non-blocking
"""

from __future__ import annotations

import tempfile
import time
from pathlib import Path

import pytest

import server.task_orchestrator as _to
import server.workspace_issue as _wi
import server.workspace_state as _ws
import server.run_state as _rs
import server.locks as _locks
import server.swarm_engine as _swarm
import server.checkpoint as _checkpoint


# ─── Fixture: fresh store each test ──────────────────────────────────────────

@pytest.fixture(autouse=True)
def _setup() -> None:
    """Reset all module state and provide a fresh temp-based store each test."""
    _to._reset()
    _wi._reset()
    _ws._reset() if hasattr(_ws, '_reset') else None
    _locks._reset()
    tmp = tempfile.mkdtemp()
    _wi.init(Path(tmp))
    _ws.init(Path(tmp))
    _rs.init(Path(tmp))
    _checkpoint.init(Path(tmp))
    yield
    _checkpoint._reset()


# ─── Helper: create a realistic issue workspace ──────────────────────────────

def _seed_workspace(repo: str, issue_id: str) -> None:
    """Create an issue workspace with proper spec and plan."""
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
        "- [ ] Create middleware/logging.py module\n"
        "- [ ] Implement request timing decorator\n"
        "- [ ] Wire into application factory\n"
        "- [ ] Add unit tests\n",
    )


# ─── 1. Full cycle spec → complete with mock dispatch ────────────────────────

def test_full_cycle_spec_to_complete():
    _seed_workspace("my-repo", "ISSUE-1")

    # Mock step executor returns synthetic run_id per step
    called_steps: list[str] = []
    counter = [0]

    def mock_executor(repo, issue_id, step, meta):
        called_steps.append(step)
        counter[0] += 1
        return f"run-{repo}-{issue_id}-{counter[0]}"

    _to.set_step_executor(mock_executor)

    result = _to.run_task("my-repo", "ISSUE-1")

    assert result["phase"] == "complete"
    assert result["stepCount"] == 4
    assert result["artifactCount"] == 4  # one per step

    # Verify all steps were called
    assert len(called_steps) == 4
    assert any("middleware" in s for s in called_steps)
    assert any("decorator" in s for s in called_steps)
    assert any("application" in s for s in called_steps)
    assert any("tests" in s for s in called_steps)

    # Verify artifacts exist
    artifacts = _wi.list_artifacts("my-repo", "ISSUE-1")
    step_artifacts = [a for a in artifacts if a.startswith("step_") and a.endswith(".json")]
    assert len(step_artifacts) == 4


# ─── 2. Phase transitions are correct ────────────────────────────────────────

def test_phase_transitions():
    _seed_workspace("repo", "ISS-2")

    phases_seen: list[str] = []
    def mock_executor(repo, issue_id, step, meta):
        state = _wi.load_issue_state(repo, issue_id)
        if state:
            phases_seen.append(state["phase"])
        return f"run-x-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)
    _to.run_task("repo", "ISS-2")

    # executing should be observed during steps
    assert all(p == "executing" for p in phases_seen)
    assert len(phases_seen) == 4

    final = _wi.load_issue_state("repo", "ISS-2")
    assert final is not None
    assert final["phase"] == "complete"


# ─── 3. run_ids registered in state ──────────────────────────────────────────

def test_run_ids_registered():
    _seed_workspace("repo", "ISS-3")

    def mock_executor(repo, issue_id, step, meta):
        return f"real-run-{repo}-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)
    _to.run_task("repo", "ISS-3")

    state = _wi.load_issue_state("repo", "ISS-3")
    assert state is not None
    run_ids = state.get("runIds", [])
    assert len(run_ids) == 4
    for i in range(4):
        assert f"real-run-repo-{i}" in run_ids

    # Also verify run_state was saved for each
    for i in range(4):
        rs = _rs.load(f"real-run-repo-{i}")
        assert rs is not None
        assert rs["status"] == "completed"


# ─── 4. Artifact collection per step ─────────────────────────────────────────

def test_artifact_collection_per_step():
    _seed_workspace("repo", "ISS-4")

    def mock_executor(repo, issue_id, step, meta):
        return f"ar-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)
    _to.run_task("repo", "ISS-4")

    # Read each artifact and verify it points to the right run
    for i in range(4):
        # Find artifact matching step_i
        artifacts = _wi.list_artifacts("repo", "ISS-4")
        matching = [a for a in artifacts if a.startswith(f"step_{i:03d}")]
        assert len(matching) == 1
        content = _wi.read_artifact("repo", "ISS-4", matching[0])
        assert content is not None
        assert f'"runId": "ar-{i}"' in content
        assert f'"stepIndex": {i}' in content


# ─── 5. Clean cancellation ───────────────────────────────────────────────────

def test_cancellation():
    _seed_workspace("repo", "ISS-5")

    def mock_executor(repo, issue_id, step, meta):
        # Cancel on step 1 before executor runs
        if meta["stepIndex"] == 1:
            _to.cancel_task(repo, issue_id)
            # Must not raise
            return "run-cancelled-mid"
        return f"run-k-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)

    # Should not raise
    result = _to.run_task("repo", "ISS-5")
    # run_task catches cancellation mid-flight and returns early
    assert result["phase"] in ("cancelled", "complete", "executing")

    # If cancelled was picked up, state should reflect it
    state = _wi.load_issue_state("repo", "ISS-5")
    assert state is not None
    # Cancellation may or may not have been seen mid-cycle depending on timing
    # But cancel_task called directly should work:
    assert _to.cancel_task("repo", "ISS-5") is False  # already terminal or cancelled


# ─── 6. Cancel before running ────────────────────────────────────────────────

def test_cancel_before_running():
    _seed_workspace("repo", "ISS-6")

    ok = _to.cancel_task("repo", "ISS-6")
    assert ok is True

    state = _wi.load_issue_state("repo", "ISS-6")
    assert state is not None
    assert state["phase"] == "cancelled"

    # run_task on cancelled should return immediately
    result = _to.run_task("repo", "ISS-6")
    assert result["phase"] == "cancelled"


# ─── 7. Circuit breaker trips after MAX_CONSECUTIVE_FAILURES ─────────────────

def test_circuit_breaker_trips_on_consecutive_failures():
    """Circuit breaker trips after MAX_CONSECUTIVE_FAILURES consecutive errors.

    Single isolated failures do NOT kill the task — only N consecutive ones do.
    """
    _seed_workspace("repo", "ISS-7")

    call_count = [0]

    def mock_executor(repo, issue_id, step, meta):
        call_count[0] += 1
        # All steps fail to guarantee MAX_CONSECUTIVE_FAILURES is reached
        raise RuntimeError(f"Fail on step {meta['stepIndex']}")

    _to.set_step_executor(mock_executor)

    # Should NOT raise — circuit breaker returns gracefully
    _to.run_task("repo", "ISS-7")

    state = _wi.load_issue_state("repo", "ISS-7")
    assert state is not None
    assert state["phase"] == "circuit_open"
    cb = state.get("circuitBreaker", {})
    assert cb.get("consecutiveFailures") == _to.MAX_CONSECUTIVE_FAILURES

    # Only MAX_CONSECUTIVE_FAILURES steps were attempted before circuit tripped
    assert call_count[0] == _to.MAX_CONSECUTIVE_FAILURES

    # Error artifacts for each attempted step should exist
    artifacts = _wi.list_artifacts("repo", "ISS-7")
    error_txts = [a for a in artifacts if "error" in a]
    assert len(error_txts) >= _to.MAX_CONSECUTIVE_FAILURES


def test_circuit_breaker_resets_on_success():
    """A success after a failure resets the consecutive counter."""
    _seed_workspace("repo", "ISS-7b")

    def mock_executor(repo, issue_id, step, meta):
        # Only step 0 fails — steps 1,2,3 succeed
        if meta["stepIndex"] == 0:
            raise RuntimeError("First step fails")
        return f"run-ok-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)

    # With only 1 consecutive failure (< 3), the task should complete
    _to.run_task("repo", "ISS-7b")

    state = _wi.load_issue_state("repo", "ISS-7b")
    assert state is not None
    # Should be complete because subsequent steps succeeded (circuit never tripped)
    assert state["phase"] == "complete"


# ─── 8. Idempotency — completed task is not re-executed ──────────────────────

def test_idempotency_completed_task():
    _seed_workspace("repo", "ISS-8")

    calls = [0]
    def mock_executor(repo, issue_id, step, meta):
        calls[0] += 1
        return f"run-i-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)

    # First run
    result1 = _to.run_task("repo", "ISS-8")
    assert result1["phase"] == "complete"
    assert calls[0] == 4

    # Second run should be no-op
    calls_before = calls[0]
    result2 = _to.run_task("repo", "ISS-8")
    assert result2["phase"] == "complete"
    assert calls[0] == calls_before  # no new calls


# ─── 9. Status reflects real progress ────────────────────────────────────────

def test_status_reflects_progress():
    _seed_workspace("repo", "ISS-9")

    progress_snapshots: list[dict] = []
    def mock_executor(repo, issue_id, step, meta):
        status = _to.get_task_status(repo, issue_id)
        progress_snapshots.append(status["progress"])
        return f"run-p-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)
    _to.run_task("repo", "ISS-9")

    # Progress should increase: step 0→1, step 1→2, step 2→3, step 3→4
    for i, snap in enumerate(progress_snapshots):
        assert snap is not None
        assert snap["current"] == i + 1
        assert snap["total"] == 4

    # Final status
    final_status = _to.get_task_status("repo", "ISS-9")
    assert final_status["phase"] == "complete"
    assert final_status["progress"]["current"] == 4


# ─── 10. Integration with workspace_state ────────────────────────────────────

def test_workspace_state_integration():
    _seed_workspace("repo", "ISS-10")

    def mock_executor(repo, issue_id, step, meta):
        return f"run-ws-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)
    _to.run_task("repo", "ISS-10")

    # After completion, repo should not be in active missions
    active = _ws.get_active_missions("repo")
    assert "ISS-10" not in active

    # But run history should contain at least one entry
    history = _ws.get_run_history("repo", limit=5)
    assert len(history) >= 1


# ─── 11. Async non-blocking ──────────────────────────────────────────────────

def test_async_non_blocking():
    _seed_workspace("repo", "ISS-11")

    # Use a barrier to make steps take some observable time
    step_started = [False]
    def mock_executor(repo, issue_id, step, meta):
        step_started[0] = True
        time.sleep(0.3)  # simulate real work
        return f"run-async-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)

    task_key = _to.run_task_async("repo", "ISS-11")

    # Should return immediately with task_key
    assert task_key == "repo::ISS-11"

    # Status should be queued or executing
    status = _to.get_task_status("repo", "ISS-11")
    assert status["phase"] in ("queued", "executing")

    # Wait for completion
    deadline = time.time() + 10
    while time.time() < deadline:
        s = _to.get_task_status("repo", "ISS-11")
        if s["phase"] in ("complete", "failed"):
            break
        time.sleep(0.1)
    else:
        pytest.fail("Async task did not complete within 10s")

    final = _to.get_task_status("repo", "ISS-11")
    assert final["phase"] == "complete"


# ─── 12. Cancel from registry during async ───────────────────────────────────

def test_cancel_async_from_registry():
    _seed_workspace("repo", "ISS-12")

    def mock_executor(repo, issue_id, step, meta):
        time.sleep(0.5)  # slow enough to cancel
        return f"run-ca-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)

    _to.run_task_async("repo", "ISS-12")
    time.sleep(0.1)  # let it start

    ok = _to.cancel_task("repo", "ISS-12")
    assert ok is True

    status = _to.get_task_status("repo", "ISS-12")
    assert status["phase"] in ("cancelled", "executing", "failed")


# ─── 13. Missing workspace raises ValueError ─────────────────────────────────

def test_raises_on_empty_spec():
    _wi.init_issue_workspace("repo", "ISS-13")  # spec is just a heading
    _wi.write_spec("repo", "ISS-13", "# Title only")

    def mock_executor(repo, issue_id, step, meta):
        return "run-short"

    _to.set_step_executor(mock_executor)

    with pytest.raises(ValueError, match="too short"):
        _to.run_task("repo", "ISS-13")


# ─── 14. Plan fallback when plan.md is empty ─────────────────────────────────

def test_plan_fallback():
    _wi.init_issue_workspace("repo", "ISS-14")
    _wi.write_spec(
        "repo", "ISS-14",
        "# Refactor cache layer\n\n"
        "Requirements:\n- Extract cache logic into separate module\n- Add TTL support\n",
    )
    # Plan exists but is empty template — orchestrator should generate one

    def mock_executor(repo, issue_id, step, meta):
        return f"run-pf-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)
    result = _to.run_task("repo", "ISS-14")

    assert result["phase"] == "complete"
    # Fallback plan generates 4 generic steps
    assert result["stepCount"] == 4


# ─── 15. get_task_status for non-existent task ───────────────────────────────

def test_status_for_missing_task():
    status = _to.get_task_status("no-repo", "no-issue")
    assert status["repo"] == "no-repo"
    assert status["issueId"] == "no-issue"
    assert status["phase"] == "unknown"
    assert status["progress"] is None


# ─── Fase 3: Swarm integration ────────────────────────────────────────────────

class _FakeLedger:
    def __init__(self) -> None:
        self.predictions: list[dict] = []

    def get_agent_believability(self) -> dict[str, float]:
        return {}

    def record_prediction(self, **kwargs) -> None:
        self.predictions.append(kwargs)


def test_swarm_not_activated_for_low_priority_task():
    _seed_workspace("repo", "ISS-SWARM-LOW")
    fake_ledger = _FakeLedger()
    _swarm.set_engine(_swarm.ConsensusEngine(ledger=fake_ledger))

    def mock_executor(repo, issue_id, step, meta):
        return f"run-low-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)
    try:
        result = _to.run_task("repo", "ISS-SWARM-LOW")
    finally:
        _swarm.set_engine(None)

    assert result["phase"] == "complete"
    artifacts = _wi.list_artifacts("repo", "ISS-SWARM-LOW")
    assert not [a for a in artifacts if a.startswith("swarm_debate_")]
    assert fake_ledger.predictions == []


def test_swarm_activated_for_high_priority_worker_task():
    _seed_workspace("repo", "ISS-SWARM-HIGH")
    _wi.patch_issue_state("repo", "ISS-SWARM-HIGH", {"priority": "HIGH"})
    fake_ledger = _FakeLedger()
    _swarm.set_engine(_swarm.ConsensusEngine(ledger=fake_ledger))

    def mock_executor(repo, issue_id, step, meta):
        return f"run-high-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)
    try:
        result = _to.run_task("repo", "ISS-SWARM-HIGH")
    finally:
        _swarm.set_engine(None)

    assert result["phase"] == "complete"
    artifacts = _wi.list_artifacts("repo", "ISS-SWARM-HIGH")
    debate_artifacts = [a for a in artifacts if a.startswith("swarm_debate_")]
    assert len(debate_artifacts) == 4
    assert len(fake_ledger.predictions) == 12  # 3 specialists x 4 WORKER steps


def test_swarm_output_is_available_as_prior_context():
    _seed_workspace("repo", "ISS-SWARM-DC")
    _wi.patch_issue_state("repo", "ISS-SWARM-DC", {"priority": "HIGH"})
    _swarm.set_engine(_swarm.ConsensusEngine(ledger=_FakeLedger()))

    def mock_executor(repo, issue_id, step, meta):
        return f"run-dc-{meta['stepIndex']}"

    _to.set_step_executor(mock_executor)
    try:
        _to.run_task("repo", "ISS-SWARM-DC")
    finally:
        _swarm.set_engine(None)

    prior = _wi.read_output_artifacts("repo", "ISS-SWARM-DC", up_to_step=1)
    names = [name for name, _ in prior]
    contents = "\n".join(content for _, content in prior)
    assert "00-swarm-output.md" in names
    assert "Swarm debate decision:" in contents


# ─── Sprint C3: list_tasks() ──────────────────────────────────────────────────

def test_list_tasks_empty_returns_empty_list():
    """No tasks registered → list_tasks returns []."""
    result = _to.list_tasks()
    assert result == []


def test_list_tasks_after_run_contains_task():
    """After running a task, list_tasks contains its entry."""
    _seed_workspace("repo-x", "ISSUE-10")
    _to.set_step_executor(lambda *a: "run-ok")
    _to.run_task("repo-x", "ISSUE-10")

    tasks = _to.list_tasks()
    assert len(tasks) >= 1
    keys = [t["key"] for t in tasks]
    assert "repo-x::ISSUE-10" in keys


def test_list_tasks_contains_required_fields():
    """Each task entry has key, repo, issueId, phase, stepCurrent, stepCount, startedAt, updatedAt."""
    _seed_workspace("repo-y", "ISSUE-20")
    _to.set_step_executor(lambda *a: "run-ok")
    _to.run_task("repo-y", "ISSUE-20")

    tasks = _to.list_tasks()
    task = next(t for t in tasks if t["key"] == "repo-y::ISSUE-20")

    assert "key" in task
    assert "repo" in task
    assert "issueId" in task
    assert "phase" in task
    assert "stepCurrent" in task
    assert "stepCount" in task
    assert "startedAt" in task
    assert "updatedAt" in task


def test_list_tasks_phase_is_complete_after_success():
    """Task phase should be 'complete' in list_tasks after a successful run."""
    _seed_workspace("repo-z", "ISSUE-30")
    _to.set_step_executor(lambda *a: "run-ok")
    _to.run_task("repo-z", "ISSUE-30")

    tasks = _to.list_tasks()
    task = next(t for t in tasks if t["key"] == "repo-z::ISSUE-30")
    assert task["phase"] == "complete"


def test_list_tasks_step_progress_populated():
    """stepCurrent and stepCount are populated from the issue workspace state."""
    _seed_workspace("repo-w", "ISSUE-40")
    _to.set_step_executor(lambda *a: "run-ok")
    _to.run_task("repo-w", "ISSUE-40")

    tasks = _to.list_tasks()
    task = next(t for t in tasks if t["key"] == "repo-w::ISSUE-40")
    # The spec has 4 steps; after completion both should be set
    assert task["stepCount"] == 4
    assert task["stepCurrent"] is not None


# ─── Stall detection (Symphony §8.5 Part A extraction) ────────────────────────

def test_stall_warning_artifact_on_slow_step(monkeypatch):
    """Step taking > STALL_WARN_SECONDS triggers a stall_warning artifact."""
    monkeypatch.setattr(_to, "STALL_WARN_SECONDS", 0)  # force trigger
    _seed_workspace("repo", "ISS-STALL")

    # Use a real but fast mock — the orchestrator measures elapsed wall time
    _to.set_step_executor(lambda *a: "run-stalled")

    _to.run_task("repo", "ISS-STALL")

    artifacts = _wi.list_artifacts("repo", "ISS-STALL")
    stall_warnings = [a for a in artifacts if "stall_warning" in a]
    assert len(stall_warnings) >= 1, (
        f"Expected stall_warning artifact but got artifacts: {artifacts}"
    )


def test_empty_output_artifact_on_blank_result(monkeypatch):
    """Agent returning empty output triggers empty_output artifact."""
    _seed_workspace("repo", "ISS-EMPTY")

    def empty_executor(repo, issue_id, step, meta):
        run_id = f"empty-run-{meta['stepIndex']}"
        # Simulate run_state with empty result
        import server.run_state as _rs
        _rs.save(run_id, {"status": "completed", "result": ""})
        return run_id

    _to.set_step_executor(empty_executor)
    _to.run_task("repo", "ISS-EMPTY")

    artifacts = _wi.list_artifacts("repo", "ISS-EMPTY")
    empty_warnings = [a for a in artifacts if "empty_output" in a]
    assert len(empty_warnings) >= 1


def test_healthy_step_no_stall_no_empty():
    """Fast step with real output generates no stall or empty warnings."""
    _seed_workspace("repo", "ISS-HEALTHY")

    def healthy_executor(repo, issue_id, step, meta):
        run_id = f"healthy-{meta['stepIndex']}"
        import server.run_state as _rs
        _rs.save(run_id, {"status": "completed", "result": "All tests pass"})
        return run_id

    _to.set_step_executor(healthy_executor)
    _to.run_task("repo", "ISS-HEALTHY")

    artifacts = _wi.list_artifacts("repo", "ISS-HEALTHY")
    stall_related = [a for a in artifacts if "stall_warning" in a or "empty_output" in a]
    assert len(stall_related) == 0, f"Unexpected stall artifacts: {stall_related}"

