"""Tests for server/model_router.py — Sprint B1."""
from __future__ import annotations

import pytest
from server.model_router import route_model
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


# ─── Context param accepted (reserved for future) ────────────────────────────

def test_context_param_accepted():
    r = route_model("DAVI", "orchestrate", context={"urgency": "high"})
    assert r["model"] == "claude-opus-4-5"


# ─── Return shape ─────────────────────────────────────────────────────────────

def test_return_has_all_required_keys():
    r = route_model("SCOUT", "read")
    assert set(r.keys()) >= {"model", "enforced", "reason"}


def test_reason_is_non_empty_string():
    r = route_model("WORKER", "edit")
    assert isinstance(r["reason"], str)
    assert len(r["reason"]) > 0


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


def test_infer_task_type_unknown_defaults_to_edit():
    assert _infer_task_type("UNKNOWN") == "edit"


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
