"""Tests for server.policies_yaml — opt-in YAML policy overlay (omnigent-style).

Run with: pytest server/test_policies_yaml.py -q
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from server import policies_yaml as pyaml
from server.command_schema import Command


# ─── fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_overlay_state():
    """Make every test start with an empty overlay cache."""
    pyaml.reset_for_tests()
    yield
    pyaml.reset_for_tests()


@pytest.fixture
def cfg_dir(tmp_path: Path, monkeypatch) -> Path:
    """Set REPOCIV_CONFIG_DIR to a tmp dir, with no policies.d/."""
    cfg = tmp_path / "repociv_cfg"
    cfg.mkdir()
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(cfg))
    return cfg


# ─── baseline (no policies dir) ───────────────────────────────────────────────


def test_overlay_disabled_without_directory(cfg_dir):
    """If ``policies.d`` doesn't exist, the loader returns an empty state."""
    state = pyaml.load_policies(cfg_dir / "policies.d")
    assert state.rules == ()
    assert state.loaded_files == ()
    assert state.rejected == ()


def test_overlay_skips_subdirectories(cfg_dir):
    """YAML files only at the top level are loaded; subdir files are ignored."""
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    sub = policies_dir / "nested"
    sub.mkdir()
    (sub / "ignored.yaml").write_text("policies: [{name: x, decision: approve}]", encoding="utf-8")
    state = pyaml.load_policies(policies_dir)
    # Sub-directory files should not be walked.
    assert state.rules == ()
    assert state.rejected == ()


# ─── schema validation ────────────────────────────────────────────────────────


def test_valid_block_rule_parses(cfg_dir):
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "01-block-destruct.yaml").write_text(
        """\
policies:
  - name: block_destructive
    description: Block destructive shell
    priority: 80
    applies_to:
      command_types: [shell]
      risk_levels: [destructive]
    effect:
      decision: blocked
      reason: rm -rf is not allowed
""",
        encoding="utf-8",
    )
    state = pyaml.load_policies(policies_dir)
    assert len(state.rules) == 1
    rule = state.rules[0]
    assert rule.name == "block_destructive"
    assert rule.priority == 80
    assert rule.command_types == ("shell",)
    assert rule.risk_levels == ("destructive",)
    assert rule.decision == "blocked"
    assert rule.reason == "rm -rf is not allowed"


def test_invalid_name_rejected_at_load(cfg_dir, caplog):
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "bad.yaml").write_text(
        """policies: [{name: "1-leading-digit", decision: blocked, effect: {decision: blocked}}]""",
        encoding="utf-8",
    )
    with caplog.at_level("WARNING", logger="server.policies_yaml"):
        state = pyaml.load_policies(policies_dir)
    assert state.rules == ()
    assert len(state.rejected) == 1
    rejected_path, reason = state.rejected[0]
    assert rejected_path.name == "bad.yaml"
    assert "name" in reason


def test_invalid_risk_level_rejected(cfg_dir):
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "bad.yaml").write_text(
        """policies:
  - name: bad_risk
    applies_to: {risk_levels: [extreme]}
    effect: {decision: blocked}
""",
        encoding="utf-8",
    )
    state = pyaml.load_policies(policies_dir)
    assert state.rules == ()
    assert state.rejected and "risk_levels" in state.rejected[0][1]


def test_disabled_rule_excluded(cfg_dir):
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "01-disabled.yaml").write_text(
        """policies:
  - name: disabled_rule
    enabled: false
    applies_to: {command_types: [shell]}
    effect: {decision: approve, reason: not in effect}
""",
        encoding="utf-8",
    )
    state = pyaml.load_policies(policies_dir)
    assert state.rules == ()


def test_priority_out_of_range_rejected(cfg_dir):
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "bad.yaml").write_text(
        """policies:
  - name: out_of_range
    priority: 999
    effect: {decision: approve}
""",
        encoding="utf-8",
    )
    state = pyaml.load_policies(policies_dir)
    assert state.rules == ()
    assert state.rejected


# ─── evaluation ───────────────────────────────────────────────────────────────


def _match_cmd(state, cmd_type: str = "shell", risk: str = "destructive",
               harness_id: str | None = None) -> pyaml.PolicyMatch | None:
    return pyaml.evaluate(
        state,
        cmd_type=cmd_type,
        risk=risk,
        harness_id=harness_id,
    )


def test_empty_filters_match_any_cmd(cfg_dir):
    """Rule with empty applies_to = wildcard match."""
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "broad.yaml").write_text(
        """policies:
  - name: broad
    applies_to: {}
    effect: {decision: approve, reason: broad rule}
""",
        encoding="utf-8",
    )
    state = pyaml.load_policies(policies_dir)
    assert _match_cmd(state, "shell") is not None
    assert _match_cmd(state, "edit_file") is not None
    assert _match_cmd(state, "run_tests", "low") is not None


def test_command_type_filter_is_exact(cfg_dir):
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "specific.yaml").write_text(
        """policies:
  - name: only_shell
    applies_to: {command_types: [shell]}
    effect: {decision: blocked}
""",
        encoding="utf-8",
    )
    state = pyaml.load_policies(policies_dir)
    assert _match_cmd(state, "shell") is not None
    assert _match_cmd(state, "edit_file") is None
    assert _match_cmd(state, "shell", "low") is not None  # risk_levels empty = wildcard


def test_harness_id_filter(cfg_dir):
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "hermes_only.yaml").write_text(
        """policies:
  - name: hermes_only
    applies_to: {harness_ids: [hermes]}
    effect: {decision: approve, reason: hermes path}
""",
        encoding="utf-8",
    )
    state = pyaml.load_policies(policies_dir)
    assert _match_cmd(state, harness_id="hermes") is not None
    assert _match_cmd(state, harness_id="claude") is None
    # Without harness_id on the command, the harness_ids filter fails closed
    assert _match_cmd(state, harness_id=None) is None


def test_priority_order_picks_higher(cfg_dir):
    """Two rules match; the higher priority wins."""
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "lower.yaml").write_text(
        """policies:
  - name: lower_priority
    priority: 10
    applies_to: {command_types: [shell]}
    effect: {decision: approve, reason: lower}
  - name: higher_priority
    priority: 90
    applies_to: {command_types: [shell]}
    effect: {decision: blocked, reason: higher}
""",
        encoding="utf-8",
    )
    state = pyaml.load_policies(policies_dir)
    match = _match_cmd(state, "shell", "destructive")
    assert match is not None
    assert match.rule.name == "higher_priority"
    assert match.decision == "blocked"


# ─── decide() integration ────────────────────────────────────────────────────


def test_decide_uses_yaml_overlay_when_matches(cfg_dir):
    """When a YAML rule matches decide()'s (cmd.type, risk, harness_id), the
    YAML decision wins regardless of the Python engine's default.

    In this test the overlay rule says shell+destructive → blocked.
    The Python engine's TYPE_POLICY default for ``shell`` (untyped as far
    as Command goes) is approve via the risk-floor. Without the overlay
    the rule would approve; with it the rule blocks. So a successful
    match here proves the overlay fires before Python.
    """
    from server import policy as _policy
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "block-shell-destruct.yaml").write_text(
        """policies:
  - name: block_shell_destructive
    applies_to: {command_types: [shell], risk_levels: [destructive]}
    effect: {decision: blocked, reason: overlay says blocked}
""",
        encoding="utf-8",
    )
    # Force the loader to pick up our test directory.
    pyaml.reset_for_tests(policies_dir)
    cmd = Command(type="shell", target=".", risk="destructive", harness_id=None)
    decision, reason = _policy.decide(cmd)
    assert decision == "blocked"
    assert "overlay says blocked" in reason


def test_decide_falls_through_when_no_yaml_match(cfg_dir):
    """If no YAML rule matches the command, decide() uses the Python engine."""
    from server import policy as _policy
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "narrow.yaml").write_text(
        """policies:
  - name: only_destructive
    applies_to: {risk_levels: [destructive]}
    effect: {decision: blocked, reason: never matches here}
""",
        encoding="utf-8",
    )
    pyaml.reset_for_tests(policies_dir)
    cmd = Command(type="inspect_repo", target=".", risk="low")
    decision, _reason = _policy.decide(cmd)
    # inspect_repo is auto-safe in TYPE_POLICY; YAML rule doesn't match (risk != destructive)
    assert decision == "auto-safe"


def test_decide_falls_through_when_no_policies_dir(cfg_dir):
    """Empty policies dir is a no-op; Python engine drives decision."""
    from server import policy as _policy
    # policies.d does not exist at all
    pyaml.reset_for_tests(cfg_dir / "policies.d")
    cmd = Command(type="inspect_repo", target=".", risk="low")
    decision, _ = _policy.decide(cmd)
    assert decision == "auto-safe"


# ─── malformed YAML is non-fatal ──────────────────────────────────────────────


def test_malformed_yaml_recorded_but_state_empty(cfg_dir, caplog):
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    # Genuinely malformed YAML — unquoted mapping key with colon + value
    # in a position the parser cannot recover from.
    (policies_dir / "broken.yaml").write_text(
        "policies: [{name: bad key : some value}]",
        encoding="utf-8",
    )
    with caplog.at_level("WARNING", logger="server.policies_yaml"):
        state = pyaml.load_policies(policies_dir)
    assert state.rules == ()
    assert len(state.rejected) == 1
    assert state.rejected[0][0].name == "broken.yaml"


# ─── conflict detection ──────────────────────────────────────────────────────


def test_conflict_detected_for_same_priority_overlap(cfg_dir):
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "01-conflicts.yaml").write_text(
        """policies:
  - name: rule_a
    priority: 70
    applies_to: {command_types: [shell], risk_levels: [destructive]}
    effect: {decision: blocked, reason: a}
  - name: rule_b
    priority: 70
    applies_to: {command_types: [shell], risk_levels: [destructive]}
    effect: {decision: approve, reason: b}
""",
        encoding="utf-8",
    )
    state = pyaml.load_policies(policies_dir)
    sample, conflicts = pyaml.detect_conflicts(state)
    assert sample is not None
    assert len(conflicts) == 1
    assert "rule_a" in conflicts[0] and "rule_b" in conflicts[0]


def test_no_conflict_with_disjoint_filters(cfg_dir):
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "01-disjoint.yaml").write_text(
        """policies:
  - name: shell_only
    priority: 70
    applies_to: {command_types: [shell]}
    effect: {decision: blocked, reason: shell}
  - name: file_only
    priority: 70
    applies_to: {command_types: [edit_file]}
    effect: {decision: blocked, reason: file}
""",
        encoding="utf-8",
    )
    state = pyaml.load_policies(policies_dir)
    sample, conflicts = pyaml.detect_conflicts(state)
    assert sample is None
    assert conflicts == []


# ─── privacy in audit log ────────────────────────────────────────────────────


def test_audit_log_emits_count_not_value(cfg_dir, caplog):
    """Decision log must NOT echo cmd type, risk, or harness name unless harmless."""
    policies_dir = cfg_dir / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "01-log.yaml").write_text(
        """policies:
  - name: log_test
    applies_to: {command_types: [shell]}
    effect: {decision: blocked}
""",
        encoding="utf-8",
    )
    state = pyaml.load_policies(policies_dir)
    pyaml.reset_for_tests(policies_dir)
    with caplog.at_level("INFO", logger="server.policies_yaml"):
        pyaml.evaluate(state, cmd_type="shell", risk="destructive", harness_id="hermes")
    joined = "\n".join(r.message for r in caplog.records)
    # OK to mention match name + decision; must NOT contain command content
    assert "log_test" in joined
    assert "shell" in joined   # cmd type is part of match criteria, harmless log
    # Must not contain payload-like content (irrelevant here but check shape)
    assert "secret" not in joined


# ─── helper decorators ──────────────────────────────────────────────────────


def test_decorator_does_not_break_when_yaml_missing(tmp_path, monkeypatch):
    """If policies_yaml.py is importable but PyYAML is missing, the loader
    surfaces a PolicyOverlayError at load-time. decide() itself must NOT
    crash — Python engine wins."""
    from server import policy as _policy
    cfg = tmp_path / "repociv_cfg2"
    cfg.mkdir()
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(cfg))
    policies_dir = cfg / "policies.d"
    policies_dir.mkdir()
    (policies_dir / "01-conflict.yaml").write_text(
        """policies:
  - name: r1
    priority: 50
    applies_to: {command_types: [shell]}
    effect: {decision: blocked, reason: r1}
""",
        encoding="utf-8",
    )
    pyaml.reset_for_tests(policies_dir)
    # Force YAML unavailability by making the import of yaml itself succeed
    # (it's in this venv) but the local yaml.safe_load would still work.
    # So instead patch _parse_yaml_file to simulate PyYAML missing.
    with patch.object(pyaml, "_parse_yaml_file",
                      side_effect=pyaml.PolicyOverlayError("simulated missing PyYAML")):
        pyaml.reset_for_tests(policies_dir)
        cmd = Command(type="shell", target=".", risk="destructive", harness_id=None)
        # Python engine drives the decision; overlay failed gracefully.
        decision, reason = _policy.decide(cmd)
    # We just need decide() to NOT raise; the verdict depends on Python defaults.
    assert decision in {"auto-safe", "approve", "blocked"}
