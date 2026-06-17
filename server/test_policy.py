"""Tests for server/policy.py — trust-level branching and command decisions."""
from __future__ import annotations

import pytest

from server.command_schema import Command
from server import policy as _policy


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


def test_local_cli_harness_high_risk_requires_approval():
    """Audit 1.3: risk='high' MUST go to approval regardless of type.

    Pre-audit, this was the BUG: a ``run_build`` command tagged
    risk='high' returned 'auto-safe' because the type policy said so.
    The risk floor (Step 7 in decide()) now upgrades that to 'approve'.
    """
    decision, reason = _policy.decide(cmd("run_build", risk="high", harness_id="hermes-local"))
    assert decision == "approve"
    assert "risk floor" in reason
    assert "high" in reason


def test_local_cli_harness_destructive_risk_requires_approval():
    """Audit 1.3: risk='destructive' has the same floor as 'high'."""
    decision, reason = _policy.decide(
        cmd("execute_agent", risk="destructive", harness_id="hermes-local")
    )
    assert decision == "approve"
    assert "risk floor" in reason


def test_nemoclaw_sandbox_harness_run_tests_auto_safe():
    decision, _ = _policy.decide(cmd("run_tests", risk="low", harness_id="nemoclaw-sandbox"))
    assert decision == "auto-safe"


def test_nemoclaw_sandbox_harness_run_tests_high_risk_requires_approval():
    """Audit 1.3: even sandboxed harnesses gate high-risk run_tests."""
    decision, _ = _policy.decide(
        cmd("run_tests", risk="high", harness_id="nemoclaw-sandbox")
    )
    assert decision == "approve"


# ─── Audit 1.3 — exhaustive invariant ──────────────────────────────────────
# For every known command type × every known harness, a risk='high' or
# risk='destructive' command MUST return 'approve'. This is the
# meta-test that catches any future regression where a new type gets
# added to _TYPE_POLICY without the risk floor being respected.

def test_audit_high_risk_invariant():
    """Audit 1.3 invariant: risk=high/destructive → approve (full grid)."""
    # Pull all known command types from the policy table + the schema.
    # Anything that's not in the table falls through to _RISK_DEFAULT
    # which already maps high/destructive to 'approve'.
    from server import harness_registry as _hr
    known_harnesses = [h["id"] for h in _hr.list_harnesses()]
    # Every type referenced anywhere in the codebase must respect the floor.
    known_types = sorted(set(_policy._TYPE_POLICY.keys()) | {
        "inspect_repo", "read_file", "run_tests", "run_build",
        "edit_file", "create_branch", "git_commit", "send_message",
        "delete_file", "execute_agent", "subagent_spawn", "subagent_dispatch",
        "unit_command", "quest_add", "e2e_probe",
    })
    risky_levels = ("high", "destructive")

    for harness_id in known_harnesses:
        for cmd_type in known_types:
            for risk in risky_levels:
                # Some types are blocked at the capability layer on
                # certain harnesses (e.g. delete_file on
                # nemoclaw-sandbox). Those are not affected by the
                # risk floor — they were already blocked before this
                # change, and remain so. Skip them so the audit only
                # checks the cases that reach the risk floor.
                decision, _ = _policy.decide(
                    cmd(cmd_type, risk=risk, harness_id=harness_id)
                )
                if decision == "blocked":
                    continue  # capability-blocked, not a risk-floor regression
                assert decision == "approve", (
                    f"audit 1.3 violation: harness={harness_id!r} "
                    f"type={cmd_type!r} risk={risk!r} → {decision!r} "
                    f"(expected 'approve')"
                )


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
        ("e2e_probe",    "auto-safe"),
        ("edit_file",    "approve"),
        ("create_branch","approve"),
        ("git_commit",   "approve"),
        ("send_message", "approve"),
        ("delete_file",  "approve"),
        ("execute_agent","auto-safe"),
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
