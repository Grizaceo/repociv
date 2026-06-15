"""RepoCiv HTTP route handlers split by domain (Phase 4)."""
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

def _error(status: int, error: str, cause: str, hint: str) -> tuple[int, dict]:
    """Return a structured error envelope: {error, cause, hint}."""
    return status, {"error": error, "cause": cause, "hint": hint}

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

def get_health(ctx: "RouteContext") -> tuple[int, Any]:
    from server.agent_runner import _has_claude_code, _has_openclaw, _has_cursor, _has_codex
    from server.bridge import _sched, get_gpu_info, _es
    agent_status = _sched.get_agent_status()
    queue_depth = len(_sched.queue_snapshot())
    gpu = get_gpu_info()
    return 200, {
        "ok": True,
        "version": "0.1.0",
        "timestamp": time.time(),
        "openclaw": _has_openclaw(),
        "claudeCode": _has_claude_code(),
        "cursor": _has_cursor(),
        "codex": _has_codex(),
        "defaultTransport": "hermes",
        "agents": {
            "active": sum(1 for a in agent_status if a.get("status") == "active"),
            "total": len(agent_status),
            "queueDepth": queue_depth,
        },
        "gpu": gpu,
        "eventStore": str(_es._store_path) if hasattr(_es, "_store_path") else None,
    }

def get_ready(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _es, REPOCIV_TOKEN
    return 200, {"ok": True, "eventStore": str(_es._store_path), "token": bool(REPOCIV_TOKEN)}

def get_missions(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import load_missions
    return 200, load_missions()

def post_subagent_cancel(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /subagents/cancel — Recall a running subagent by id."""
    from server import subagent_tracker as _st

    subagent_id = str(body.get("subagentId") or body.get("subagent_id") or "").strip()
    if not subagent_id:
        return 400, {"ok": False, "error": "subagentId required"}
    return 200, _st.request_cancel(subagent_id)

def get_subagents(ctx: "RouteContext") -> tuple[int, Any]:
    from server import research_ledger as _rl
    from server import subagent_tracker as _st
    params = ctx.get("params", {})
    parent_unit = str(params.get("parentUnit") or params.get("parent_unit") or "")
    parent_mission = str(params.get("parentMission") or params.get("parent_mission") or "")
    active = str(params.get("active", "")).lower() in ("1", "true", "yes")
    ledger_rows = _rl.get_ledger().list_subagent_runs(
        parent_unit=parent_unit,
        parent_mission=parent_mission,
        active_only=active,
    )
    if ledger_rows:
        return 200, {"subagents": ledger_rows, "source": "duckdb"}
    memory = _st.list_active(parent_unit or None)
    if parent_mission:
        memory = [r for r in memory if r.get("parentMissionId") == parent_mission]
    return 200, {"subagents": memory, "source": "memory"}

def get_mission_tree(ctx: "RouteContext") -> tuple[int, Any]:
    from server import research_ledger as _rl
    from server import run_state as _run_state
    mission_id = str(ctx.get("mission_id") or "")
    if not mission_id:
        return 400, {"error": "mission_id required"}
    tree = _rl.get_ledger().get_mission_tree(mission_id)
    run_snap = _run_state.load(mission_id)
    if run_snap:
        tree["runState"] = run_snap
    return 200, tree

def get_gpu(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import get_gpu_info
    return 200, get_gpu_info()

def get_pending(ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_tracker import load_pending_tasks
    from server.pending_local import load_local_tasks
    hermes_items = []
    try:
        hermes_items = load_pending_tasks()
        for it in hermes_items:
            it["source"] = "hermes"
    except Exception:
        pass
    local_items = load_local_tasks()
    return 200, hermes_items + local_items

def get_context(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _fatigue_state, _rest_areas
    return 200, {"ok": True, "fatigue": _fatigue_state, "restAreas": _rest_areas}

def get_approvals(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _get_approvals
    return 200, _get_approvals()

def get_agents(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _sched
    return 200, {
        "agents": _sched.get_agent_status(),
        "queueDepth": len(_sched.queue_snapshot()),
        "queue": _sched.queue_snapshot()[:20],
    }

def get_agents_capabilities(ctx: "RouteContext") -> tuple[int, Any]:
    from server.capabilities import capabilities_snapshot
    return 200, capabilities_snapshot()

def get_chat_config(ctx: "RouteContext") -> tuple[int, Any]:
    from server.provider_registry import _get_chat_config
    params = ctx.get("params", {})
    harness = (params.get("harness") or "").strip()
    return 200, _get_chat_config(harness=harness if harness else None)

def get_metrics(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _es, _sched, get_gpu_info, _to
    from server.metrics import compute_metrics
    from server import endpoint_usage as _endpoint_usage
    events = _es.read_events(since=0, limit=500)
    agent_status = _sched.get_agent_status()
    queue_depth = len(_sched.queue_snapshot())
    gpu = get_gpu_info()
    payload = compute_metrics(events, agent_status, queue_depth, gpu)
    payload["circuitOpenCount"] = _to.count_circuit_open()
    payload["endpointUsage"] = _endpoint_usage.get_stats(limit=25)
    return 200, payload

def get_directives_stats(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _ds, _dl
    records = _ds.read_records()
    return 200, _dl.stats_snapshot(records)

def get_directives_suggest(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _ds, _dl
    params = ctx.get("params", {})
    gesture = params.get("gesture", "")
    agent_id = params.get("agent", "MAIN")
    records = _ds.read_records()
    extra_ctx: dict[str, Any] | None = None
    ctx_keys = ("repoType", "testStatus", "lastCmdType")
    if any(params.get(k) for k in ctx_keys):
        extra_ctx = {k: params[k] for k in ctx_keys if params.get(k)}
    return 200, _dl.suggest(gesture, agent_id, records, current_context=extra_ctx)

def get_harnesses(ctx: "RouteContext") -> tuple[int, Any]:
    from server import harness_registry as _hr
    return 200, _hr.list_harnesses()


def get_default_harness(_ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/config/default-harness — return the user's chosen default harness.

    Onboarding writes this in step 2 of the panel; until then it is None
    and MAIN's capabilities stay empty (the bridge does not crash on missing
    config — it just refuses capability-gated commands).
    """
    from server import config_store as _cs
    return 200, {"harness": _cs.get_default_harness()}


def post_default_harness(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/config/default-harness — persist the user's harness choice.

    Body: { "harness": "hermes" | "claude" | "codex" | "cursor" | "openclaw" }
    Response 200: { "harness": "<normalized>" }
    Response 400: { "error": "<reason>" }
    """
    from server import config_store as _cs
    harness = body.get("harness")
    if not isinstance(harness, str) or not harness.strip():
        return 400, {"error": "harness is required and must be a non-empty string"}
    try:
        normalized = _cs.set_default_harness(harness)
    except ValueError as exc:
        return 400, {"error": str(exc)}
    return 200, {"harness": normalized}


def get_profiles(_ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/profiles — return the user's profile registry.

    The registry is a dict of name -> {"harness": ..., ...optional fields}.
    The shipped default is one profile per built-in harness, but the user
    can rename, add, or remove profiles at any time.
    """
    from server import config_store as _cs
    return 200, {"profiles": _cs.list_profiles()}


def post_profiles(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/profiles — create or update a profile.

    Body: { "name": "<name>", "harness": "<harness>", ...optional }
    Response 200: { "profile": {...normalized entry...} }
    Response 400: { "error": "<reason>" }
    """
    from server import config_store as _cs
    name = body.get("name")
    harness = body.get("harness")
    if not isinstance(name, str) or not isinstance(harness, str):
        return 400, {"error": "name and harness are required strings"}
    try:
        entry = _cs.upsert_profile(
            name,
            harness,
            personality=body.get("personality"),
            system_prompt=body.get("system_prompt"),
            profile_path=body.get("profile_path"),
            model=body.get("model"),
            provider=body.get("provider"),
        )
    except ValueError as exc:
        return 400, {"error": str(exc)}
    return 200, {"profile": entry}


def post_profiles_delete(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/profiles/delete — remove a profile by name.

    Body: { "name": "<name>" }
    Response 200: { "ok": True }
    Response 404: { "error": "profile '<name>' not found" }
    Response 400: { "error": "<reason>" }
    """
    from server import config_store as _cs
    name = body.get("name")
    if not isinstance(name, str):
        return 400, {"error": "name is required and must be a string"}
    try:
        deleted = _cs.delete_profile(name)
    except ValueError as exc:
        return 400, {"error": str(exc)}
    if not deleted:
        return 404, {"error": f"profile {name!r} not found"}
    return 200, {"ok": True}


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
    from server.provider_registry import _get_chat_config
    chat_cfg = _get_chat_config()
    static_providers = {p["id"]: p for p in chat_cfg["providers"]}

    providers_out = []
    for pid, p in static_providers.items():
        live_ids = provider_live.get(pid, [])
        reachable_set = set(live_ids) | hermes_models

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

def get_log(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _es
    params = ctx.get("params", {})
    try:
        n = min(max(1, int(params.get("n", "100"))), 500)
        event_type_filter = params.get("type", "")
    except Exception:
        n, event_type_filter = 100, ""
    events = _es.read_events(since=0, limit=500)
    if event_type_filter:
        events = [e for e in events if e.get("type") == event_type_filter]
    return 200, events[-n:]

def get_ws_info(ctx: "RouteContext") -> tuple[int, Any]:
    """Return WebSocket connection info for the frontend."""
    from server.bridge import BRIDGE_WS_PORT
    return 200, {
        "wsUrl": f"ws://localhost:{BRIDGE_WS_PORT}",
        "wsPort": BRIDGE_WS_PORT,
        "protocol": "websocket",
        "authRequired": bool(os.environ.get("REPOCIV_TOKEN", "")),
    }

def post_directives_record(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _ds
    command_id = str(body.get("commandId", ""))
    gesture = str(body.get("gesture", ""))
    agent_id = str(body.get("agentId", "MAIN"))
    cmd_type = str(body.get("cmdType", ""))
    target = str(body.get("target", ""))
    extra_ctx: dict[str, Any] = {}
    for k in ("repoType", "testStatus", "lastCmdType"):
        if body.get(k):
            extra_ctx[k] = str(body[k])
    if body.get("gameTick") is not None:
        extra_ctx["gameTick"] = int(body["gameTick"])
    if command_id and gesture and cmd_type:
        _ds.record_gesture(command_id, gesture, agent_id, cmd_type, target,
                           extra_ctx if extra_ctx else None)
    return 200, {"ok": True}

def post_commands(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _handle_command, _agent_rate_limiter
    from server.command_schema import validate_command, CommandValidationError
    try:
        cmd = validate_command(body)
    except CommandValidationError as e:
        return 400, {"error": str(e)}
    agent_type = str(cmd.payload.get("unit") or body.get("agentType") or "MAIN")
    if not _agent_rate_limiter.check_and_consume(agent_type):
        return 429, {"error": "rate_limit", "agent": agent_type}
    result = _handle_command(cmd)
    return 200, result

def post_pending_add(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_local import add_local_task
    title = str(body.get("title", "")).strip()
    priority = str(body.get("priority", "MEDIA")).upper()
    detail = str(body.get("detail", "")).strip()
    if priority not in ("ALTA", "MEDIA", "BAJA"):
        priority = "MEDIA"
    if not title:
        return 400, {"error": "title is required"}
    new_id = add_local_task(title, priority, detail)
    if new_id is None:
        return 409, {"error": "write error"}
    return 200, {"ok": True, "id": new_id, "title": title, "priority": priority, "source": "local"}

def post_pending_resolve(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_local import is_local_id, resolve_local_task
    from server.pending_tracker import resolve_pending_task
    item_id = str(body.get("id", "")).strip()
    if not item_id:
        return 400, {"error": "id is required"}
    ok = resolve_local_task(item_id) if is_local_id(item_id) else resolve_pending_task(item_id)
    if not ok:
        return 404, {"error": "item not found"}
    return 200, {"ok": True, "id": item_id}

def post_pending_edit(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_local import is_local_id, edit_local_task
    from server.pending_tracker import edit_pending_task
    item_id = str(body.get("id", "")).strip()
    title = body.get("title")
    priority = body.get("priority")
    detail = body.get("detail")
    if not item_id:
        return 400, {"error": "id is required"}
    if is_local_id(item_id):
        ok = edit_local_task(
            item_id,
            title=str(title).strip() if title else None,
            priority=str(priority).upper().strip() if priority else None,
            detail=str(detail) if detail else None,
        )
    else:
        ok = edit_pending_task(
            item_id,
            title=str(title).strip() if title else None,
            priority=str(priority).upper().strip() if priority else None,
            detail=str(detail) if detail else None,
        )
    if not ok:
        return 404, {"error": "item not found"}
    return 200, {"ok": True, "id": item_id}

def post_pending_delete(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_local import is_local_id, delete_local_task
    from server.pending_tracker import delete_pending_task
    item_id = str(body.get("id", "")).strip()
    if not item_id:
        return 400, {"error": "id is required"}
    ok = delete_local_task(item_id) if is_local_id(item_id) else delete_pending_task(item_id)
    if not ok:
        return 404, {"error": "item not found"}
    return 200, {"ok": True, "id": item_id}

def post_pending_state(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_local import is_local_id, change_local_state
    from server.pending_tracker import change_pending_state
    item_id = str(body.get("id", "")).strip()
    new_state = str(body.get("state", "")).strip()
    if not item_id or not new_state:
        return 400, {"error": "id and state are required"}
    ok = change_local_state(item_id, new_state) if is_local_id(item_id) else change_pending_state(item_id, new_state)
    if not ok:
        return 404, {"error": "item not found or invalid state"}
    return 200, {"ok": True, "id": item_id, "state": new_state}

def _validate_unit_id(raw: Any) -> str | None:
    """Return sanitized unit_id (uppercase, alphanumeric + dash/underscore, 1–32 chars)
    or None if the value is invalid. Guards against path-traversal attacks.

    When the input is empty, defaults to "MAIN" — the user's first unit slot,
    which is configured during onboarding (harness selection).
    """
    import re
    uid = str(raw or "").strip().upper()
    if not uid:
        return "MAIN"
    if re.fullmatch(r"[A-Z0-9_-]{1,32}", uid):
        return uid
    return None

def post_session_reset(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /session/reset — delete session files and return a new session nonce.

    Body: { "unit": "<unit_id>" }
    Response: { "ok": True, "newSessionId": "repociv-<unit_id>-<timestamp>" }
    """
    from server import sessions as _sessions
    unit_id = _validate_unit_id(body.get("unit", "MAIN"))
    if unit_id is None:
        return 400, {"error": "Invalid unit_id — must be alphanumeric/dash/underscore, max 32 chars"}
    new_sid = _sessions.reset(unit_id)
    return 200, {"ok": True, "newSessionId": new_sid, "unit": unit_id}

def post_model_override(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /model/override — set per-unit provider/model override (in-memory).

    Body: { "unit": "<unit_id>", "provider": "<provider_id>", "model": "<model_id>" }
    Persists until bridge restart or another /model/override call for the same unit.
    Note: override applies to the Hermes harness only; other harnesses use their
    own model-selection logic.
    """
    from server import agent_runner as _ar
    unit_id = _validate_unit_id(body.get("unit", "MAIN"))
    if unit_id is None:
        return 400, {"error": "Invalid unit_id — must be alphanumeric/dash/underscore, max 32 chars"}
    provider = str(body.get("provider", "")).strip()
    model = str(body.get("model", "")).strip()
    if not provider or not model:
        return 400, {"error": "Both 'provider' and 'model' are required"}
    _ar.set_model_override(unit_id, provider, model)
    return 200, {"ok": True, "unit": unit_id, "provider": provider, "model": model}
