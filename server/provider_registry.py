"""RepoCiv — Provider & Harness Registry (v2.1 — Hermes parity).

Reads shared/provider-registry.json as a local override and
shared/provider-registry.example.json as the public fallback. It also
dynamically detects providers from the actual HERMES_ROOT config.yaml and env vars.
This ensures RepoCiv stays in sync with what Hermes really has available.

v2.1 (2026-06-11): when hermes-agent is importable, source the provider/model
list from `build_models_payload` (the same function that feeds Hermes GUI
pickers). Fallback to the static registry if hermes-agent is not installed
or the import fails for any reason. See execplan/provider-model-parity-with-hermes-tui.md.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

from .agent_runner import _has_claude_code, _has_openclaw, _has_cursor, _has_codex

# ─── HERMES IMPORT BLOCK ────────────────────────────────────────────────────
# When hermes-agent is importable, source the provider/model list from
# `build_models_payload` (same function that feeds Hermes GUI pickers).
# This gives 1:1 parity with `hermes model` in the TUI.
#
# `HERMES_AGENT_PATH=/nonexistent` is a kill-switch for rollback without
# code revert. We do not import anything else from `hermes_cli` — smaller
# surface = smaller refactor-breakage risk.

_HERMES_AGENT = Path(
    os.environ.get("HERMES_AGENT_PATH", str(Path.home() / ".hermes" / "hermes-agent"))
)
if _HERMES_AGENT.exists() and str(_HERMES_AGENT) not in sys.path:
    sys.path.insert(0, str(_HERMES_AGENT))

try:
    from hermes_cli.inventory import build_models_payload, load_picker_context
    from hermes_cli.models import provider_group_for_slug

    _HERMES_IMPORT_OK = True
    _HERMES_IMPORT_ERROR: str | None = None
except Exception as _exc:  # noqa: BLE001 — any failure -> legacy fallback
    build_models_payload = None  # type: ignore[assignment]
    load_picker_context = None  # type: ignore[assignment]
    provider_group_for_slug = None  # type: ignore[assignment]
    _HERMES_IMPORT_OK = False
    _HERMES_IMPORT_ERROR = repr(_exc)

# Cache for the raw Hermes payload (same data Hermes GUI pickers consume).
# build_models_payload can hit the network (model cache refresh); 60 s TTL
# keeps /providers cheap without going stale on model additions.
_hermes_payload_cache: tuple[float, dict] | None = None
_HERMES_PAYLOAD_TTL = 60.0
# ───────────────────────────────────────────────────────────────────────────

# ─── Static JSON (fallback) ──────────────────────────────────────────────────────

_SHARED_DIR = Path(__file__).parent.parent / "shared"
_REGISTRY_PATH = _SHARED_DIR / "provider-registry.json"
_REGISTRY_EXAMPLE_PATH = _SHARED_DIR / "provider-registry.example.json"

_cache: dict[str, Any] | None = None


def _load_registry() -> dict[str, Any]:
    """Load the local provider registry, falling back to the public example."""
    global _cache
    if _cache is not None:
        return _cache
    registry_path = _REGISTRY_PATH if _REGISTRY_PATH.exists() else _REGISTRY_EXAMPLE_PATH
    if not registry_path.exists():
        logging.warning("[provider_registry] no provider registry file found")
        _cache = {"harnesses": [], "providers": []}
        return _cache
    try:
        with registry_path.open(encoding="utf-8") as fh:
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

    hermes_root = Path(os.environ.get("HERMES_ROOT", str(Path.home() / ".hermes")))
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
        elif transport == "codex":
            available = _has_codex()
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


# ─── Hermes parity layer (v2.1) ─────────────────────────────────────────────


def _hermes_models_payload() -> dict[str, Any] | None:
    """Return the raw payload Hermes' GUI pickers consume, or None on failure.

    Cached for ``_HERMES_PAYLOAD_TTL`` seconds. ``build_models_payload`` may
    hit the network (model cache refresh); the TTL keeps ``GET /providers``
    cheap without going stale on provider additions.
    """
    global _hermes_payload_cache
    if not _HERMES_IMPORT_OK:
        return None
    assert build_models_payload is not None and load_picker_context is not None
    now = time.time()
    if _hermes_payload_cache and now - _hermes_payload_cache[0] < _HERMES_PAYLOAD_TTL:
        return _hermes_payload_cache[1]
    try:
        payload = build_models_payload(
            load_picker_context(),
            max_models=50,
            include_unconfigured=True,
            picker_hints=True,
            canonical_order=True,
            pricing=False,  # not consumed by RepoCiv UI; skip network
            capabilities=False,  # not consumed by RepoCiv UI; skip network
        )
    except Exception:
        logging.exception("[provider_registry] build_models_payload failed")
        return None
    _hermes_payload_cache = (now, payload)
    return payload


def _legacy_get_providers() -> dict[str, Any]:
    """Pre-v2.1 behavior: dynamic + static merge of shared registry + YAML."""
    _, providers = _build_dynamic_providers()

    # Pick default provider: first available configured one, then any available.
    # Slugs updated to canonical Hermes names; legacy aliases kept for backward
    # compat with persisted selections (see execplan §A.7).
    priority = (
        "ollama-cloud", "openrouter",
        "openai-api", "openai",          # canonical first, legacy fallback
        "nvidia", "nvidia-nim",
        "anthropic", "deepseek", "xai",
    )
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


def _get_providers() -> dict[str, Any]:
    """Providers with 1:1 parity vs `hermes model`; legacy fallback otherwise.

    When ``_HERMES_IMPORT_OK`` and the payload builds cleanly, we source
    the list from Hermes' own ``build_models_payload`` (same function that
    feeds Hermes GUI pickers). Otherwise we fall back to the pre-v2.1
    static + YAML merge, and signal that with ``hermesParity: False``.
    """
    payload = _hermes_models_payload()
    if payload is None:
        out = _legacy_get_providers()
        out["hermesParity"] = False
        out["hermesParityError"] = _HERMES_IMPORT_ERROR or "payload build failed"
        return out

    cfg = _read_hermes_yaml() or {}
    yaml_providers = cfg.get("providers", {}) or {}
    assert provider_group_for_slug is not None  # only reached if import OK

    # The currently active model (e.g. "MiniMax-M3") — used for default_model
    # of the row whose slug matches `payload["provider"]`.
    active_model = payload.get("model") or ""
    active_provider_slug = payload.get("provider") or ""

    providers_out: list[dict[str, Any]] = []
    for row in payload.get("providers", []):
        slug = str(row.get("slug") or "").strip()
        if not slug:
            continue
        model_ids = [m for m in (row.get("models") or []) if m]
        models = [
            {"id": mid, "name": mid, "harnesses": ["hermes", "openclaw"]}
            for mid in model_ids
        ]
        ycfg = yaml_providers.get(slug) or {}
        # defaultModel precedence:
        #   1. yaml default_model (explicit user choice)
        #   2. the active model name if this is the active provider
        #   3. first model in the curated list
        if row.get("is_current") or slug == active_provider_slug:
            default_model = ycfg.get("default_model") or active_model or (
                model_ids[0] if model_ids else ""
            )
        else:
            default_model = ycfg.get("default_model") or (
                model_ids[0] if model_ids else ""
            )

        providers_out.append({
            "id": slug,
            "name": row.get("name") or slug,
            "available": bool(row.get("authenticated") or row.get("is_user_defined")),
            "configured": bool(
                slug in yaml_providers
                or row.get("authenticated")
                or row.get("is_user_defined")
            ),
            "env": row.get("key_env") or ycfg.get("api_key_env") or "",
            "defaultModel": default_model,
            "models": models,
            "group": provider_group_for_slug(slug) or "",
            "warning": row.get("warning") or "",
        })

    default_provider = active_provider_slug or _pick_default_provider(providers_out)
    # Guard: if default_provider is not in our emitted list (e.g. "custom" with
    # a user-defined variant that canonical mapping didn't cover), fall back.
    if default_provider not in {p["id"] for p in providers_out}:
        default_provider = _pick_default_provider(providers_out)

    return {
        "defaultProvider": default_provider,
        "providers": providers_out,
        "hermesParity": True,
    }


def _get_chat_config(harness: str | None = None) -> dict[str, Any]:
    """
    Return full 3-layer config for the chat UI: harnesses + providers + defaults.

    In parity mode (hermes-agent importable), returns the full Hermes
    provider universe — same as `hermes model` shows in the TUI. In legacy
    mode, filters to only providers configured in ~/.hermes/config.yaml
    (field `configured: true`) — pre-v2.1 behavior, kept as the safe
    fallback when hermes-agent is unreachable.
    """
    harnesses = _get_harnesses()
    provider_info = _get_providers()

    providers_list = provider_info["providers"]
    if not provider_info.get("hermesParity"):
        # Legacy path: keep the old "only configured" filter to preserve
        # the pre-v2.1 user experience when parity is unavailable.
        providers_list = [p for p in providers_list if p.get("configured")]

    # Pick default provider from the (possibly filtered) list
    default_provider = _pick_default_provider(providers_list)

    default_harness = ""
    for hid in ("hermes", "claude-code", "openclaw", "cursor", "codex"):
        for h in harnesses:
            if h["id"] == hid and h["available"]:
                default_harness = hid
                break
        if default_harness:
            break

    out = {
        "harnesses": harnesses,
        "defaultHarness": default_harness,
        "defaultProvider": default_provider,
        "providers": providers_list,
    }
    if "hermesParity" in provider_info:
        out["hermesParity"] = provider_info["hermesParity"]
    if "hermesParityError" in provider_info:
        out["hermesParityError"] = provider_info["hermesParityError"]
    return out


def _pick_default_provider(providers: list[dict[str, Any]]) -> str:
    """
    Pick the best default provider from a (possibly filtered) list.

    Priority: ollama-cloud > openrouter > openai-api > openai (legacy alias)
    > nvidia > nvidia-nim (legacy alias) > anthropic > deepseek > xai;
    then first available.
    """
    priority = (
        "ollama-cloud", "openrouter",
        "openai-api", "openai",
        "nvidia", "nvidia-nim",
        "anthropic", "deepseek", "xai",
    )
    for pid in priority:
        for p in providers:
            if p["id"] == pid and p.get("available"):
                return pid
    for p in providers:
        if p.get("available"):
            return p["id"]
    return ""


# ─── Public API ───────────────────────────────────────────────────────────────────

def _get_harnesses() -> list[dict[str, Any]]:
    """Return available harnesses with live availability info."""
    harnesses, _ = _build_dynamic_providers()
    return harnesses
