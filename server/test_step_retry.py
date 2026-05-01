"""Tests for server/step_retry.py — Sprint C1."""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch


from server.step_retry import escalate_model, retry_step


# ─── escalate_model tests ─────────────────────────────────────────────────────

def test_escalate_haiku_to_sonnet():
    assert escalate_model("claude-haiku-3-5") == "claude-sonnet-4-5"


def test_escalate_sonnet_to_opus():
    assert escalate_model("claude-sonnet-4-5") == "claude-opus-4-5"


def test_escalate_opus_stays_opus():
    assert escalate_model("claude-opus-4-5") == "claude-opus-4-5"


def test_escalate_unknown_model_unchanged():
    assert escalate_model("gpt-4o") == "gpt-4o"


def test_escalate_empty_string_unchanged():
    assert escalate_model("") == ""


# ─── retry_step: success on first try ────────────────────────────────────────

def test_retry_step_success_on_first_try():
    """Executor succeeds immediately — no retries, returns run_id and 1 attempt."""
    executor = MagicMock(return_value="run-001")
    step_meta = {"stepIndex": 0, "model": "claude-haiku-3-5"}

    run_id, attempts = retry_step(executor, "repo", "ISSUE-1", "do stuff", step_meta)

    assert run_id == "run-001"
    assert attempts == 1
    executor.assert_called_once_with("repo", "ISSUE-1", "do stuff", step_meta)


# ─── retry_step: fail once then succeed ──────────────────────────────────────

def test_retry_step_fail_once_then_succeed():
    """Executor fails on first call, succeeds on second."""
    call_count = 0

    def executor(repo, issue_id, step, meta):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("transient failure")
        return "run-002"

    step_meta = {"stepIndex": 0, "model": "claude-haiku-3-5"}

    with patch("server.step_retry.time.sleep"):
        run_id, attempts = retry_step(executor, "repo", "ISSUE-1", "do stuff", step_meta)

    assert run_id == "run-002"
    assert attempts == 2
    assert call_count == 2


def test_retry_step_model_escalated_on_first_retry():
    """After first failure, model in step_meta is escalated."""
    call_count = 0

    def executor(repo, issue_id, step, meta):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("fail")
        return "run-ok"

    step_meta = {"stepIndex": 0, "model": "claude-haiku-3-5"}

    with patch("server.step_retry.time.sleep"):
        retry_step(executor, "repo", "ISSUE-1", "step", step_meta)

    # After retry, model should have been escalated
    assert step_meta["model"] == "claude-sonnet-4-5"


def test_retry_step_escalations_recorded():
    """Escalation audit trail is written to step_meta['_escalations']."""
    call_count = 0

    def executor(repo, issue_id, step, meta):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise ValueError("error")
        return "run-ok"

    step_meta = {"stepIndex": 1, "model": "claude-haiku-3-5"}

    with patch("server.step_retry.time.sleep"):
        retry_step(executor, "repo", "ISSUE-1", "step", step_meta)

    escalations = step_meta.get("_escalations", [])
    assert len(escalations) == 1
    assert escalations[0]["fromModel"] == "claude-haiku-3-5"
    assert escalations[0]["toModel"] == "claude-sonnet-4-5"
    assert escalations[0]["attempt"] == 1


# ─── retry_step: fail all retries ────────────────────────────────────────────

def test_retry_step_raises_last_exception_after_max_retries():
    """If all retries fail, the last exception is propagated."""
    executor = MagicMock(side_effect=RuntimeError("always fails"))
    step_meta = {"stepIndex": 0, "model": "claude-haiku-3-5"}

    with patch("server.step_retry.time.sleep"):
        with pytest.raises(RuntimeError, match="always fails"):
            retry_step(executor, "repo", "ISSUE-1", "step", step_meta, max_retries=2)

    assert executor.call_count == 3  # initial + 2 retries


def test_retry_step_respects_max_retries_zero():
    """With max_retries=0, exactly one attempt is made."""
    executor = MagicMock(side_effect=RuntimeError("fail"))
    step_meta = {"stepIndex": 0, "model": "claude-haiku-3-5"}

    with pytest.raises(RuntimeError):
        retry_step(executor, "repo", "ISSUE-1", "step", step_meta, max_retries=0)

    assert executor.call_count == 1


def test_retry_step_model_escalates_through_full_chain():
    """Executor always fails — model escalates haiku→sonnet→opus."""
    models_seen = []

    def executor(repo, issue_id, step, meta):
        models_seen.append(meta.get("model"))
        raise RuntimeError("fail")

    step_meta = {"stepIndex": 0, "model": "claude-haiku-3-5"}

    with patch("server.step_retry.time.sleep"):
        with pytest.raises(RuntimeError):
            retry_step(executor, "repo", "ISSUE-1", "step", step_meta, max_retries=2)

    # attempt 0: haiku, attempt 1: sonnet, attempt 2: opus
    assert models_seen == ["claude-haiku-3-5", "claude-sonnet-4-5", "claude-opus-4-5"]


def test_retry_step_no_model_in_meta_uses_haiku_default():
    """If step_meta has no 'model', escalation defaults to treating haiku as base."""
    call_count = 0

    def executor(repo, issue_id, step, meta):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("fail")
        return "run-ok"

    step_meta = {"stepIndex": 0}  # no "model" key

    with patch("server.step_retry.time.sleep"):
        run_id, attempts = retry_step(executor, "repo", "ISSUE-1", "step", step_meta)

    # Should have worked on retry; model escalated from haiku default
    assert attempts == 2
    assert step_meta["model"] == "claude-sonnet-4-5"
