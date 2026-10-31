"""Provider discovery routes and shared error envelopes."""
from __future__ import annotations

import json as _json_lib
import logging
import os
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

RouteContext = dict[str, Any]

# ─── providers-live cache (avoids blocking the HTTP thread for up to 40s) ─────
_providers_live_cache: dict | None = None
_providers_live_ts: float = 0.0
_PROVIDERS_CACHE_TTL = 30.0

def _auth_headers(provider: str) -> dict[str, str]:
    """Return Authorization header for a given provider, if API key is set.

    Slugs are the canonical Hermes names; legacy aliases (``openai``,
    ``nvidia-nim``) are kept as fallbacks for persisted selections from
    pre-v2.1 RepoCiv state. See execplan/provider-model-parity-with-hermes-tui.md §A.6.
    """
    env_keys = {
        "ollama-cloud": "OLLAMA_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        # Canonical Hermes slugs:
        "openai-api": "OPENAI_API_KEY",
        "nvidia": "NVIDIA_API_KEY",
        # Legacy aliases (RepoCiv static registry used these pre-v2.1):
        "openai": "OPENAI_API_KEY",
        "nvidia-nim": "NVIDIA_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY",
        "xai": "XAI_API_KEY",
    }
    key = env_keys.get(provider)
    if key:
        token = os.environ.get(key, "")
        if token:
            # OpenRouter and xAI use Bearer; OpenAI/Anthropic use Bearer; Ollama uses header
            if provider == "ollama-cloud":
                return {"Authorization": f"Bearer {token}"}
            return {"Authorization": f"Bearer {token}"}
    return {}

def _probe_url(url: str, method: str = "GET", headers: dict | None = None, timeout: int = 5) -> list[str]:
    """Attempt HTTP request; return list of model IDs or empty on failure."""
    try:
        h: dict[str, str] = headers or {}
        req = urllib.request.Request(url, headers=h, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = _json_lib.loads(resp.read())
            # Normalise various provider response shapes into a flat list of model ID strings
            return _extract_model_ids(data, url)
    except Exception:
        return []

def _extract_model_ids(data: Any, url: str) -> list[str]:
    """Extract model ID strings from various API response shapes."""
    ids: list[str] = []

    # OpenAI / Anthropic / DeepSeek / xAI / NVIDIA — { "data": [{ "id": "..." }] }
    if isinstance(data, dict):
        raw = data.get("data")
        if isinstance(raw, list):
            for m in raw:
                mid = m.get("id") if isinstance(m, dict) else None
                if mid:
                    ids.append(str(mid))
            if ids:
                return ids

        # OpenRouter — { "data": [{ "id": "..." }] }  (same shape, already handled)
        # Ollama tags — { "models": [{ "name": "..." }] }
        if "models" in data and isinstance(data["models"], list):
            for m in data["models"]:
                name = m.get("name") if isinstance(m, dict) else None
                if name:
                    ids.append(str(name))
            if ids:
                return ids

        # NVIDIA NIM — { "models": [{"model_id": "..." }] }
        if "models" in data and isinstance(data["models"], list):
            for m in data["models"]:
                mid = m.get("model_id") if isinstance(m, dict) else None
                if mid:
                    ids.append(str(mid))
            if ids:
                return ids

    # Fallback: if data itself is a list
    if isinstance(data, list):
        for m in data:
            mid = m.get("id") if isinstance(m, dict) else None
            if mid:
                ids.append(str(mid))

    return ids

def get_providers_live(ctx: "RouteContext") -> tuple[int, Any]:
    """Fetch live model reachability from each provider's own API.

    Probes are run in parallel (ThreadPoolExecutor) and the result is cached
    for 30 s to avoid blocking the HTTP handler on every call.
    """
    global _providers_live_cache, _providers_live_ts

    now = time.time()
    if _providers_live_cache and now - _providers_live_ts < _PROVIDERS_CACHE_TTL:
        return 200, _providers_live_cache

    # ── 1. Resolve Hermes base URL ──
    hermes_url_raw = os.environ.get("HERMES_URL", "http://localhost:8642/v1")
    for suffix in ("/v1/chat/completions", "/v1/completions", "/v1", ""):
        if hermes_url_raw.endswith(suffix):
            hermes_url = hermes_url_raw[: -len(suffix)] if suffix else hermes_url_raw
            break
    else:
        hermes_url = hermes_url_raw

    hermes_headers: dict[str, str] = {}
    hermes_key = os.environ.get("HERMES_KEY", "")
    if hermes_key:
        hermes_headers["Authorization"] = f"Bearer {hermes_key}"

    # ── 2. Build probe map: all providers + hermes in one pass ──
    # Canonical Hermes slugs (post-v2.1); legacy aliases removed from the
    # probe set so a probe result for a slug is keyed by the canonical name
    # the new builder emits. Legacy aliases still resolve to env keys via
    # `_auth_headers` (above) for backward compat with persisted state.
    _PROVIDER_MODEL_ENDPOINTS = {
        "ollama-cloud": "https://api.ollama.com/v1/models",
        "openrouter":   "https://openrouter.ai/api/v1/models",
        "openai-api":   "https://api.openai.com/v1/models",
        "anthropic":    "https://api.anthropic.com/v1/models",
        "deepseek":     "https://api.deepseek.com/v1/models",
        "xai":          "https://api.x.ai/v1/models",
        "nvidia":       "https://integrate.api.nvidia.com/v1/models",
    }
    # Auto-extend from any provider declared in ~/.hermes/config.yaml with
    # a base_url ending in /v1 — that gives live probe for user-added
    # custom endpoints (and any future plugin provider). No-op if the
    # YAML doesn't expose a base_url for that provider.
    try:
        from server.provider_registry import _read_hermes_yaml
        _yaml_providers = (_read_hermes_yaml() or {}).get("providers", {}) or {}
        for _pid, _pcfg in _yaml_providers.items():
            if _pid in _PROVIDER_MODEL_ENDPOINTS:
                continue
            base = str((_pcfg or {}).get("base_url", "")).rstrip("/")
            if base.endswith("/v1"):
                _PROVIDER_MODEL_ENDPOINTS[_pid] = base + "/models"
    except Exception:
        logging.exception("[/providers/live] failed to extend endpoints from YAML")

    to_probe: dict[str, tuple[str, dict[str, str]]] = {
        "__hermes__": (f"{hermes_url}/v1/models", hermes_headers),
    }
    for pid, ep_url in _PROVIDER_MODEL_ENDPOINTS.items():
        to_probe[pid] = (ep_url, _auth_headers(pid))

    # ── 3. Run all probes in parallel — max wall-clock ≈ 6 s ──
    probe_results: dict[str, list[str]] = {}
    with ThreadPoolExecutor(max_workers=len(to_probe)) as pool:
        futures = {
            pool.submit(_probe_url, url, "GET", headers): pid
            for pid, (url, headers) in to_probe.items()
        }
        for future in as_completed(futures, timeout=6):
            pid = futures[future]
            try:
                probe_results[pid] = future.result()
            except Exception:
                probe_results[pid] = []

    hermes_models: set[str] = set(probe_results.pop("__hermes__", []))
    hermes_reachable = len(hermes_models) > 0
    provider_live = probe_results

    # ── 4. Merge with static provider registry ──
    from server.provider_registry import _get_chat_config, _hermes_models_payload
    chat_cfg = _get_chat_config()
    static_providers = {p["id"]: p for p in chat_cfg["providers"]}

    # Use Hermes' own model inventory as the source of truth for reachability.
    # The gateway /v1/models endpoint only returns the *active* model (usually
    # one), so the previous `hermes_models` fallback marked everything else as
    # unreachable even when Hermes can route to it. `build_models_payload` is
    # the same data Hermes' GUI pickers consume, so any model that appears
    # there is reachable by definition (Hermes is the actual inference path).
    #
    # Layered reachability:
    #   1. The provider's own live probe (if we have a URL for it)
    #   2. The active model list from the Hermes gateway
    #   3. The full Hermes model inventory (parity layer — covers all 44
    #      providers in build_models_payload, including ones without a probe)
    hermes_inventory: set[str] = set()
    try:
        payload = _hermes_models_payload() or {}
        for row in payload.get("providers", []) or []:
            for mid in row.get("models") or []:
                if mid:
                    hermes_inventory.add(mid)
    except Exception:
        logging.exception("[/providers/live] _hermes_models_payload failed")

    providers_out = []
    for pid, p in static_providers.items():
        live_ids = provider_live.get(pid, [])
        reachable_set = set(live_ids) | hermes_models | hermes_inventory

        models = []
        for m in p.get("models", []):
            mid = m.get("id", "")
            models.append({**m, "reachable": mid in reachable_set})

        known_ids = {m["id"] for m in models}
        for mid in live_ids:
            if mid not in known_ids:
                models.append({"id": mid, "name": mid, "harnesses": ["hermes", "openclaw"], "reachable": True})

        providers_out.append({
            "id": pid,
            "name": p["name"],
            "available": p["available"],
            "configured": p.get("configured", False),
            "defaultModel": p["defaultModel"],
            "models": models,
            "env": p.get("env", ""),
            "hermesReachable": hermes_reachable,
            "liveModelCount": len(live_ids),
        })

    response: dict = {
        "defaultProvider": chat_cfg["defaultProvider"],
        "hermesReachable": hermes_reachable,
        "hermesBaseUrl": hermes_url,
        "providers": providers_out,
    }
    _providers_live_cache = response
    _providers_live_ts = time.time()
    return 200, response
