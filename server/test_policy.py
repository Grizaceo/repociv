"""Tests for server/policy.py — trust-level branching and command decisions."""
from __future__ import annotations

import pytest

from server.command_schema import Command
from server import policy as _policy
from server import harness_registry as _hr


# ─── Helpers ───────────────────────────────────────────────────────────────────

def cmd(type_: str, risk: str = "medium", harness_id: str | None = None) -> Command:
    """Minimal command fixture."""
    return Command(
        id="test-cmd-1",
        type=type_,
        target="/repo/test",
        risk=risk,
        created_by="pytest",
        harness_id=harness_id,
    )


# ─── Reference-only harness always blocks ──────────────────────────────────────

def test_reference_only_harness_blocks_any_command():
    decision, reason = _policy.decide(cmd("read_file", harness_id="reference-only"))
    assert decision == "blocked"
    assert "reference_only" in reason


# ─── Unknown harness → blocked ─────────────────────────────────────────────────

def test_unknown_harness_id_blocks():
    decision, _ = _policy.decide(cmd("read_file", harness_id="nonexistent"))
    assert decision == "blocked"


# ─── Capability checks (allowedActions / blockedActions) ──────────────────────

def test_blocked_action_on_harness_blocks():
    # nemoclaw-sandbox (sandboxed) blocks delete_file
    decision, reason = _policy.decide(cmd("delete_file", harness_id="nemoclaw-sandbox"))
    assert decision == "blocked"
    assert "not allowed" in reason


def test_unknown_command_type_on_harness_blocks():
    decision, _ = _policy.decide(cmd("fly_airplane", harness_id="hermes-local"))
    assert decision == "blocked"


# ─── Trust-level upgrades ──────────────────────────────────────────────────────

def test_sandboxed_harness_medium_risk_edit_file_blocked_by_capability():
    # nemoclaw-sandbox has edit_file in blockedActions → capability check
    # blocks before the trust-level upgrade is reached.
    decision, reason = _policy.decide(cmd("edit_file", risk="medium", harness_id="nemoclaw-sandbox"))
    assert decision == "blocked"
    assert "not allowed" in reason


def test_local_cli_harness_low_risk_auto_safe():
    decision, _ = _policy.decide(cmd("read_file", risk="low", harness_id="hermes-local"))
    assert decision == "auto-safe"


def test_local_cli_harness_high_risk_auto_safe():
    decision, _ = _policy.decide(cmd("run_build", risk="high", harness_id="hermes-local"))
    assert decision == "auto-safe"


def test_nemoclaw_sandbox_harness_run_tests_auto_safe():
    decision, _ = _policy.decide(cmd("run_tests", risk="low", harness_id="nemoclaw-sandbox"))
    assert decision == "auto-safe"


# ─── Type-policy table ─────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "cmd_type,expected",
    [
        ("inspect_repo", "auto-safe"),
        ("read_file",    "auto-safe"),
        ("run_tests",    "auto-safe"),
        ("run_build",    "auto-safe"),
        ("quest_add",    "auto-safe"),
        ("unit_command", "auto-safe"),
        ("edit_file",    "approve"),
        ("create_branch","approve"),
        ("git_commit",   "approve"),
        ("send_message", "approve"),
        ("delete_file",  "approve"),
        ("execute_agent","approve"),
    ],
)
def test_type_policy_table(cmd_type: str, expected: str):
    decision, _ = _policy.decide(cmd(cmd_type))
    assert decision == expected


# ─── apply_policy mutation ─────────────────────────────────────────────────────

def test_apply_policy_auto_safe_queues():
    c = cmd("read_file")
    _, reason = _policy.apply_policy(c)
    assert reason == ""
    assert c.status == "queued"
    assert c.requires_approval is False


def test_apply_policy_approve_sets_waiting():
    c = cmd("edit_file")
    _, reason = _policy.apply_policy(c)
    assert reason == ""
    assert c.status == "waiting_approval"
    assert c.requires_approval is True


def test_apply_policy_blocked_rejects():
    c = cmd("fly_airplane", harness_id="nonexistent")
    _, reason = _policy.apply_policy(c)
    assert reason != ""
    assert c.status == "rejected"
    assert c.requires_approval is False
