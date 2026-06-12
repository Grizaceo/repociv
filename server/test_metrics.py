"""Tests for server/metrics.py — modelUsage extraction (E4) + step latency (Sprint B3) + hook stats (Sprint C2)."""

import pytest
from server.metrics import (
    compute_metrics,
    _compute_model_usage,
    record_step_latency,
    get_step_latency_stats,
    _latency_samples,
    record_hook_result,
    get_hook_stats,
    _hook_stats,
)


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


# ─── Step latency — record_step_latency / get_step_latency_stats ─────────────

@pytest.fixture(autouse=True)
def clear_latency_samples():
    """Ensure each test starts with a clean latency buffer."""
    _latency_samples.clear()
    yield
    _latency_samples.clear()


def test_empty_latency_returns_zero_count():
    stats = get_step_latency_stats()
    assert stats["count"] == 0
    assert stats["p50"] == 0.0
    assert stats["p95"] == 0.0
    assert stats["p99"] == 0.0
    assert stats["by_agent"] == {}


def test_single_record_stats():
    record_step_latency("repo1", "ISSUE-1", 0, "WORKER", 1.5)
    stats = get_step_latency_stats()
    assert stats["count"] == 1
    assert stats["p50"] == 1.5
    assert stats["p95"] == 1.5
    assert "WORKER" in stats["by_agent"]


def test_multiple_records_aggregated():
    for i, dur in enumerate([1.0, 2.0, 3.0, 4.0, 5.0]):
        record_step_latency("repo1", "ISSUE-1", i, "MAIN", dur)
    stats = get_step_latency_stats()
    assert stats["count"] == 5
    assert stats["p50"] > 0
    assert stats["p95"] >= stats["p50"]


def test_by_agent_separates_agents():
    record_step_latency("repo", "i1", 0, "MAIN", 1.0)
    record_step_latency("repo", "i1", 1, "WORKER", 2.0)
    record_step_latency("repo", "i1", 2, "SCOUT", 0.5)
    stats = get_step_latency_stats()
    assert set(stats["by_agent"].keys()) == {"MAIN", "WORKER", "SCOUT"}
    assert stats["by_agent"]["MAIN"]["count"] == 1
    assert stats["by_agent"]["WORKER"]["p50"] == 2.0


def test_agent_name_normalized_to_uppercase():
    record_step_latency("repo", "i1", 0, "worker", 1.0)
    stats = get_step_latency_stats()
    assert "WORKER" in stats["by_agent"]
    assert "worker" not in stats["by_agent"]


def test_compute_metrics_includes_step_latency():
    record_step_latency("repo", "i1", 0, "MAIN", 3.0)
    result = compute_metrics([], _DUMMY_AGENTS, queue_depth=0)
    assert "stepLatency" in result
    sl = result["stepLatency"]
    assert sl["count"] == 1
    assert sl["p50"] == 3.0
    assert "by_agent" in sl


# ─── Sprint C2: hook stats ────────────────────────────────────────────────────

@pytest.fixture(autouse=False)
def reset_hook_stats():
    """Reset global hook stats before and after each hook test."""
    _hook_stats.clear()
    yield
    _hook_stats.clear()


def test_get_hook_stats_empty(reset_hook_stats):
    stats = get_hook_stats()
    assert stats["total"] == 0
    assert stats["failures"] == 0
    assert stats["by_hook"] == {}


def test_record_hook_result_success_increments_total(reset_hook_stats):
    record_hook_result("pre_step", "myrepo", 0, 0.1)
    stats = get_hook_stats()
    assert stats["total"] == 1
    assert stats["failures"] == 0
    assert stats["by_hook"]["pre_step"]["total"] == 1
    assert stats["by_hook"]["pre_step"]["failures"] == 0


def test_record_hook_result_failure_increments_failures(reset_hook_stats):
    record_hook_result("post_step", "myrepo", 1, 0.5)
    stats = get_hook_stats()
    assert stats["total"] == 1
    assert stats["failures"] == 1
    assert stats["by_hook"]["post_step"]["failures"] == 1


def test_record_hook_result_multiple_hooks_aggregated(reset_hook_stats):
    record_hook_result("pre_step", "repo1", 0, 0.1)
    record_hook_result("pre_step", "repo2", 1, 0.2)
    record_hook_result("on_circuit_open", "repo1", 0, 0.3)
    stats = get_hook_stats()
    assert stats["total"] == 3
    assert stats["failures"] == 1
    assert stats["by_hook"]["pre_step"]["total"] == 2
    assert stats["by_hook"]["pre_step"]["failures"] == 1
    assert stats["by_hook"]["on_circuit_open"]["total"] == 1


def test_compute_metrics_includes_hook_stats(reset_hook_stats):
    record_hook_result("pre_step", "repo", 0, 0.1)
    result = compute_metrics([], _DUMMY_AGENTS, queue_depth=0)
    assert "hookStats" in result
    assert result["hookStats"]["total"] == 1

