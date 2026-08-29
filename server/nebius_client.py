"""Nebius Token Factory client — first-class sponsor runtime call.

Stage-1-critical: this module makes the sponsor's API a VISIBLE, direct
inference path in RepoCiv (no CLI delegation). OpenAI-compatible chat
completions with tier-based model cascade + cost/latency accounting.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

log = logging.getLogger(__name__)

NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1"
# Verified against the official token-factory-cookbook (2026-08-29).
NEBIUS_MODELS: dict[str, str] = {
    "ECONOMICO": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    "EQUILIBRIO": "nvidia/nemotron-3-super-120b-a12b",
    "PREMIUM": "nvidia/Nemotron-3-Ultra-550b-a55b",
}

# Nemotron-3 2026 pricing on Token Factory ($/1M tokens in/out). Values are
# upper-bound estimates; update from the dashboard if they shift.
_PRICE_PER_MTOK: dict[str, tuple[float, float]] = {
    "ECONOMICO": (0.15, 0.60),
    "EQUILIBRIO": (0.60, 1.80),
    "PREMIUM": (0.80, 3.00),
}

# TIER cascade: cheap-first per FrugalGPT. ECONOMICO may escalate fully; the
# STARTING tier fixes where the chain begins (matches model_router semantics).
_CASCADE: dict[str, list[str]] = {
    "ECONOMICO": ["ECONOMICO", "EQUILIBRIO", "PREMIUM"],
    "EQUILIBRIO": ["EQUILIBRIO", "ECONOMICO"],   # degrade, don't pay Ultra
    "PREMIUM": ["PREMIUM"],                       # no down-cascade (rare+expensive)
}


class NebiusNotConfigured(RuntimeError):
    """NEBIUS_API_KEY missing."""


def _resolve_key(api_key: str | None) -> str:
    return api_key or os.environ.get("NEBIUS_API_KEY", "").strip()


def _post_with_retries(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: float) -> Any:
    """POST with small fixed retry on transient failures. Test seam.

    Returns the HTTP response object; the consumer calls raise_for_status()
    + json() (keeps the seam compatible with response-object fakes in tests,
    where the sim of HTTP 500 relies on the consumer raising).
    NOTE: deviation from plan verbatim (plan returned resp.json() here, which
    contradicted the plan's own test seam contract) — documented in the
    hackathon update log.
    """
    last: Exception | None = None
    for attempt in range(3):
        try:
            resp = httpx.post(url, headers=headers, json=payload, timeout=timeout)
            resp.raise_for_status()
            return resp
        except Exception as exc:  # transient network/5xx — retryable
            last = exc
            time.sleep(0.5 * (2 ** attempt))
    raise last if last else RuntimeError("unreachable")


def chat_nebius(
    messages: list[dict[str, str]],
    tier: str = "ECONOMICO",
    temperature: float = 0.2,
    max_tokens: int = 4096,
    timeout_s: float = 120.0,
    api_key: str | None = None,
) -> dict[str, Any]:
    """Single-model call to Token Factory. Raises NebiusNotConfigured without key."""
    key = _resolve_key(api_key)
    if not key:
        raise NebiusNotConfigured("NEBIUS_API_KEY is not set")
    model = NEBIUS_MODELS.get(tier, NEBIUS_MODELS["ECONOMICO"])
    return _call_model(model, messages, key, temperature, max_tokens, timeout_s)


def _call_model(
    model: str,
    messages: list[dict[str, str]],
    key: str,
    temperature: float,
    max_tokens: int,
    timeout_s: float,
) -> dict[str, Any]:
    started = time.monotonic()
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    response = _post_with_retries(f"{NEBIUS_BASE_URL}/chat/completions", headers, payload, timeout_s)
    response.raise_for_status()
    data = response.json()
    latency_ms = int((time.monotonic() - started) * 1000)
    usage = data.get("usage", {"prompt_tokens": 0, "completion_tokens": 0})
    tier = next((t for t, m in NEBIUS_MODELS.items() if m == model), "ECONOMICO")
    pin, pout = _PRICE_PER_MTOK.get(tier, (0.15, 0.60))
    cost = usage.get("prompt_tokens", 0) / 1e6 * pin + usage.get("completion_tokens", 0) / 1e6 * pout
    return {
        "content": data["choices"][0]["message"]["content"],
        "model": model,
        "usage": usage,
        "latency_ms": latency_ms,
        "cost_estimate_usd": round(cost, 6),
        "fallback_from": None,
    }


def chat_nebius_cascade(
    messages: list[dict[str, str]],
    tier: str = "ECONOMICO",
    temperature: float = 0.2,
    max_tokens: int = 4096,
    timeout_s: float = 120.0,
    api_key: str | None = None,
    chain: list[str] | None = None,
) -> dict[str, Any]:
    """Try models in cascade order; return first success. No key => raise."""
    key = _resolve_key(api_key)
    if not key:
        raise NebiusNotConfigured("NEBIUS_API_KEY is not set")
    chain = chain or _CASCADE.get(tier, ["ECONOMICO", "EQUILIBRIO", "PREMIUM"])
    first: str | None = None
    err: Exception | None = None
    for t in chain:
        try:
            out = _call_model(NEBIUS_MODELS[t], messages, key, temperature, max_tokens, timeout_s)
            out["fallback_from"] = first
            return out
        except Exception as exc:
            if first is None:
                first = NEBIUS_MODELS[t]
            err = exc
            log.warning("[nebius] model %s failed, cascading: %s", NEBIUS_MODELS[t], exc)
    raise err if err else RuntimeError("cascade exhausted")