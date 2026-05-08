import os
import json
from pathlib import Path
from typing import Any
import logging

from .agent_runner import _has_claude_code, _has_openclaw, _has_cursor

# ─── Provider registry ────────────────────────────────────────────────────────

# ─── Three-layer configuration: harness / provider / model ─────────────────────
#
# HARNESS = the executor binary that runs the agent (hermes, claude-code, openclaw, cursor)
# PROVIDER = the API backend that serves tokens (ollama-cloud, openrouter, openai, nvidia-nim)
# MODEL    = the specific model ID (deepseek-v3, kimi-2.6, gpt-4o, etc.)
#
# The frontend shows 3 independent selectors. Any combination is allowed;
# the agent runner resolves model availability at dispatch time.

# ── Harnesses ──────────────────────────────────────────────────────────────────
# Each harness: { id, name, transport, env, available_fn }
# `env` = env var that must be set (empty = detected via PATH or always-available)
_HARNESS_REGISTRY: list[dict[str, Any]] = [
    {
        "id": "hermes",
        "name": "Hermes",
        "transport": "hermes",
        "env": "HERMES_URL",
    },
    {
        "id": "claude-code",
        "name": "Claude Code",
        "transport": "claude-code",
        "env": "",  # detected via PATH (claude binary)
    },
    {
        "id": "openclaw",
        "name": "OpenClaw",
        "transport": "openclaw",
        "env": "",  # detected via PATH (openclaw binary)
    },
    {
        "id": "cursor",
        "name": "Cursor",
        "transport": "cursor",
        "env": "",  # detected via PATH (cursor binary)
    },
]

# ── Providers ──────────────────────────────────────────────────────────────────
# Each provider: { id, name, env, defaultModel, models }
# `env` = env var that must be set for this provider to be available (empty = always)
# `models` = { modelId, name, harnesses[] } — which harnesses can use this model
_PROVIDER_REGISTRY: list[dict[str, Any]] = [
    {
        "id": "ollama-cloud",
        "name": "Ollama Cloud",
        "env": "OLLAMA_CLOUD_URL",
        "defaultModel": "nemotron-3-nano-4b",
        "models": [
            {"id": "nemotron-3-nano-4b", "name": "Nemotron 3 Nano 4B", "harnesses": ["hermes", "ollama"]},
            {"id": "llama-3.3-70b", "name": "Llama 3.3 70B", "harnesses": ["hermes", "ollama"]},
            {"id": "qwen-2.5-coder-32b", "name": "Qwen 2.5 Coder 32B", "harnesses": ["hermes", "ollama"]},
        ],
    },
    {
        "id": "openrouter",
        "name": "OpenRouter",
        "env": "OPENROUTER_API_KEY",
        "defaultModel": "deepseek/deepseek-v3",
        "models": [
            {"id": "deepseek/deepseek-v3", "name": "DeepSeek V3", "harnesses": ["hermes", "openclaw", "claude-code"]},
            {"id": "deepseek/deepseek-r1", "name": "DeepSeek R1", "harnesses": ["hermes", "openclaw", "claude-code"]},
            {"id": "moonshotai/kimi-2.6", "name": "Kimi 2.6", "harnesses": ["hermes", "openclaw"]},
            {"id": "openai/gpt-4o", "name": "GPT-4o", "harnesses": ["hermes", "openclaw", "claude-code"]},
            {"id": "openai/gpt-4o-mini", "name": "GPT-4o Mini", "harnesses": ["hermes", "openclaw"]},
            {"id": "anthropic/claude-sonnet-4", "name": "Claude Sonnet 4", "harnesses": ["hermes", "openclaw", "claude-code"]},
            {"id": "anthropic/claude-opus-4", "name": "Claude Opus 4", "harnesses": ["hermes", "openclaw", "claude-code"]},
            {"id": "google/gemini-2.5-pro", "name": "Gemini 2.5 Pro", "harnesses": ["hermes", "openclaw"]},
            {"id": "nvidia/nemotron-3-nano-4b", "name": "Nemotron 3 Nano 4B (NR)", "harnesses": ["hermes", "openclaw"]},
        ],
    },
    {
        "id": "openai",
        "name": "OpenAI",
        "env": "OPENAI_API_KEY",
        "defaultModel": "gpt-4o",
        "models": [
            {"id": "gpt-4o", "name": "GPT-4o", "harnesses": ["hermes", "openclaw", "claude-code"]},
            {"id": "gpt-4o-mini", "name": "GPT-4o Mini", "harnesses": ["hermes", "openclaw"]},
            {"id": "o3", "name": "o3", "harnesses": ["hermes", "openclaw"]},
            {"id": "o4-mini", "name": "o4-mini", "harnesses": ["hermes", "openclaw"]},
        ],
    },
    {
        "id": "nvidia-nim",
        "name": "NVIDIA NIM",
        "env": "NVIDIA_NIM_URL",
        "defaultModel": "nvidia/nemotron-3-nano-4b",
        "models": [
            {"id": "nvidia/nemotron-3-nano-4b", "name": "Nemotron 3 Nano 4B", "harnesses": ["hermes", "openclaw"]},
            {"id": "nvidia/llama-3.3-70b", "name": "Llama 3.3 70B (NIM)", "harnesses": ["hermes", "openclaw"]},
        ],
    },
    {
        "id": "anthropic",
        "name": "Anthropic (direct)",
        "env": "ANTHROPIC_API_KEY",
        "defaultModel": "claude-sonnet-4-20250514",
        "models": [
            {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "harnesses": ["hermes", "openclaw", "claude-code"]},
            {"id": "claude-opus-4-20250514", "name": "Claude Opus 4", "harnesses": ["hermes", "openclaw", "claude-code"]},
            {"id": "claude-haiku-3-5-20241022", "name": "Claude Haiku 3.5", "harnesses": ["hermes", "openclaw"]},
        ],
    },
]


def _get_harnesses() -> list[dict[str, Any]]:
    """Return available harnesses with availability info."""
    result = []
    for h in _HARNESS_REGISTRY:
        env_var = h.get("env", "")
        available = True
        if env_var:
            val = os.environ.get(env_var, "")
            if not val:
                available = False
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
    """Return available providers with their models, separated from harnesses.

    Each provider entry includes:
      - id, name, available, defaultModel
      - models: list of {id, name, harnesses} showing which harnesses can use it
    """
    providers = []
    for p in _PROVIDER_REGISTRY:
        env_var = p.get("env", "")
        available = True
        if env_var:
            val = os.environ.get(env_var, "")
            if not val:
                available = False
        providers.append({
            "id": p["id"],
            "name": p["name"],
            "available": available,
            "defaultModel": p["defaultModel"],
            "models": p["models"],
        })
    # Pick default provider: first available in priority order
    default_provider = ""
    for pid in ("ollama-cloud", "openrouter", "openai", "nvidia-nim", "anthropic"):
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
    """Return full 3-layer config for the chat UI: harnesses + providers + default selections."""
    harnesses = _get_harnesses()
    provider_info = _get_providers()
    # Default harness: first available in priority order
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





