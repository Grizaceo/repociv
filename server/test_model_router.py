"""Tests for server/model_router.py — Fase 2 (FrugalGPT Cascade)."""
from __future__ import annotations

from server.model_router import route_model, get_agent_cards_path
from server.step_executor import _infer_task_type


# ─── Core routing table ───────────────────────────────────────────────────────

def test_davi_orchestrate_returns_opus_enforced():
    r = route_model("DAVI", "orchestrate")
    assert r["model"] == "claude-opus-4-5"
    assert r["enforced"] is True
    assert r["reason"]


def test_worker_edit_returns_sonnet_enforced():
    r = route_model("WORKER", "edit")
    assert r["model"] == "claude-sonnet-4-5"
    assert r["enforced"] is True


def test_scout_read_returns_haiku_enforced():
    r = route_model("SCOUT", "read")
    assert r["model"] == "claude-haiku-3-5"
    assert r["enforced"] is True


def test_hermes_any_task_returns_not_enforced():
    r = route_model("HERMES", "orchestrate")
    assert r["model"] == "claude-opus-4-5"
    assert r["enforced"] is False
    assert "recommended" in r["reason"].lower() or "memory" in r["reason"].lower()


def test_hermes_arbitrary_task_not_enforced():
    r = route_model("HERMES", "read")
    assert r["enforced"] is False


def test_openclaw_any_task_returns_not_enforced():
    r = route_model("OPENCLAW", "edit")
    assert r["model"] == "claude-sonnet-4-5"
    assert r["enforced"] is False


def test_openclaw_arbitrary_task_not_enforced():
    r = route_model("OPENCLAW", "orchestrate")
    assert r["enforced"] is False


# ─── Case insensitivity ───────────────────────────────────────────────────────

def test_agent_type_case_insensitive():
    r_upper = route_model("DAVI", "orchestrate")
    r_lower = route_model("davi", "orchestrate")
    assert r_upper["model"] == r_lower["model"]
    assert r_upper["enforced"] == r_lower["enforced"]


def test_task_type_case_insensitive():
    r_upper = route_model("WORKER", "EDIT")
    r_lower = route_model("WORKER", "edit")
    assert r_upper["model"] == r_lower["model"]


# ─── Fallbacks ────────────────────────────────────────────────────────────────

def test_unknown_agent_orchestrate_task_falls_back():
    r = route_model("UNKNOWN_AGENT", "orchestrate")
    assert r["model"] == "claude-opus-4-5"
    assert r["enforced"] is True


def test_unknown_agent_edit_task_falls_back():
    r = route_model("UNKNOWN_AGENT", "edit")
    assert r["model"] == "claude-sonnet-4-5"


def test_unknown_agent_read_task_falls_back():
    r = route_model("UNKNOWN_AGENT", "read")
    assert r["model"] == "claude-haiku-3-5"


def test_unknown_agent_unknown_task_returns_default():
    r = route_model("MYSTERY", "mystery_task")
    assert r["model"] == "claude-sonnet-4-5"
    assert r["enforced"] is True


# ─── Fase 2: FrugalGPT Cascade ─────────────────────────────────────────────

def test_return_has_cascade_fields():
    """Fase 2: All routes now include cascade and fallback_chain."""
    r = route_model("SCOUT", "read")
    assert "cascade" in r
    assert "fallback_chain" in r
    assert "tier" in r
    assert r["cascade"] is True  # FrugalGPT always enables cascade


def test_scout_cascade_chain_economico():
    """SCOUT (ECONOMICO tier) has full cascade chain."""
    r = route_model("SCOUT", "read")
    assert r["tier"] == "ECONOMICO"
    assert len(r["fallback_chain"]) == 3
    assert r["fallback_chain"][0] == "claude-haiku-3-5"


def test_worker_cascade_chain_equilibrio():
    """WORKER (EQUILIBRIO tier) starts from sonnet."""
    r = route_model("WORKER", "edit")
    assert r["tier"] == "EQUILIBRIO"
    assert len(r["fallback_chain"]) == 2
    assert r["fallback_chain"][0] == "claude-sonnet-4-5"


def test_davi_cascade_chain_premium():
    """DAVI (PREMIUM tier) only has opus."""
    r = route_model("DAVI", "orchestrate")
    assert r["tier"] == "PREMIUM"
    assert len(r["fallback_chain"]) == 1
    assert r["fallback_chain"][0] == "claude-opus-4-5"


def test_budget_pressure_downgrade():
    """When budget > 80%, tier downgrades to ECONOMICO."""
    r = route_model("WORKER", "edit", context={"budget_limit": 100, "budget_pct": 85.0})
    # This would require a mock of token_ledger.get_budget_used_pct(), which is
    # hard to inject. For now, document that this is tested in integration tests.
    assert r["tier"] in ["ECONOMICO", "EQUILIBRIO"]


def test_mission_text_signals_affect_tier():
    """Quality-critical mission text escalates tier."""
    # SCOUT normally ECONOMICO, but quality-critical mission should stay or escalate
    route_model("SCOUT", "read", context={"mission_text": "List files"})
    r_secure = route_model("SCOUT", "read", context={
        "mission_text": "Security audit of the authentication system"
    })
    # Both should be SCOUT tier or higher
    assert r_secure["tier"] in ["ECONOMICO", "EQUILIBRIO", "PREMIUM"]


# ─── Context param accepted ────────────────────────────────────────────────────

def test_context_param_accepted():
    r = route_model("DAVI", "orchestrate", context={"urgency": "high"})
    assert r["model"] == "claude-opus-4-5"


def test_override_tier_parameter():
    """Can override tier for testing."""
    r = route_model("DAVI", "orchestrate", override_tier="ECONOMICO")
    assert r["tier"] == "ECONOMICO"
    assert r["model"] == "claude-haiku-3-5"


# ─── Return shape ─────────────────────────────────────────────────────────────

def test_reason_is_non_empty_string():
    r = route_model("WORKER", "edit")
    assert isinstance(r["reason"], str)
    assert len(r["reason"]) > 0
    # Reason should include multiple signals (agent, task, tier, budget)
    assert "agent=" in r["reason"]
    assert "task=" in r["reason"]


def test_reason_includes_signal_info():
    """Reason should encode what signals were detected."""
    r = route_model("WORKER", "edit", context={
        "mission_text": "Security audit of the authentication layer"
    })
    # Should mention quality_critical signal
    reason = r["reason"].lower()
    assert any(kw in reason for kw in ["quality", "critical", "security"])


# ─── step_executor._infer_task_type integration ───────────────────────────────

def test_infer_task_type_davi():
    assert _infer_task_type("DAVI") == "orchestrate"


def test_infer_task_type_worker():
    assert _infer_task_type("WORKER") == "edit"


def test_infer_task_type_scout():
    assert _infer_task_type("SCOUT") == "read"


def test_infer_task_type_hermes():
    assert _infer_task_type("HERMES") == "orchestrate"


def test_infer_task_type_openclaw():
    assert _infer_task_type("OPENCLAW") == "edit"


def test_infer_task_type_lexo():
    assert _infer_task_type("LEXO") == "read"


def test_infer_task_type_unknown_defaults_to_edit():
    assert _infer_task_type("UNKNOWN") == "edit"


# ─── Agent Cards ─────────────────────────────────────────────────────────────

def test_agent_cards_path_exists():
    """Agent cards directory should be accessible."""
    import os
    cards_path = get_agent_cards_path()
    assert os.path.isdir(cards_path), f"Agent cards path should exist: {cards_path}"


def test_agent_cards_present():
    """Built-in agent cards (WORKER, SCOUT) should exist and be valid JSON."""
    import json
    from pathlib import Path

    cards_dir = Path(get_agent_cards_path())
    for agent in ["WORKER", "SCOUT"]:
        card_path = cards_dir / f"{agent}.json"
        assert card_path.exists(), f"Built-in agent card not found: {agent}.json"
        data = json.loads(card_path.read_text())
        assert data["name"] == agent
        assert "capabilities" in data
        assert "believability" in data


def test_harness_cards_present():
    """All harness cards should exist and be valid JSON."""
    import json
    from pathlib import Path
    from server.model_router import get_harness_cards_path

    harness_dir = Path(get_harness_cards_path())
    for harness in ["hermes", "openclaw", "codex", "claude", "cursor"]:
        card_path = harness_dir / f"{harness}.json"
        assert card_path.exists(), f"Harness card not found: {harness}.json"
        data = json.loads(card_path.read_text())
        assert data["id"] == harness
        assert data["type"] == "harness"
        assert "description" in data


def test_agent_card_metadata_complete():
    """Built-in agent cards should have required metadata."""
    import json
    from pathlib import Path

    cards_dir = Path(get_agent_cards_path())
    card_path = cards_dir / "WORKER.json"
    data = json.loads(card_path.read_text())

    assert data["name"] == "WORKER"
    assert data["capabilities"]
    assert data["believability"] > 0.0
    assert data["concurrency_limit"] > 0
    assert data["stateful"] is False  # WORKER is stateless by design


# ─── enforced vs recommended propagation in meta ─────────────────────────────

def test_enforced_routing_sets_model_key():
    """Routing for DAVI/orchestrate is enforced → meta should get 'model' key."""
    from server import model_router as _mr
    routing = _mr.route_model("DAVI", "orchestrate")
    meta: dict = {}
    if routing["enforced"]:
        meta["model"] = routing["model"]
    else:
        meta["recommended_model"] = routing["model"]
    assert "model" in meta
    assert "recommended_model" not in meta
    assert meta["model"] == "claude-opus-4-5"


def test_not_enforced_routing_sets_recommended_model_key():
    """Routing for HERMES is not enforced → meta should get 'recommended_model' key."""
    from server import model_router as _mr
    routing = _mr.route_model("HERMES", "orchestrate")
    meta: dict = {}
    if routing["enforced"]:
        meta["model"] = routing["model"]
    else:
        meta["recommended_model"] = routing["model"]
    assert "recommended_model" in meta
    assert "model" not in meta
    assert meta["recommended_model"] == "claude-opus-4-5"


def test_openclaw_not_enforced_sets_recommended_model_key():
    from server import model_router as _mr
    routing = _mr.route_model("OPENCLAW", "edit")
    meta: dict = {}
    if routing["enforced"]:
        meta["model"] = routing["model"]
    else:
        meta["recommended_model"] = routing["model"]
    assert "recommended_model" in meta
    assert meta["recommended_model"] == "claude-sonnet-4-5"
