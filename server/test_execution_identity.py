"""Isolated canonical execution-identity tests: no agent launch, no real tasks.

Verifies ExecutionIdentityRecorded: evidence-gated optional fields, the
harness/profile/agent/session/unit distinction, and that /log projects the new
identity fields without exposing any profile path.
"""
from __future__ import annotations

import json

import pytest

from server import agent_runner as ar
from server import event_store as es
from server import execution_identity as ei
from server.routes.core import get_log

_ORIGINAL_REGISTRY = ar._find_registry_profile


@pytest.fixture
def isolated_store(tmp_path, monkeypatch):
    """Rebind the canonical JSONL to a scratch tmp path only."""
    from server import bridge  # initialize once before rebinding
    assert bridge._es is es
    path = tmp_path / "events.jsonl"
    monkeypatch.setattr(es, "_store_path", path)
    from server import sessions, run_state
    monkeypatch.setattr(sessions, "_base_dir", tmp_path / "sessions")
    monkeypatch.setattr(run_state, "_base_dir", tmp_path / "run-state")
    monkeypatch.setattr(ar, "save_mission", lambda data: None)
    monkeypatch.setattr(ar, "send_to_repociv", lambda data: None)
    yield path


def _profile(name: str, **extra) -> dict:
    return {"harness": "hermes", "harness_ref": "default", "display_name": name, **extra}


def _registry(fake):
    """Patch _find_registry_profile to return a controlled profile."""
    ar._find_registry_profile = lambda unit_id: fake


def _reset_registry():
    ar._find_registry_profile = _ORIGINAL_REGISTRY


# ── Field-level evidence gating ────────────────────────────────────────────────

def test_minimal_identity_has_required_triad_plus_safe_name():
    # commandId/commandType/harness always present; agentName is a safe human
    # title (base name) that is always available. unitId/profileName/provider/
    # model are evidence-gated and absent here.
    data = ei.build_identity(
        command_id="c1", command_type="execute_agent", harness="hermes",
        unit_id="MAIN", registry_profile=None, config={},
    )
    assert data["commandId"] == "c1"
    assert data["commandType"] == "execute_agent"
    assert data["harness"] == "hermes"
    assert "agentName" not in data
    for absent in ("unitId", "profileName", "provider", "model"):
        assert absent not in data


def test_auto_provider_is_not_an_effective_provider():
    data = ei.build_identity(
        command_id="c1", command_type="execute_agent", harness="hermes",
        unit_id="MAIN", registry_profile=None, config={}, provider="auto",
    )
    assert "provider" not in data


def test_profile_name_is_basename_never_path():
    data = ei.build_identity(
        command_id="c1", command_type="execute_agent", harness="hermes-cli",
        unit_id="SCOUT-1", registry_profile=None,
        config={"profile": "/home/user/.hermes/profiles/scout"},
    )
    assert data["profileName"] == "scout"
    assert "/home/user" not in json.dumps(data)
    assert "profilePath" not in data


def test_default_profile_is_omitted():
    data = ei.build_identity(
        command_id="c1", command_type="execute_agent", harness="hermes",
        unit_id="MAIN", registry_profile=None,
        config={"profile": "~/.hermes/profiles/default"},
    )
    assert "profileName" not in data


def test_model_equal_to_provider_is_not_a_chosen_model():
    # Runner branches without per-model selection pass model or provider;
    # that fallback must not present the provider as the served model.
    data = ei.build_identity(
        command_id="c1", command_type="execute_agent", harness="codex",
        unit_id="CODEX-1", registry_profile=None, config={},
        provider="openrouter", model="openrouter",
    )
    assert data["provider"] == "openrouter"
    assert "model" not in data


def test_model_recorded_when_known():
    data = ei.build_identity(
        command_id="c1", command_type="execute_agent", harness="hermes",
        unit_id="MAIN", registry_profile=None, config={},
        provider="nous", model="step-5-preview",
    )
    assert data["provider"] == "nous"
    assert data["model"] == "step-5-preview"


# ── unitId: real unit vs generic slot vs legacy agentId ────────────────────────






# ── agentName: safe human title, never a uuid ─────────────────────────────────



def test_agent_name_never_returns_uuid_input():
    # An opaque uuid unit id with no registered profile yields the base, but
    # unitId stays empty so a uuid is never sold as a unit.
    uid = "3f2a9c1e-aaaa-bbbb-cccc-1234567890ab"
    data = ei.build_identity(
        command_id="c1", command_type="execute_agent", harness="hermes",
        unit_id=uid, registry_profile=None, config={},
    )
    assert "unitId" not in data


# ── End-to-end recording through the event store ──────────────────────────────

def test_record_writes_canonical_event_with_commandid(isolated_store):
    _registry(None)
    try:
        ei.record("c1", "execute_agent", "hermes-cli", "SCOUT-1", None,
                  {"profile": "/x/.hermes/profiles/scout"},
                  provider="nous", model="m1", canonical={"unitId": "SCOUT-1"})
    finally:
        _reset_registry()
    rows = [json.loads(line) for line in isolated_store.read_text().splitlines() if line.strip()]
    assert len(rows) == 1
    evt = rows[0]
    assert evt["type"] == "ExecutionIdentityRecorded"
    assert evt["commandId"] == "c1"
    assert evt["data"]["profileName"] == "scout"
    assert evt["data"]["unitId"] == "SCOUT-1"
    assert "agentName" not in evt["data"]
    assert "profilePath" not in json.dumps(evt)


def test_log_projects_new_identity_fields(isolated_store):
    es.record_event("ExecutionIdentityRecorded", {
        "commandId": "c1", "commandType": "execute_agent", "harness": "hermes-cli",
        "profileName": "scout", "agentName": "SCOUT", "unitId": "SCOUT-1",
        "provider": "nous", "model": "m1",
        "profilePath": "/home/user/.hermes/profiles/scout",  # unsafe, must be dropped
    }, command_id="c1")
    code, page = get_log({"params": {"metadata": "1", "paged": "1", "n": "10"}})
    assert code == 200
    assert len(page["events"]) == 1
    data = page["events"][0]["data"]
    assert data["harness"] == "hermes-cli"
    assert data["profileName"] == "scout"
    assert data["agentName"] == "SCOUT"
    assert data["unitId"] == "SCOUT-1"
    assert data["provider"] == "nous"
    assert data["model"] == "m1"
    assert data["commandType"] == "execute_agent"
    # profilePath is not in safe_fields and must never be projected.
    assert "profilePath" not in data
    assert "/home/user" not in json.dumps(page)


def test_agent_runner_records_identity_for_hermes_http(isolated_store, monkeypatch):
    """run_agent with no repo → hermes HTTP path records identity."""
    _registry(("H", _profile("H", display_name="MAIN")))
    monkeypatch.setattr(ar, "_run_hermes_streaming",
                        lambda *a, **k: (True, "ok"))
    try:
        ar.run_agent("MAIN", "main", "hello")
    finally:
        _reset_registry()
    rows = [json.loads(line) for line in isolated_store.read_text().splitlines() if line.strip()]
    ids = [r for r in rows if r["type"] == "ExecutionIdentityRecorded"]
    assert len(ids) == 1
    d = ids[0]["data"]
    assert d["harness"] == "hermes"
    assert d["agentName"] == "MAIN"
    # MAIN is the generic umbrella slot → never a unitId.
    assert "unitId" not in d


def test_agent_runner_records_hermes_cli_harness_for_profile(isolated_store, monkeypatch, tmp_path):
    """A configured profile routes to hermes-cli; harness must say so, not 'hermes'."""
    prof_dir = tmp_path / ".hermes" / "profiles" / "scout"
    prof_dir.mkdir(parents=True)
    work = tmp_path / "repo"
    work.mkdir()
    _registry(("SCOUT", _profile("SCOUT")))
    monkeypatch.setattr(ar, "_get_agent_config",
                        lambda unit_id: {"profile": str(prof_dir), "stateful": False, "system": ""})
    monkeypatch.setattr(ar, "_has_hermes_cli", lambda: True)
    monkeypatch.setattr(ar, "_find_registry_profile", lambda unit_id: ("SCOUT", _profile("SCOUT")))
    monkeypatch.setattr(ar, "_run_hermes_cli_streaming",
                        lambda *a, **k: (True, "ok"))
    monkeypatch.setattr(ar, "resolve_agent_working_dir", lambda *a, **k: str(work))
    try:
        ar.run_agent("SCOUT-1", "repo", "scan", repo_path=str(work))
    finally:
        _reset_registry()
    rows = [json.loads(line) for line in isolated_store.read_text().splitlines() if line.strip()]
    ids = [r for r in rows if r["type"] == "ExecutionIdentityRecorded"]
    assert len(ids) == 1
    d = ids[0]["data"]
    assert d["harness"] == "hermes-cli"
    assert d["profileName"] == "scout"
    assert d["unitId"] == "SCOUT-1"
    assert d["agentName"] == "SCOUT"


@pytest.mark.parametrize("harness", ["hermes", "claude", "codex", "openclaw", "cursor", "docker-agent"])
def test_fallback_cannot_claim_hermes_profile(harness):
    data = ei.build_identity(command_id="cmd", command_type="execute_agent", harness=harness,
                             config={"profile": "~/.hermes/profiles/scout"})
    assert "profileName" not in data


def test_canonical_link_is_exact_not_prefix():
    common = dict(command_id="cmd", command_type="execute_agent", harness="hermes-cli")
    assert "unitId" not in ei.build_identity(**common, unit_id="WORKER-1")
    assert "unitId" not in ei.build_identity(**common, unit_id="A", canonical={"unitId": "B"})
    data = ei.build_identity(**common, unit_id="opaque-id", canonical={"unitId": "opaque-id"})
    assert data["unitId"] == "opaque-id"
    assert "agentName" not in data
    assert "unitId" not in ei.build_identity(**common, unit_id="MAIN", canonical={"unitId": "MAIN"})


@pytest.mark.parametrize("unit_id,harness", [
    ("CLAUDE-1", "auto"), ("CODEX-1", "auto"), ("CURSOR-1", "auto"),
    ("WORKER-1", "claude"), ("WORKER-1", "codex"),
    ("WORKER-1", "cursor"), ("WORKER-1", "openclaw"),
    ("WORKER-1", "hermes"), ("WORKER-1", "auto"),
])
@pytest.mark.parametrize("selected_model", ["", "chosen-model"])
def test_dispatch_does_not_promote_provider_to_model(
    isolated_store, monkeypatch, tmp_path, unit_id, harness, selected_model,
):
    """Exercise real routing with fake adapters; no process or network execution."""
    from types import SimpleNamespace
    monkeypatch.setattr(ar, "_get_agent_config", lambda _: {"profile": str(tmp_path / "profile")})
    monkeypatch.setattr(ar, "_find_registry_profile", lambda _: None)
    monkeypatch.setattr(ar, "_container_mode_enabled", lambda: False)
    monkeypatch.setattr(ar._security_harness, "get_harness", lambda: SimpleNamespace(
        pre_dispatch_gate=lambda _: SimpleNamespace(blocked=False)))
    for adapter in ("claude_code", "codex", "cursor", "openclaw", "hermes_cli"):
        monkeypatch.setattr(ar, "_has_" + adapter, lambda: True)
    calls = []
    def fake_adapter(*args, **kwargs):
        calls.append(kwargs)
        return True, "isolated"
    for adapter in ("claude_code", "codex", "cursor_agent", "openclaw", "hermes_cli", "hermes"):
        monkeypatch.setattr(ar, "_run_" + adapter + "_streaming", fake_adapter)
    assert ar._execute_streaming(unit_id, "routing-fixture", "isolated", str(tmp_path),
                                 harness=harness, provider="openrouter", model=selected_model)[0]
    rows = [json.loads(line) for line in isolated_store.read_text().splitlines()]
    identity = next(row["data"] for row in rows if row["type"] == "ExecutionIdentityRecorded")
    if selected_model:
        assert identity["model"] == selected_model
    else:
        assert "model" not in identity
    # Identity correction must not change legacy adapter argument/routing behavior.
    assert len(calls) == 1
    assert calls[0]["model"] == (selected_model or "openrouter")


@pytest.mark.parametrize("selected_model", ["", "chosen-model"])
@pytest.mark.parametrize("winner", ["claude", "openclaw"])
def test_fallback_attempts_preserve_model_provenance(
    isolated_store, monkeypatch, tmp_path, selected_model, winner,
):
    from types import SimpleNamespace
    monkeypatch.setattr(ar, "_get_agent_config", lambda _: {})
    monkeypatch.setattr(ar, "_find_registry_profile", lambda _: None)
    monkeypatch.setattr(ar, "_container_mode_enabled", lambda: False)
    monkeypatch.setattr(ar._security_harness, "get_harness", lambda: SimpleNamespace(
        pre_dispatch_gate=lambda _: SimpleNamespace(blocked=False)))
    monkeypatch.setattr(ar, "_has_claude_code", lambda: True)
    monkeypatch.setattr(ar, "_has_openclaw", lambda: True)
    monkeypatch.setattr(ar, "_run_hermes_streaming", lambda *a, **k: (False, "isolated failure"))
    monkeypatch.setattr(ar, "_run_claude_code_streaming", lambda *a, **k: (winner == "claude", "isolated"))
    monkeypatch.setattr(ar, "_run_openclaw_streaming", lambda *a, **k: (True, "isolated"))
    assert ar._execute_streaming("WORKER-1", "fallback-fixture", "isolated", str(tmp_path),
                                 harness="auto", provider="openrouter", model=selected_model)[0]
    rows = [json.loads(line) for line in isolated_store.read_text().splitlines()]
    attempts = [row["data"] for row in rows if row["type"] == "ExecutionIdentityRecorded"]
    assert [d["harness"] for d in attempts] == (
        ["hermes", "claude"] if winner == "claude" else ["hermes", "claude", "openclaw"])
    for attempt in attempts:
        if selected_model:
            assert attempt["model"] == selected_model
        else:
            assert "model" not in attempt


def test_agent_display_name_is_not_automatically_a_unit_name():
    data = ei.build_identity(
        command_id="distinct-names", command_type="execute_agent", harness="hermes-cli",
        unit_id="WORKER-2", canonical={"unitId": "WORKER-2"},
        registry_profile=("WORKER", _profile("Worker")),
    )
    assert data["unitId"] == "WORKER-2"
    assert data["agentName"] == "Worker"
    assert "unitName" not in data
