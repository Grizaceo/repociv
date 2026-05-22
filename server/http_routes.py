"""RepoCiv — HTTP Route Handlers (Hotfix 2026-05-09 — provider reachability).

Each function here handles one route. It receives the parsed request body
(for POST) or query params (for GET), and returns a tuple:
  (status_code: int, response_body: Any)

BridgeHandler in bridge.py calls these and writes the response.
This makes routes individually testable without spinning up an HTTP server.
"""
from __future__ import annotations

from typing import Any
import os
import time
import urllib.request
import urllib.error
import json as _json_lib

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _auth_headers(provider: str) -> dict[str, str]:
    """Return Authorization header for a given provider, if API key is set."""
    env_keys = {
        "ollama-cloud": "OLLAMA_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY",
        "xai": "XAI_API_KEY",
        "nvidia-nim": "NVIDIA_API_KEY",
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


# ─── GET routes ───────────────────────────────────────────────────────────────

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


def get_gpu(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import get_gpu_info
    return 200, get_gpu_info()


def get_pending(ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_tracker import load_pending_tasks
    return 200, load_pending_tasks()


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
    from server.bridge import capabilities_snapshot
    return 200, capabilities_snapshot()


def get_chat_config(ctx: "RouteContext") -> tuple[int, Any]:
    from server.provider_registry import _get_chat_config
    return 200, _get_chat_config()


def get_metrics(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _es, _sched, get_gpu_info, compute_metrics, _to
    events = _es.read_events(since=0, limit=500)
    agent_status = _sched.get_agent_status()
    queue_depth = len(_sched.queue_snapshot())
    gpu = get_gpu_info()
    payload = compute_metrics(events, agent_status, queue_depth, gpu)
    payload["circuitOpenCount"] = _to.count_circuit_open()
    return 200, payload


def get_directives_stats(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _ds, _dl
    records = _ds.read_records()
    return 200, _dl.stats_snapshot(records)


def get_directives_suggest(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _ds, _dl
    params = ctx.get("params", {})
    gesture = params.get("gesture", "")
    agent_id = params.get("agent", "DAVI")
    records = _ds.read_records()
    extra_ctx: dict[str, Any] | None = None
    ctx_keys = ("repoType", "testStatus", "lastCmdType")
    if any(params.get(k) for k in ctx_keys):
        extra_ctx = {k: params[k] for k in ctx_keys if params.get(k)}
    return 200, _dl.suggest(gesture, agent_id, records, current_context=extra_ctx)


def get_harnesses(ctx: "RouteContext") -> tuple[int, Any]:
    from server import harness_registry as _hr
    return 200, _hr.list_harnesses()


def get_providers_live(ctx: "RouteContext") -> tuple[int, Any]:
    """Fetch live model reachability from each provider's own API.

    Instead of relying solely on the Hermes gateway, we probe each configured
    provider directly (using its API key from the environment) so the UI gets
    accurate per-model availability.
    """
    from server.provider_registry import _get_providers

    # ── 1. Build a set of all model IDs reachable via Hermes gateway ──
    hermes_url_raw = os.environ.get("HERMES_URL", "http://localhost:8642/v1")
    for suffix in ("/v1/chat/completions", "/v1/completions", "/v1", ""):
        if hermes_url_raw.endswith(suffix):
            hermes_url = hermes_url_raw[: -len(suffix)] if suffix else hermes_url_raw
            break
    else:
        hermes_url = hermes_url_raw

    hermes_models: set[str] = set()
    try:
        headers: dict[str, str] = {}
        hermes_key = os.environ.get("HERMES_KEY", "")
        if hermes_key:
            headers["Authorization"] = f"Bearer {hermes_key}"
        resp = _probe_url(f"{hermes_url}/v1/models", headers=headers)
        hermes_models = set(resp)
    except Exception:
        pass
    hermes_reachable = len(hermes_models) > 0

    # ── 2. Probe each provider's native API ──
    _PROVIDER_MODEL_ENDPOINTS = {
        "ollama-cloud": ("https://api.ollama.com/v1/models", "GET"),
        "openrouter": ("https://openrouter.ai/api/v1/models", "GET"),
        "openai": ("https://api.openai.com/v1/models", "GET"),
        "anthropic": ("https://api.anthropic.com/v1/models", "GET"),
        "deepseek": ("https://api.deepseek.com/v1/models", "GET"),
        "xai": ("https://api.x.ai/v1/models", "GET"),
        "nvidia-nim": ("https://integrate.api.nvidia.com/v1/models", "GET"),
    }

    provider_live: dict[str, list[str]] = {}
    for pid, (ep_url, _) in _PROVIDER_MODEL_ENDPOINTS.items():
        h = _auth_headers(pid)
        provider_live[pid] = _probe_url(ep_url, headers=h)

    # ── 3. Merge with static provider data ──
    static_data = _get_providers()
    static_providers = {p["id"]: p for p in static_data["providers"]}

    providers_out = []
    for pid, p in static_providers.items():
        live_ids = provider_live.get(pid, [])
        reachable_set = set(live_ids) | hermes_models  # union of both sources

        models = []
        for m in p.get("models", []):
            mid = m.get("id", "")
            reachable = mid in reachable_set
            models.append({**m, "reachable": reachable})

        # Also add any live model IDs we got that aren't in static list
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

    return 200, {
        "defaultProvider": static_data["defaultProvider"],
        "hermesReachable": hermes_reachable,
        "hermesBaseUrl": hermes_url,
        "providers": providers_out,
    }


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


def get_tasks(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _to
    return 200, _to.list_tasks()


def get_task_by_key(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _to
    repo = ctx.get("repo", "")
    issue_id = ctx.get("issue_id", "")
    circuit = ctx.get("circuit", False)
    if circuit:
        return 200, _to.get_circuit_status(repo, issue_id)
    return 200, _to.get_task_status(repo, issue_id)


def get_improve_reflect(ctx: "RouteContext") -> tuple[int, Any]:
    try:
        from server.self_improve import SelfImprovementEngine
        engine = SelfImprovementEngine()
        patterns = engine.reflect()
        return 200, {
            "patterns": [
                {"kind": p.kind, "summary": p.summary,
                 "evidence": p.evidence, "confidence": p.confidence}
                for p in patterns
            ]
        }
    except Exception as exc:
        return 500, {"error": str(exc)}


def get_improve_proposals(ctx: "RouteContext") -> tuple[int, Any]:
    try:
        from server.self_improve import SelfImprovementEngine
        engine = SelfImprovementEngine()
        proposals = []
        for pattern in engine.reflect():
            try:
                improvement = engine.propose_improvement(pattern)
            except Exception:
                continue
            proposals.append({
                "id": improvement.id,
                "targetType": improvement.target_type,
                "filePath": improvement.file_path,
                "description": improvement.description,
                "rationale": improvement.rationale,
                "payload": improvement.payload,
            })
        return 200, {"proposals": proposals}
    except Exception as exc:
        return 500, {"error": str(exc)}


def get_ws_info(ctx: "RouteContext") -> tuple[int, Any]:
    """Return WebSocket connection info for the frontend."""
    from server.bridge import BRIDGE_WS_PORT
    return 200, {
        "wsUrl": f"ws://localhost:{BRIDGE_WS_PORT}",
        "wsPort": BRIDGE_WS_PORT,
        "protocol": "websocket",
        "authRequired": bool(os.environ.get("REPOCIV_TOKEN", "")),
    }


# ─── POST routes ──────────────────────────────────────────────────────────────

def post_directives_record(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _ds
    command_id = str(body.get("commandId", ""))
    gesture = str(body.get("gesture", ""))
    agent_id = str(body.get("agentId", "DAVI"))
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
    agent_type = str(cmd.payload.get("unit") or body.get("agentType") or "DAVI")
    if not _agent_rate_limiter.check_and_consume(agent_type):
        return 429, {"error": "rate_limit", "agent": agent_type}
    result = _handle_command(cmd)
    return 200, result


def post_pending_add(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_tracker import append_pending_task
    title = str(body.get("title", "")).strip()
    priority = str(body.get("priority", "MEDIA")).upper()
    if priority not in ("ALTA", "MEDIA", "BAJA"):
        priority = "MEDIA"
    if not title:
        return 400, {"error": "title is required"}
    new_id = append_pending_task(title, priority)
    if new_id is None:
        return 409, {"error": "duplicate or write error"}
    return 200, {"ok": True, "id": new_id, "title": title, "priority": priority}


def post_pending_resolve(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_tracker import resolve_pending_task
    item_id = str(body.get("id", "")).strip()
    if not item_id:
        return 400, {"error": "id is required"}
    ok = resolve_pending_task(item_id)
    if not ok:
        return 404, {"error": "item not found"}
    return 200, {"ok": True, "id": item_id}


def post_pending_edit(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_tracker import edit_pending_task
    item_id = str(body.get("id", "")).strip()
    title = body.get("title")
    priority = body.get("priority")
    detail = body.get("detail")
    if not item_id:
        return 400, {"error": "id is required"}
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
    from server.pending_tracker import delete_pending_task
    item_id = str(body.get("id", "")).strip()
    if not item_id:
        return 400, {"error": "id is required"}
    ok = delete_pending_task(item_id)
    if not ok:
        return 404, {"error": "item not found"}
    return 200, {"ok": True, "id": item_id}


def post_pending_state(body: dict[str, Any], ctx: "RouteContext") -> tuple[int, Any]:
    from server.pending_tracker import change_pending_state
    item_id = str(body.get("id", "")).strip()
    new_state = str(body.get("state", "")).strip()
    if not item_id or not new_state:
        return 400, {"error": "id and state are required"}
    ok = change_pending_state(item_id, new_state)
    if not ok:
        return 404, {"error": "item not found or invalid state"}
    return 200, {"ok": True, "id": item_id, "state": new_state}


# ─── Type alias ───────────────────────────────────────────────────────────────
RouteContext = dict[str, Any]