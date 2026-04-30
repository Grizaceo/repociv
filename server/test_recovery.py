"""Tests for server/recovery.py — failure reason → recovery plan branching."""
from __future__ import annotations

import pytest

from server import recovery as _recovery
from server import harness_registry as _hr


# ─── Helpers ───────────────────────────────────────────────────────────────────

def get_harness(harness_id: str):
    h = _hr.get_harness(harness_id)
    assert h is not None, f"Test harness '{harness_id}' not in registry"
    return h


def ctx(reason: str, **kw):
    defaults = {"reason": reason, "command_type": "", "target": "", "details": ""}
    defaults.update(kw)
    return defaults


def plan(harness_id: str, reason: str, **kw):
    h = get_harness(harness_id)
    return _recovery.build_recovery_plan(h, ctx(reason, **kw))


# Registry harness IDs:
#   hermes-local         | local_cli         | [copy_command, tmux_attach]
#   openclaw-local        | local_cli         | [copy_command, tmux_attach]
#   nemoclaw-sandbox     | sandboxed         | [view_logs, no_recovery_available]
#   local-cli             | privileged_external | [copy_command]
#   reference-only        | reference_only    | []

# ─── command_failed ────────────────────────────────────────────────────────────

def test_command_failed_copy_command_on_hermes_local():
    p = plan("hermes-local", "command_failed", command_type="run_tests", target="/repo")
    assert p["mode"] == "copy_command"
    assert p["harness_id"] == "hermes-local"
    assert "run_tests" in p["explanation"]
    assert p["requires_approval"] is False  # local_cli not privileged_external


def test_command_failed_privileged_external_requires_approval():
    # local-cli (privileged_external): copy_command needs approval
    p = plan("local-cli", "command_failed", command_type="run_tests")
    assert p["mode"] == "copy_command"
    assert p["requires_approval"] is True
    assert p["risk"] == "high"


def test_command_failed_view_logs_on_nemoclaw_sandbox():
    # nemoclaw-sandbox only has view_logs (copy_command not available)
    p = plan("nemoclaw-sandbox", "command_failed")
    assert p["mode"] == "view_logs"
    assert p["harness_id"] == "nemoclaw-sandbox"


# ─── harness_unreachable ───────────────────────────────────────────────────────

def test_harness_unreachable_copy_command_on_hermes_local():
    p = plan("hermes-local", "harness_unreachable")
    assert p["mode"] == "copy_command"
    assert p["harness_id"] == "hermes-local"
    assert "unreachable" in p["explanation"].lower()


def test_harness_unreachable_on_nemoclaw_sandbox_view_logs():
    p = plan("nemoclaw-sandbox", "harness_unreachable")
    assert p["mode"] == "view_logs"


# ─── harness_healthy ──────────────────────────────────────────────────────────

def test_harness_healthy_copy_command():
    p = plan("hermes-local", "harness_healthy")
    assert p["mode"] == "copy_command"
    assert "attach" in p["explanation"].lower()


def test_harness_healthy_nemoclaw_sandbox_view_logs():
    p = plan("nemoclaw-sandbox", "harness_healthy")
    assert p["mode"] == "view_logs"


# ─── harness_not_found (passed as harness descriptor, not registry lookup) ────

def test_harness_not_found_returns_no_recovery():
    # When the caller has a minimal harness dict (not from registry)
    minimal = {"id": "ghost", "trustLevel": "read_only", "label": "ghost", "recoveryModes": []}
    p = _recovery.build_recovery_plan(minimal, ctx("harness_not_found"))
    assert p["mode"] == "no_recovery_available"
    assert p["harness_id"] == "ghost"


# ─── unknown ──────────────────────────────────────────────────────────────────

def test_unknown_reason_falls_back_to_first_available_mode():
    p = plan("hermes-local", "unknown")
    assert p["mode"] == "copy_command"  # first available in hermes-local modes
    assert p["reason"] == "unknown"


def test_unknown_on_nemoclaw_sandbox_view_logs():
    p = plan("nemoclaw-sandbox", "unknown")
    assert p["mode"] == "view_logs"


# ─── no_recovery_available ────────────────────────────────────────────────────

def test_no_recovery_available_returns_empty_command():
    bare = {"id": "bare", "label": "bare", "trustLevel": "read_only", "recoveryModes": []}
    p = _recovery.build_recovery_plan(bare, ctx("command_failed"))
    assert p["mode"] == "no_recovery_available"
    assert p["command"] == ""
    assert p["cwd"] == ""
    assert p["requires_approval"] is False


# ─── Risk label derivation ─────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "harness_id,expected_risk",
    [
        ("reference-only",   "informational"),  # reference_only
        ("nemoclaw-sandbox", "low"),            # sandboxed
        ("hermes-local",    "medium"),          # local_cli
        ("openclaw-local",  "medium"),          # local_cli
        ("local-cli",       "high"),            # privileged_external
    ],
)
def test_risk_from_trust_mapping(harness_id: str, expected_risk: str):
    p = plan(harness_id, "harness_healthy")
    assert p["risk"] == expected_risk


# ─── available_modes always present ────────────────────────────────────────────

def test_available_modes_always_included():
    for harness_id in ["hermes-local", "nemoclaw-sandbox", "local-cli"]:
        p = plan(harness_id, "harness_healthy")
        assert "available_modes" in p
        assert isinstance(p["available_modes"], list)
        assert len(p["available_modes"]) > 0


# ─── copy_command fields ────────────────────────────────────────────────────────

def test_copy_command_cwd_populated():
    p = plan("hermes-local", "command_failed")
    if p["mode"] == "copy_command":
        assert p["cwd"] != ""


# ─── tmux_attach fields ────────────────────────────────────────────────────────

def test_tmux_attach_session_and_command():
    # Use openclaw-local which has tmux_attach; force it by passing a minimal
    # harness that only supports tmux_attach
    bare = {
        "id": "tmux-test",
        "label": "tmux test",
        "trustLevel": "local_cli",
        "recoveryModes": ["tmux_attach"],
        "recovery": {"tmux_attach": {"session": "my-session", "notes": []}},
    }
    p = _recovery.build_recovery_plan(bare, ctx("harness_unreachable"))
    assert p["mode"] == "tmux_attach"
    assert p["session"] == "my-session"
    assert "tmux attach" in p["command"]


# ─── view_logs fields ─────────────────────────────────────────────────────────

def test_view_logs_command_empty():
    p = plan("nemoclaw-sandbox", "command_failed")
    if p["mode"] == "view_logs":
        assert p["command"] == ""
        assert p["session"] == ""
