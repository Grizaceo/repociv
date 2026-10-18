"""R03 end to end: a step deadline stops the owned agent session, truthfully.

The fake ``run_agent`` spawns a real inert child exactly like the adapters do
(``start_new_session=True`` + ``agent_runner._bind_owned_process``) and then
blocks on it. No live RepoCiv process or provider is involved.
"""
from __future__ import annotations

import ast
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest import mock

import pytest

import server.agent_runner as _ar
import server.locks as _locks
import server.process_control as _pc
import server.run_state as _rs
import server.step_executor as _se
import server.step_retry as _sr
import server.task_orchestrator as _to
import server.workspace_issue as _wi
import server.workspace_state as _ws

MAIN_STEP = "Coordinate with the team"  # select_agent_for_step → MAIN (no retry)


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    _to._reset()
    _wi._reset()
    _locks._reset()
    _pc._reset()
    tmp = Path(tempfile.mkdtemp())
    _wi.init(tmp)
    _ws.init(tmp)
    _rs.init(tmp)
    _wi.init_issue_workspace("repo", "R03")
    _wi.write_spec("repo", "R03", "# R03\n\nStop hung steps.\n")
    monkeypatch.setattr(_pc, "TERM_GRACE_SECONDS", 1.0)
    monkeypatch.setattr(_pc, "KILL_GRACE_SECONDS", 1.0)
    monkeypatch.setattr(_pc, "CLEANUP_BUDGET_SECONDS", 3.0)
    yield
    _pc._reset()


@pytest.fixture
def events(monkeypatch):
    captured: list[tuple[str, dict]] = []
    monkeypatch.setattr("server.event_store.record_event",
                        lambda etype, data, *a, **kw: captured.append((etype, data)))
    return captured


@pytest.fixture
def children():
    spawned: list[subprocess.Popen] = []
    yield spawned
    for proc in spawned:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)


def _hanging_runner(children, *, linger_after_exit: float = 0.0):
    def run_agent(unit_id, city_id, mission, agent_type, command_id, *a, **kw):
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(120)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        children.append(proc)
        _ar._bind_owned_process(proc, command_id, unit_id)
        proc.wait()
        if linger_after_exit:
            time.sleep(linger_after_exit)
    return run_agent


def test_deadline_stops_owned_session_within_budget(events, children):
    with mock.patch("server.agent_runner.run_agent", side_effect=_hanging_runner(children)):
        started = time.monotonic()
        with pytest.raises(_se.StepTimeoutError) as info:
            _se.dispatch_plan_step("repo", "R03", MAIN_STEP,
                                   {"stepIndex": 0, "totalSteps": 1}, timeout=1)
        elapsed = time.monotonic() - started

    err = info.value
    assert err.stop_report.confirmed and not err.stop_report.unconfirmed
    assert err.retryable is True
    assert "agent stopped" in str(err)
    # deadline + TERM grace + cleanup budget, never the child's 120 s.
    assert elapsed < 1 + _pc.TERM_GRACE_SECONDS + _pc.CLEANUP_BUDGET_SECONDS + 2
    assert children and children[0].wait(timeout=2) is not None
    timed_out = [data for etype, data in events if etype == "StepTimedOut"]
    assert len(timed_out) == 1
    assert timed_out[0]["stopRequested"] and timed_out[0]["stopConfirmed"]
    assert timed_out[0]["runnerFinished"] is True


def test_runner_still_busy_after_confirmed_stop_is_not_retryable(events, children):
    runner = _hanging_runner(children, linger_after_exit=10)
    with mock.patch("server.agent_runner.run_agent", side_effect=runner):
        with pytest.raises(_se.StepTimeoutError) as info:
            _se.dispatch_plan_step("repo", "R03", MAIN_STEP,
                                   {"stepIndex": 0, "totalSteps": 1}, timeout=1)
    assert info.value.stop_report.confirmed
    assert info.value.retryable is False
    assert [d["runnerFinished"] for e, d in events if e == "StepTimedOut"] == [False]


def test_no_local_process_is_reported_unconfirmed(events, monkeypatch):
    monkeypatch.setattr(_pc, "CLEANUP_BUDGET_SECONDS", 0.2)
    with mock.patch("server.agent_runner.run_agent", side_effect=lambda *a, **k: time.sleep(3)):
        with pytest.raises(_se.StepTimeoutError) as info:
            _se.dispatch_plan_step("repo", "R03", MAIN_STEP,
                                   {"stepIndex": 0, "totalSteps": 1}, timeout=1)
    report = info.value.stop_report
    assert report.unconfirmed and not report.confirmed
    assert report.reason == "no-owned-local-process"
    assert info.value.retryable is False
    assert "stop unconfirmed" in str(info.value)


def test_retry_step_never_overlaps_an_unresolved_attempt(monkeypatch):
    monkeypatch.setattr(_sr, "_backoff", lambda _attempt: 0)
    calls: list[int] = []
    report = _pc.StopReport("x", requested=True, unconfirmed=True, reason="no-owned-local-process")

    def unresolved(*_a):
        calls.append(1)
        raise _se.StepTimeoutError("hung", report, retryable=False)

    with pytest.raises(_se.StepTimeoutError):
        _sr.retry_step(unresolved, "repo", "R03", "step", {}, max_retries=2)
    assert len(calls) == 1

    calls.clear()

    def stopped(*_a):
        calls.append(1)
        raise _se.StepTimeoutError("stopped", report, retryable=True)

    with pytest.raises(_se.StepTimeoutError):
        _sr.retry_step(stopped, "repo", "R03", "step", {}, max_retries=2)
    assert len(calls) == 3


def test_every_agent_adapter_spawns_an_owned_sanitized_session():
    """Static contract: each adapter Popen leads its own session (stoppable
    without touching the bridge's group) and receives a sanitized env."""
    tree = ast.parse(Path(_ar.__file__).read_text(encoding="utf-8"))
    calls = [n for n in ast.walk(tree)
             if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
             and n.func.attr == "Popen"]
    assert len(calls) >= 6
    for call in calls:
        kw = {k.arg: k.value for k in call.keywords}
        assert isinstance(kw.get("start_new_session"), ast.Constant), call.lineno
        assert kw["start_new_session"].value is True, call.lineno
        assert "env" in kw, f"Popen at line {call.lineno} inherits the full bridge env"
