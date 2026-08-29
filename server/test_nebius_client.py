"""Tests for the Nebius Token Factory client (mocked HTTP; no network)."""
from __future__ import annotations

import pytest


class _FakeResponse:
    def __init__(self, payload: dict, status: int = 200):
        self._payload = payload
        self.status_code = status
    def json(self) -> dict:
        return self._payload
    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def _ok_content(model: str) -> dict:
    return {
        "choices": [{"message": {"content": f"answer-from-{model}"}}],
        "model": model,
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }


def test_model_ids_are_exact():
    from server.nebius_client import NEBIUS_MODELS
    assert NEBIUS_MODELS["ECONOMICO"] == "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
    assert NEBIUS_MODELS["EQUILIBRIO"] == "nvidia/nemotron-3-super-120b-a12b"
    assert NEBIUS_MODELS["PREMIUM"] == "nvidia/Nemotron-3-Ultra-550b-a55b"


def test_base_url_is_token_factory():
    from server.nebius_client import NEBIUS_BASE_URL
    assert NEBIUS_BASE_URL == "https://api.tokenfactory.nebius.com/v1"


def test_chat_nebius_success(monkeypatch):
    from server import nebius_client as nc
    seen = {}
    def _fake_post(url, headers=None, json=None, timeout=None):
        seen["url"] = url
        seen["auth"] = headers.get("Authorization")
        seen["model"] = json["model"]
        return _FakeResponse(_ok_content(json["model"]))
    monkeypatch.setattr(nc, "_post_with_retries", _fake_post)  # real HTTP seam
    out = nc.chat_nebius(
        [{"role": "user", "content": "hi"}],
        tier="ECONOMICO",
        api_key="test-key-123",
    )
    assert seen["url"].endswith("/chat/completions")
    assert seen["url"].startswith("https://api.tokenfactory.nebius.com/v1")
    assert seen["auth"] == "Bearer test-key-123"
    assert seen["model"] == "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
    assert out["content"] == "answer-from-nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B"
    assert out["latency_ms"] >= 0
    assert out["fallback_from"] is None


def test_chat_nebius_requires_key(monkeypatch):
    from server import nebius_client as nc
    monkeypatch.delenv("NEBIUS_API_KEY", raising=False)
    with pytest.raises(nc.NebiusNotConfigured):
        nc.chat_nebius([{"role": "user", "content": "x"}], api_key=None)


def test_cascade_degrades_to_next_tier(monkeypatch):
    """Starting-tier-first: EQUILIBRIO tries Super, then degrades to Nano (never
    escalates to Ultra on its own — Ultra must be an explicit PRAETORIAN ask)."""
    from server import nebius_client as nc
    calls = []
    def _fake_post(url, headers=None, json=None, timeout=None):
        calls.append(json["model"])
        if json["model"] == nc.NEBIUS_MODELS["EQUILIBRIO"]:
            return _FakeResponse({}, status=500)  # Super down -> raise_for_status
        return _FakeResponse(_ok_content(json["model"]))
    monkeypatch.setattr(nc, "_post_with_retries", _fake_post)
    out = nc.chat_nebius_cascade(
        [{"role": "user", "content": "hi"}],
        tier="EQUILIBRIO",
        api_key="k",
    )
    assert calls[0] == nc.NEBIUS_MODELS["EQUILIBRIO"]          # started at its tier
    assert calls[-1] == nc.NEBIUS_MODELS["ECONOMICO"]          # degraded, not escalated
    assert out["content"] == "answer-from-" + nc.NEBIUS_MODELS["ECONOMICO"]
    assert out["fallback_from"] == nc.NEBIUS_MODELS["EQUILIBRIO"]