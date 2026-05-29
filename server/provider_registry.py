"""RepoCiv — Provider & Harness Registry (v2).

Reads shared/provider-registry.json as fallback, but also dynamically
detects providers from the actual HERMES_ROOT config.yaml and env vars.
This ensures RepoCiv stays in sync with what Hermes really has available.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
import logging

from .agent_runner import _has_claude_code, _has_openclaw, _has_cursor

# ─── Static JSON (fallback) ──────────────────────────────────────────────────────

_REGISTRY_PATH = Path(__file__).parent.parent / "shared" / "provider-registry.json"

_cache: dict[str, Any] | None = None


def _load_registry() -> dict[str, Any]:
    """Load the static provider-registry.json."""
    global _cache
    if _cache is not None:
        return _cache
    if not _REGISTRY_PATH.exists():
        logging.warning("[provider_registry] shared/provider-registry.json not found")
        _cache = {"harnesses": [], "providers": []}
        return _cache
    try:
        with _REGISTRY_PATH.open(encoding="utf-8") as fh:
            _cache = json.load(fh)
    except Exception as exc:
        logging.error("[provider_registry] Failed to load registry: %s", exc)
        _cache = {"harnesses": [], "providers": []}
    return _cache


def _reset_cache() -> None:
    global _cache
    _cache = None


# Expose raw static registries for bridge.py backward compat
def _PROVIDER_REGISTRY() -> list[dict]:
    """Return the raw provider list from static JSON."""
    return _load_registry().get("providers", [])


def _HARNESS_REGISTRY() -> list[dict]:
    """Return the raw harness list from static JSON."""
    return _load_registry().get("harnesses", [])


# ─── Dynamic Hermes config reader ────────────────────────────────────────────────

def _read_hermes_yaml() -> dict[str, Any] | None:
    """Read ~/.hermes/config.yaml and return the parsed config (best-effort)."""
    import yaml  # PyYAML — available in hermes venv

    hermes_root = Path(os.path.expanduser(os.environ.get("HERMES_ROOT", str(Path.home() / ".hermes"))))
    config_path = hermes_root / "config.yaml"

    # Also check the RepoCiv .env override
    config_from_env = os.environ.get("HERMES_ROOT")
    if config_from_env:
        alt = Path(config_from_env) / "config.yaml"
        if alt.exists():
            config_path = alt

    if not config_path.exists():
        logging.info("[provider_registry] No hermes config.yaml at %s", config_path)
        return None

    try:
        with config_path.open(encoding="utf-8") as fh:
            return yaml.safe_load(fh) or {}
    except Exception as exc:
        logging.warning("[provider_registry] Failed to parse hermes config.yaml: %s", exc)
        return None


def _build_dynamic_providers() -> tuple[list[dict], list[dict]]:
    """
    Build harness + provider lists by cross-referencing:
    1. Static registry (for model names + harness compatibility)
    2. Hermes config.yaml (for actual API keys, base URLs, enabled providers)
    3. Environment variables (to determine availability)
    """
    static = _load_registry()
    hermes_cfg = _read_hermes_yaml() or {}

    # --- Build a lookup of what Hermes knows about each provider ---
    hermes_providers: dict[str, dict] = {}
    yaml_providers = hermes_cfg.get("providers", {})
    for pid, pdata in yaml_providers.items():
        if pid == "_comment":
            continue
        hermes_providers[pid] = pdata

    hermes_default = hermes_cfg.get("model", {}).get("provider", "")
    hermes_fallback = hermes_cfg.get("fallback_model", {})
    all_enabled = set()
    if hermes_default:
        all_enabled.add(hermes_default)
    if hermes_fallback and isinstance(hermes_fallback, dict):
        fb_prov = hermes_fallback.get("provider", "")
        if fb_prov:
            all_enabled.add(fb_prov)

    # --- Harnesses (dynamic availability check) ---
    harnesses_out = []
    for h in static.get("harnesses", []):
        available = True
        transport = h.get("transport", "")
        if transport == "claude-code":
            available = _has_claude_code()
        elif transport == "openclaw":
            available = _has_openclaw()
        elif transport == "cursor":
            available = _has_cursor()
        elif transport == "hermes":
            # Hermes is always available if the gateway is running
            available = True
        harnesses_out.append({
            "id": h["id"],
            "name": h["name"],
            "transport": transport,
            "available": available,
        })

    # --- Providers with dynamic availability ---
    providers_out = []
    for p in static.get("providers", []):
        pid = p["id"]
        env_var = p.get("env", "")

        # Check if the env var is set
        available = not env_var or bool(os.environ.get(env_var, ""))

        # Also check if Hermes config references this provider
        if pid in hermes_providers:
            available = True  # Configured in Hermes
        elif pid in all_enabled:
            available = True  # Set as default/fallback in config

        # Build the models list: prefer static registry models,
        # but enrich with info from hermes config if available
        models = list(p.get("models", []))

        # If Hermes config has extra models for this provider, merge them
        if pid in hermes_providers:
            hp = hermes_providers[pid]
            yaml_models = hp.get("models", [])
            known_ids = {m["id"] for m in models}
            for m_name in yaml_models:
                if m_name not in known_ids:
                    models.append({
                        "id": m_name,
                        "name": m_name,
                        "harnesses": ["hermes", "openclaw"],
                    })

        # Determine default model
        default_model = p.get("defaultModel", "")
        if pid == hermes_default and "default_model" in (hermes_providers.get(pid, {})):
            default_model = hermes_providers[pid]["default_model"]
        elif pid == "ollama-cloud" and not default_model:
            default_model = "deepseek-v4-pro"

        providers_out.append({
            "id": pid,
            "name": p["name"],
            "available": available,
            "env": env_var,
            "configured": pid in hermes_providers,
            "defaultModel": default_model,
            "models": models,
        })

    # --- Detect providers in Hermes config that are NOT in static registry ---
    for pid, hp in hermes_providers.items():
        if pid == "_comment":
            continue
        if any(p["id"] == pid for p in providers_out):
            continue
        # New provider not in static registry — add dynamically
        env_var = ""
        if "api_key_env" in hp:
            env_var = hp["api_key_env"]
        yaml_models = hp.get("models", [])
        models = [
            {"id": m, "name": m, "harnesses": ["hermes", "openclaw"]}
            for m in yaml_models
        ]
        default_model = hp.get("default_model", yaml_models[0] if yaml_models else "")
        available = bool(os.environ.get(env_var, "")) if env_var else True

        providers_out.append({
            "id": pid,
            "name": pid.replace("-", " ").title(),
            "available": available,
            "env": env_var,
            "configured": True,
            "defaultModel": default_model,
            "models": models,
        })

    return harnesses_out, providers_out


# ─── Public API ───────────────────────────────────────────────────────────────────

def _get_harnesses() -> list[dict[str, Any]]:
    """Return available harnesses with live availability info."""
    harnesses, _ = _build_dynamic_providers()
    return harnesses


def _get_providers() -> dict[str, Any]:
    """Return available providers with their models (dynamic + static merge)."""
    _, providers = _build_dynamic_providers()

    # Pick default provider: first available configured one, then any available
    priority = ("ollama-cloud", "openrouter", "openai", "nvidia-nim", "anthropic", "deepseek", "xai")
    default_provider = ""
    for pid in priority:
        for p in providers:
            if p["id"] == pid and p["available"]:
                default_provider = pid
                break
        if default_provider:
            break

    if not default_provider:
        for p in providers:
            if p["available"]:
                default_provider = p["id"]
                break

    return {
        "defaultProvider": default_provider,
        "providers": providers,
    }


def _get_chat_config(harness: str | None = None) -> dict[str, Any]:
    """
    Return full 3-layer config for the chat UI: harnesses + providers + defaults.

    Always filters to only providers actually configured in ~/.hermes/config.yaml
    (field `configured: true`). Never returns providers from the static registry
    that the user hasn't set up — no hardcoded lists.
    The `harness` parameter is accepted for future use but does not change filtering.
    """
    harnesses = _get_harnesses()
    provider_info = _get_providers()

    # Always filter to only providers configured in ~/.hermes/config.yaml
    providers_list = [
        p for p in provider_info["providers"]
        if p.get("configured")
    ]

    # Pick default provider from the (possibly filtered) list
    default_provider = _pick_default_provider(providers_list)

    default_harness = ""
    for hid in ("hermes", "claude-code", "openclaw", "cursor"):
        for h in harnesses:
            if h["id"] == hid and h["available"]:
                default_harness = hid
                break
        if default_harness:
            break

    return {
        "harnesses": harnesses,
        "defaultHarness": default_harness,
        "defaultProvider": default_provider,
        "providers": providers_list,
    }


def _pick_default_provider(providers: list[dict[str, Any]]) -> str:
    """
    Pick the best default provider from a (possibly filtered) list.
    Priority: ollama-cloud > openrouter > openai > nvidia-nim > anthropic > deepseek > xai
    then first available.
    """
    priority = ("ollama-cloud", "openrouter", "openai", "nvidia-nim", "anthropic", "deepseek", "xai")
    for pid in priority:
        for p in providers:
            if p["id"] == pid and p.get("available"):
                return pid
    for p in providers:
        if p.get("available"):
            return p["id"]
    return ""