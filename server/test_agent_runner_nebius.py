"""Nebius direct-agent path tests (fake client; no network)."""
from server import agent_runner as ar


def _fake_cascade(messages, tier="ECONOMICO", **kw):
    return {
        "content": f"nebius:{tier}",
        "model": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        "latency_ms": 42,
        "cost_estimate_usd": 0.00001,
        "fallback_from": None,
        "tier": tier,
    }


def test_run_nebius_agent_success(monkeypatch):
    monkeypatch.setattr("server.agent_runner.chat_nebius_cascade", _fake_cascade)
    result = ar.run_nebius_agent(
        mission="inspect the repo",
        working_dir=".",
        tier="ECONOMICO",
        timeout_s=30,
    )
    assert result["success"] is True
    assert result["provider"] == "nebius"
    assert result["content"].startswith("nebius:ECONOMICO")
    assert result["usage_tokens"] == 15