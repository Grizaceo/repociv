"""First launch of a sandbox-bypassing harness per city needs approval."""
from __future__ import annotations

import pytest

from server import launch_trust as lt
from server import policy
from server.command_schema import Command


@pytest.fixture(autouse=True)
def _root(tmp_path, monkeypatch):
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("REPOCIV_TRUST_BYPASS_HARNESSES", raising=False)
    monkeypatch.setattr(lt, "_configured_harness", lambda unit, base: "")


def _chat(unit: str, city: str = "repo-a", harness: str = "") -> Command:
    payload = {"unit": unit, "city": city, "mission": "hola"}
    if harness:
        payload["harness"] = harness
    return Command(id="c1", type="execute_agent", target=city, payload=payload)


@pytest.mark.parametrize("unit,harness,expected", [
    ("CLAUDE-1", "", "claude"),
    ("CODEX", "", "codex"),
    ("CURSOR-2", "", "cursor"),
    ("MAIN", "claude-code", "claude"),
    ("MAIN", "hermes", None),
    ("WORKER", "", None),
])
def test_bypass_harness_resolution(unit, harness, expected):
    assert lt.bypass_harness_for(_chat(unit, harness=harness).payload) == expected


def test_main_default_harness_counts(monkeypatch):
    monkeypatch.setattr(lt, "_configured_harness", lambda unit, base: "codex")
    assert lt.bypass_harness_for({"unit": "MAIN"}) == "codex"


def test_first_launch_needs_approval_then_stays_one_step():
    decision, reason = policy.decide(_chat("CLAUDE-1"))
    assert decision == "approve" and "First launch of 'claude' on 'repo-a'" in reason
    lt.remember("claude", "repo-a", "c1")
    assert policy.decide(_chat("CLAUDE-1"))[0] == "auto-safe"
    # Trust is per city and per harness.
    assert policy.decide(_chat("CLAUDE-1", city="repo-b"))[0] == "approve"
    assert policy.decide(_chat("CODEX", city="repo-a"))[0] == "approve"
    assert lt.revoke("claude", "repo-a") is True
    assert policy.decide(_chat("CLAUDE-1"))[0] == "approve"


def test_non_bypass_chat_stays_auto_safe():
    assert policy.decide(_chat("MAIN", harness="hermes"))[0] == "auto-safe"


def test_opt_out_restores_legacy_behavior(monkeypatch):
    monkeypatch.setenv("REPOCIV_TRUST_BYPASS_HARNESSES", "1")
    assert policy.decide(_chat("CODEX"))[0] == "auto-safe"


def test_approval_remembers_the_pair(monkeypatch, isolated_approval_store):
    from server import approval_resolution, approval_store, dispatch_ledger, scheduler

    monkeypatch.setattr(scheduler, "enqueue", lambda cmd: None)
    monkeypatch.setattr(dispatch_ledger, "record_intent", lambda *a, **k: None)
    monkeypatch.setattr(dispatch_ledger, "claim_intent", lambda *a, **k: None)
    monkeypatch.setattr(dispatch_ledger, "done_intent", lambda *a, **k: None)
    cmd = _chat("CURSOR-1", city="repo-z")
    pending = {"id": "c9", "type": cmd.type, "target": cmd.target, "payload": cmd.payload,
               "risk": "low"}
    monkeypatch.setattr(approval_resolution, "_pop_for_dispatch", lambda cid: pending)
    result = approval_resolution.dispatch_approved(pending)
    assert result["ok"] is True
    assert lt.is_trusted("cursor", "repo-z")
    assert approval_store is not None
