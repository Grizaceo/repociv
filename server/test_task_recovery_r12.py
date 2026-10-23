"""R12 end to end: tasks left in flight are reconciled at startup, never replayed."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

import server.agent_processes as _ap
import server.build_identity as _bi
import server.checkpoint as _cp
import server.event_store as _es
import server.locks as _locks
import server.task_orchestrator as _to
import server.task_recovery as _tr
import server.workspace_issue as _wi


@pytest.fixture(autouse=True)
def _stores(tmp_path: Path):
    _to._reset()
    _wi._reset()
    _locks._reset()
    _wi.init(tmp_path)
    _cp.init(tmp_path)
    _es.init(tmp_path)
    yield
    _to._reset()
    _cp._reset()


def _issue(repo: str, issue: str, phase: str, **extra) -> None:
    _wi.init_issue_workspace(repo, issue)
    _wi.patch_issue_state(repo, issue, {"phase": phase, **extra})


def test_in_flight_task_becomes_interrupted_and_is_never_replayed():
    _issue("repo", "LIVE-1", "executing", runIds=["step-aaaa"])
    _issue("repo", "GATED-1", "blocked", checkpointGate="post-plan")
    _issue("repo", "DONE-1", "complete")
    calls: list[tuple] = []
    _to.set_step_executor(lambda *a, **k: calls.append(a) or "step-new")

    view = _tr.reconcile_on_startup()

    phases = {t["taskKey"]: t["recoveryPhase"] for t in view["tasks"]}
    assert phases == {"repo::LIVE-1": "interrupted", "repo::GATED-1": "blocked"}
    assert view["autoResume"] is False
    assert _to.get_task_status("repo", "LIVE-1")["phase"] == "interrupted"
    assert _to.interrupted_tasks() == ["repo::LIVE-1"]
    assert _bi.interrupted_task_count() == 1

    result = _to.run_task("repo", "LIVE-1")
    assert result["phase"] == "interrupted" and result["resumeAvailable"] is False
    assert _to.run_task_async("repo", "LIVE-1") == "repo::LIVE-1"
    assert _to.get_task_status("repo", "LIVE-1")["phase"] == "interrupted"
    assert calls == []  # no step was dispatched again
    # Disk state is untouched: reconciliation is read-only.
    assert (_wi.load_issue_state("repo", "LIVE-1") or {})["phase"] == "executing"
    assert _tr.resume_interrupted_task("repo", "LIVE-1")["resumed"] is False


def test_operator_cancel_releases_the_interrupted_guard():
    _issue("repo", "LIVE-2", "executing")
    _tr.reconcile_on_startup()
    assert _to.cancel_task("repo", "LIVE-2") is True
    assert _to.interrupted_tasks() == []
    assert _to.get_task_status("repo", "LIVE-2")["phase"] == "cancelled"


def test_surviving_owned_process_is_correlated_by_identity():
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    try:
        _ap.record_process_binding(child.pid, "step-live", "WORKER")
        _issue("repo", "LIVE-3", "executing", runIds=["step-live", "step-unknown"])
        view = _tr.reconcile_on_startup()
        (task,) = [t for t in view["tasks"] if t["issueId"] == "LIVE-3"]
        assert task["ownedSurvivingWork"] is True
        assert [p["pid"] for p in task["survivingProcesses"]] == [child.pid]
        assert task["unresolvedIdentityRunIds"] == ["step-unknown"]
    finally:
        child.kill()
        child.wait(timeout=5)


def test_malformed_store_entries_are_skipped_not_fatal(tmp_path: Path):
    _issue("repo", "OK-1", "executing")
    bad = tmp_path / "workspaces" / "repo" / ".hidden-issue"
    bad.mkdir(parents=True)
    (bad / "state.json").write_text('{"phase": "executing"}', encoding="utf-8")
    view = _tr.build_recovery_view()
    assert [t["issueId"] for t in view["tasks"]] == ["OK-1"]
    assert view["skippedMalformed"] == 1
