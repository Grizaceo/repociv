"""Tests for server/metrics.py — modelUsage extraction (E4)."""

import pytest
from server.metrics import compute_metrics, _compute_model_usage


_DUMMY_AGENTS = [{"id": "a1", "status": "idle", "activeTasks": None}]


# ─── _compute_model_usage ────────────────────────────────────────────────

def test_model_usage_empty_events():
    assert _compute_model_usage([]) == []


def test_model_usage_no_command_completed():
    events = [
        {"type": "CommandCreated", "commandId": "c1", "data": {}},
        {"type": "CommandStarted", "commandId": "c1", "data": {}},
    ]
    assert _compute_model_usage(events) == []


def test_model_usage_command_completed_without_model():
    events = [
        {"type": "CommandCompleted", "commandId": "c1", "data": {"tokensIn": 100}},
    ]
    assert _compute_model_usage(events) == []


def test_model_usage_single_model():
    events = [
        {
            "type": "CommandCompleted",
            "commandId": "c1",
            "data": {
                "model": "gpt-4",
                "tokensIn": 100,
                "tokensOut": 50,
                "costEstimate": 0.005,
            },
        },
    ]
    result = _compute_model_usage(events)
    assert len(result) == 1
    assert result[0]["model"] == "gpt-4"
    assert result[0]["tokensIn"] == 100
    assert result[0]["tokensOut"] == 50
    assert result[0]["costEstimate"] == 0.005


def test_model_usage_aggregates_same_model():
    """Multiple completed calls for the same model are aggregated."""
    events = [
        {
            "type": "CommandCompleted",
            "commandId": "c1",
            "data": {"model": "gpt-4", "tokensIn": 100, "tokensOut": 50, "costEstimate": 0.01},
        },
        {
            "type": "CommandCompleted",
            "commandId": "c2",
            "data": {"model": "gpt-4", "tokensIn": 200, "tokensOut": 100, "costEstimate": 0.02},
        },
    ]
    result = _compute_model_usage(events)
    assert len(result) == 1
    assert result[0]["model"] == "gpt-4"
    assert result[0]["tokensIn"] == 300
    assert result[0]["tokensOut"] == 150
    assert result[0]["costEstimate"] == 0.03
    assert result[0]["calls"] == 2


def test_model_usage_multiple_models():
    events = [
        {
            "type": "CommandCompleted",
            "commandId": "c1",
            "data": {"model": "gpt-4", "tokensIn": 10, "tokensOut": 5, "costEstimate": 0.001},
        },
        {
            "type": "CommandCompleted",
            "commandId": "c2",
            "data": {"model": "claude-3", "tokensIn": 30, "tokensOut": 15, "costEstimate": 0.003},
        },
        {
            "type": "CommandCompleted",
            "commandId": "c3",
            "data": {"model": "deepseek", "tokensIn": 50, "tokensOut": 20, "costEstimate": 0.002},
        },
    ]
    result = _compute_model_usage(events)
    assert len(result) == 3
    models = [r["model"] for r in result]
    assert models == ["gpt-4", "claude-3", "deepseek"]


def test_model_usage_mixed_events():
    """Other event types are ignored, only CommandCompleted contributes."""
    events = [
        {"type": "CommandCreated", "commandId": "c1", "data": {"model": "gpt-4"}},
        {"type": "CommandStarted", "commandId": "c1", "data": {}},
        {
            "type": "CommandCompleted",
            "commandId": "c1",
            "data": {"model": "gpt-4", "tokensIn": 40, "tokensOut": 20, "costEstimate": 0.004},
        },
        {"type": "CommandFailed", "commandId": "c2", "data": {"model": "bad"}},
    ]
    result = _compute_model_usage(events)
    assert len(result) == 1
    assert result[0]["model"] == "gpt-4"


def test_model_usage_missing_fields_defaults():
    events = [
        {
            "type": "CommandCompleted",
            "commandId": "c1",
            "data": {"model": "llama3"},  # no tokensIn, tokensOut, costEstimate
        },
    ]
    result = _compute_model_usage(events)
    assert len(result) == 1
    assert result[0]["tokensIn"] == 0
    assert result[0]["tokensOut"] == 0
    assert result[0]["costEstimate"] == 0.0


# ─── Integration via compute_metrics ─────────────────────────────────────

def test_compute_metrics_includes_model_usage():
    events = [
        {
            "type": "CommandCompleted",
            "commandId": "c1",
            "data": {"model": "gpt-4", "tokensIn": 10, "tokensOut": 5, "costEstimate": 0.01},
        },
    ]
    result = compute_metrics(events, _DUMMY_AGENTS, queue_depth=0)
    assert "modelUsage" in result
    assert isinstance(result["modelUsage"], list)
    assert len(result["modelUsage"]) == 1
    assert result["modelUsage"][0]["model"] == "gpt-4"


def test_compute_metrics_model_usage_empty_when_no_data():
    result = compute_metrics([], _DUMMY_AGENTS, queue_depth=0)
    assert "modelUsage" in result
    assert result["modelUsage"] == []


def test_compute_metrics_ignores_smoke_failures_for_health():
    events = [
        {
            "type": "CommandCreated",
            "commandId": "smoke-1",
            "data": {"id": "smoke-1", "target": "smoke-test", "payload": {"unit": "SCOUT"}},
        },
        {
            "type": "CommandFailed",
            "data": {"id": "smoke-1", "error": "synthetic smoke failure"},
            "timestamp": 1,
        },
    ]
    result = compute_metrics(events, _DUMMY_AGENTS, queue_depth=0)
    assert result["health"] == "ok"
    assert result["errorRate"] == 0.0
    assert result["failedCount"] == 0
    assert result["recentFailures"] == []
