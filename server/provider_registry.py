"""RepoCiv — Provider & Harness Registry.

Single source of truth: shared/provider-registry.json
Both this module and the frontend consume that file.
Python dicts are no longer hardcoded here.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
import logging

from .agent_runner import _has_claude_code, _has_openclaw, _has_cursor

# ─── Load from shared JSON ────────────────────────────────────────────────────

_REGISTRY_PATH = Path(__file__).parent.parent / "shared" / "provider-registry.json"

_cache: dict[str, Any] | None = None


def _load_registry() -> dict[str, Any]:
    global _cache
    if _cache is not None:
        return _cache
    if not _REGISTRY_PATH.exists():
        logging.warning("[provider_registry] shared/provider-registry.json not found; using empty registry")
        _cache = {"harnesses": [], "providers": []}
        return _cache
    try:
        with _REGISTRY_PATH.open(encoding="utf-8") as fh:
            _cache = json.load(fh)
    except Exception as exc:
        logging.error("[provider_registry] Failed to load shared/provider-registry.json: %s", exc)
        _cache = {"harnesses": [], "providers": []}
    return _cache


def _reset_cache() -> None:
    """For testing: invalidate the loaded registry cache."""
    global _cache
    _cache = None


_HARNESS_REGISTRY: list[dict[str, Any]] = []  # populated lazily from JSON
_PROVIDER_REGISTRY: list[dict[str, Any]] = []  # populated lazily from JSON


def _get_harness_list() -> list[dict[str, Any]]:
    return _load_registry().get("harnesses", [])


def _get_provider_list() -> list[dict[str, Any]]:
    return _load_registry().get("providers", [])


# ─── Public API ───────────────────────────────────────────────────────────────

def _get_harnesses() -> list[dict[str, Any]]:
    """Return available harnesses with live availability info."""
    result = []
    for h in _get_harness_list():
        env_var = h.get("env", "")
        available = True
        if env_var:
            available = bool(os.environ.get(env_var, ""))
        transport = h.get("transport", "")
        if transport == "claude-code":
            available = _has_claude_code()
        elif transport == "openclaw":
            available = _has_openclaw()
        elif transport == "cursor":
            available = _has_cursor()
        result.append({
            "id": h["id"],
            "name": h["name"],
            "transport": transport,
            "available": available,
        })
    return result


def _get_providers() -> dict[str, Any]:
    """Return available providers with their models.

    Each provider entry includes:
      - id, name, available, defaultModel
      - models: list of {id, name, harnesses} — which harnesses can use it
    """
    providers = []
    for p in _get_provider_list():
        env_var = p.get("env", "")
        available = not env_var or bool(os.environ.get(env_var, ""))
        providers.append({
            "id": p["id"],
            "name": p["name"],
            "available": available,
            "defaultModel": p.get("defaultModel", ""),
            "models": p.get("models", []),
        })
    # Pick default provider: first available in priority order
    priority = ("ollama-cloud", "openrouter", "openai", "nvidia-nim", "anthropic")
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


def _get_chat_config() -> dict[str, Any]:
    """Return full 3-layer config for the chat UI: harnesses + providers + defaults."""
    harnesses = _get_harnesses()
    provider_info = _get_providers()
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
        **provider_info,
    }
