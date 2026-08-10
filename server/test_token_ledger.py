"""Tests for server/token_ledger.py (Fase 0)."""
from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from server.token_ledger import TokenLedger


@pytest.fixture()
def ledger(tmp_path: Path) -> TokenLedger:
    """Fresh ledger backed by a temp directory."""
    return TokenLedger(state_dir=tmp_path)


# ── Basic accumulation ────────────────────────────────────────────────────────

def test_initial_state_is_zero(ledger: TokenLedger) -> None:
    s = ledger.get_summary()
    assert s["total_prompt_tokens"] == 0
    assert s["total_completion_tokens"] == 0
    assert s["total_tokens"] == 0
    assert s["total_cost_estimate"] == 0.0


def test_log_usage_accumulates(ledger: TokenLedger) -> None:
    ledger.log_usage("claude-haiku", 100, 50)
    s = ledger.get_summary()
    assert s["total_prompt_tokens"] == 100
    assert s["total_completion_tokens"] == 50
    assert s["total_tokens"] == 150


def test_log_usage_multiple_calls(ledger: TokenLedger) -> None:
    ledger.log_usage("claude-haiku", 200, 100)
    ledger.log_usage("claude-sonnet", 300, 150)
    s = ledger.get_summary()
    assert s["total_prompt_tokens"] == 500
    assert s["total_completion_tokens"] == 250
    assert s["total_tokens"] == 750


def test_cost_estimate_claude_sonnet(ledger: TokenLedger) -> None:
    # 1000 prompt tokens @ $0.003/1k + 1000 completion @ $0.015/1k = $0.018
    ledger.log_usage("claude-sonnet-4-5", 1000, 1000)
    s = ledger.get_summary()
    assert abs(s["total_cost_estimate"] - 0.018) < 1e-6


def test_cost_estimate_claude_haiku(ledger: TokenLedger) -> None:
    # 1000 prompt @ $0.00025/1k + 1000 completion @ $0.00125/1k = $0.0015
    ledger.log_usage("claude-haiku-3-5", 1000, 1000)
    s = ledger.get_summary()
    assert abs(s["total_cost_estimate"] - 0.0015) < 1e-6


def test_unknown_model_zero_cost(ledger: TokenLedger) -> None:
    ledger.log_usage("some-unknown-model-x", 500, 500)
    s = ledger.get_summary()
    assert s["total_cost_estimate"] == 0.0
    assert s["total_tokens"] == 1000


# ── Budget checks ──────────────────────────────────────────────────────────────

def test_check_budget_violation_below_limit(ledger: TokenLedger) -> None:
    ledger.log_usage("claude-haiku", 100, 50)
    assert ledger.check_budget_violation(500) is False


def test_check_budget_violation_at_limit(ledger: TokenLedger) -> None:
    ledger.log_usage("claude-haiku", 100, 50)  # total = 150
    assert ledger.check_budget_violation(150) is True


def test_check_budget_violation_above_limit(ledger: TokenLedger) -> None:
    ledger.log_usage("claude-haiku", 400, 200)  # total = 600
    assert ledger.check_budget_violation(500) is True


def test_get_budget_used_pct_zero_tokens(ledger: TokenLedger) -> None:
    pct = ledger.get_budget_used_pct(10_000)
    assert pct == 0.0


def test_get_budget_used_pct_half(ledger: TokenLedger) -> None:
    ledger.log_usage("claude-haiku", 5_000, 0)
    pct = ledger.get_budget_used_pct(10_000)
    assert abs(pct - 50.0) < 0.01


def test_get_budget_used_pct_over_100_clamped(ledger: TokenLedger) -> None:
    ledger.log_usage("claude-haiku", 20_000, 0)
    pct = ledger.get_budget_used_pct(10_000)
    assert pct == 100.0


def test_get_budget_used_pct_zero_limit(ledger: TokenLedger) -> None:
    assert ledger.get_budget_used_pct(0) == 100.0


# ── Persistence ────────────────────────────────────────────────────────────────

def test_persists_to_disk(tmp_path: Path) -> None:
    l1 = TokenLedger(state_dir=tmp_path)
    l1.log_usage("claude-sonnet", 300, 100)

    l2 = TokenLedger(state_dir=tmp_path)  # new instance, same dir
    s = l2.get_summary()
    assert s["total_prompt_tokens"] == 300
    assert s["total_completion_tokens"] == 100


def test_persisted_file_is_valid_json(tmp_path: Path) -> None:
    ledger = TokenLedger(state_dir=tmp_path)
    ledger.log_usage("claude-haiku", 50, 25)
    data = json.loads((tmp_path / "token_usage.json").read_text())
    assert "total_prompt_tokens" in data
    assert "total_completion_tokens" in data
    assert "total_cost_estimate" in data


# ── Reset ──────────────────────────────────────────────────────────────────────

def test_reset_clears_accumulators(ledger: TokenLedger) -> None:
    ledger.log_usage("claude-haiku", 100, 50)
    ledger.reset()
    s = ledger.get_summary()
    assert s["total_tokens"] == 0
    assert s["total_cost_estimate"] == 0.0


def test_reset_deletes_file(tmp_path: Path) -> None:
    ledger = TokenLedger(state_dir=tmp_path)
    ledger.log_usage("claude-haiku", 100, 50)
    assert (tmp_path / "token_usage.json").exists()
    ledger.reset()
    assert not (tmp_path / "token_usage.json").exists()


# ── Thread safety ──────────────────────────────────────────────────────────────

def test_concurrent_log_usage_is_thread_safe(tmp_path: Path) -> None:
    ledger = TokenLedger(state_dir=tmp_path)
    threads = [
        threading.Thread(target=ledger.log_usage, args=("claude-haiku", 10, 5))
        for _ in range(50)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    s = ledger.get_summary()
    assert s["total_prompt_tokens"] == 500
    assert s["total_completion_tokens"] == 250


# ── Per-agent tracking (XCOM fatigue source) ─────────────────────────────────

def test_log_usage_tracks_per_agent(ledger: TokenLedger) -> None:
    ledger.log_usage("claude-haiku", 100, 50, agent="WORKER")
    ledger.log_usage("claude-sonnet", 200, 100, agent="WORKER")
    ledger.log_usage("claude-haiku", 10, 5, agent="SCOUT")

    w = ledger.get_agent_usage("WORKER")
    assert w["prompt"] == 300
    assert w["completion"] == 150
    assert w["total"] == 450
    assert w["lastAt"] > 0

    s = ledger.get_agent_usage("SCOUT")
    assert s["total"] == 15

    # Unknown agent: zeros, never worked.
    assert ledger.get_agent_usage("nobody") == {"prompt": 0, "completion": 0, "total": 0, "lastAt": 0.0}


def test_agent_usage_persists_across_instances(tmp_path: Path) -> None:
    l1 = TokenLedger(state_dir=tmp_path)
    l1.log_usage("claude-haiku", 100, 50, agent="WORKER")

    l2 = TokenLedger(state_dir=tmp_path)
    assert l2.get_agent_usage("WORKER")["total"] == 150


def test_agent_fatigue_fresh_for_unknown_agent(ledger: TokenLedger) -> None:
    assert ledger.get_agent_fatigue("nobody") == 100


def test_agent_fatigue_drops_with_tokens(ledger: TokenLedger) -> None:
    # 100k tokens consumed recently against a 200k max → 50% fatigue.
    ledger.log_usage("claude-haiku", 100_000, 0, agent="WORKER")
    fatigue = ledger.get_agent_fatigue("WORKER", window_s=3600.0, max_tokens=200_000)
    assert fatigue == 50


def test_agent_fatigue_recovers_after_window(ledger: TokenLedger, monkeypatch) -> None:
    import time as _time

    ledger.log_usage("claude-haiku", 100_000, 0, agent="WORKER")
    # Simulate the agent resting: advance the clock past the window.
    real_time = _time.time
    monkeypatch.setattr(_time, "time", lambda: real_time() + 7200.0)
    assert ledger.get_agent_fatigue("WORKER", window_s=3600.0, max_tokens=200_000) == 100


def test_agent_fatigue_manual_override_wins(ledger: TokenLedger) -> None:
    # A heavy consumer still reports fresh if the manual fatigue state says so —
    # the bridge provider prefers explicit values over token-derived ones.
    ledger.log_usage("claude-haiku", 100_000, 0, agent="WORKER")
    assert ledger.get_agent_fatigue("WORKER", window_s=3600.0, max_tokens=200_000) < 100


