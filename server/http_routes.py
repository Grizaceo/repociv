"""RepoCiv — HTTP Route Handlers (Hotfix 2026-05-09 — provider reachability).

Each function here handles one route. It receives the parsed request body
(for POST) or query params (for GET), and returns a tuple:
  (status_code: int, response_body: Any)

BridgeHandler in bridge.py calls these and writes the response.
This makes routes individually testable without spinning up an HTTP server.
"""
from __future__ import annotations

import json as _json_lib
import os
import time
import urllib.request
import urllib.error
from typing import Any


def _error(status: int, error: str, cause: str, hint: str) -> tuple[int, dict]:
    """Return a structured error envelope: {error, cause, hint}."""
    return status, {"error": error, "cause": cause, "hint": hint}

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
    from server.bridge import capabilities_snapshot
    return 200, capabilities_snapshot()


def get_chat_config(ctx: "RouteContext") -> tuple[int, Any]:
    from server.provider_registry import _get_chat_config
    params = ctx.get("params", {})
    harness = (params.get("harness") or "").strip()
    return 200, _get_chat_config(harness=harness if harness else None)


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

    # ── 3. Merge with static provider data (only configured providers) ──
    from server.provider_registry import _get_chat_config
    chat_cfg = _get_chat_config()
    static_providers = {p["id"]: p for p in chat_cfg["providers"]}

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
        "defaultProvider": chat_cfg["defaultProvider"],
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


# ─── CDaily Integration routes ────────────────────────────────────────────────
import sqlite3
from contextlib import closing
from pathlib import Path

_CDAILY_DB_DEFAULT = Path.home() / ".blogwatcher-cli" / "blogwatcher-cli.db"



# Inline fallback mapping: blog_name keyword → (category, emoji)
_CATEGORY_FALLBACK: dict[str, tuple[str, str]] = {
    "seguridad": ("Seguridad", "🔐"),
    "security": ("Seguridad", "🔐"),
    "code": ("Código", "💻"),
    "claude": ("Claude", "🎯"),
    "noattack": ("Vulnerabilidades", "🚨"),
    "bleeping": ("Vulnerabilidades", "🚨"),
    "the hackernews": ("Vulnerabilidades", "🚨"),
    "hacker news": ("Vulnerabilidades", "🚨"),
    "tech": ("Tecnología", "⚙️"),
    "ai": ("IA", "🧠"),
    "machine learning": ("IA", "🧠"),
    "openai": ("IA", "🧠"),
    "google": ("Big Tech", "🌐"),
    "microsoft": ("Big Tech", "🌐"),
}

def _resolve_cdaily_db() -> Path:
    """Resuelve la ruta del SQLite de CDaily desde env o valor por defecto."""
    env_val = os.environ.get("CDAILY_DB_PATH", "")
    return Path(os.path.expanduser(env_val)) if env_val else _CDAILY_DB_DEFAULT


def _infer_category(blog_name: str) -> tuple[str, str]:
    bn = blog_name.lower()
    for kw, (cat, emoji) in _CATEGORY_FALLBACK.items():
        if kw in bn:
            return cat, emoji
    return "General", "📰"

def get_latest_news(ctx: dict[str, Any]) -> tuple[int, Any]:
    db_path = _resolve_cdaily_db()
    if not db_path.exists():
        return 200, []

    try:
        with closing(sqlite3.connect(str(db_path))) as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            # Try with categories column first; fallback gracefully for older DB schemas
            rows = None
            for query in [
                """SELECT a.id, a.title, a.url, a.published_date, b.name AS blog_name,
                          COALESCE(a.categories, '') AS categories
                   FROM articles a
                   LEFT JOIN blogs b ON a.blog_id = b.id
                   WHERE a.is_read = 0
                   ORDER BY a.published_date DESC LIMIT 15""",
                """SELECT a.id, a.title, a.url, a.published_date, b.name AS blog_name,
                          '' AS categories
                   FROM articles a
                   LEFT JOIN blogs b ON a.blog_id = b.id
                   WHERE a.is_read = 0
                   ORDER BY a.published_date DESC LIMIT 15""",
            ]:
                try:
                    cur.execute(query)
                    rows = cur.fetchall()
                    break
                except sqlite3.OperationalError:
                    continue
            if rows is None:
                return 500, {"error": "No se pudo leer la tabla de artículos"}
        articles = []
        for r in rows:
            cat, emoji = _infer_category(r["blog_name"] or "")
            # use persisted categories if available
            if r["categories"]:
                cat = r["categories"].split(",")[0].strip() or cat
            articles.append({
                "id": r["id"],
                "title": r["title"] or r["url"],
                "url": r["url"],
                "publishedDate": r["published_date"],
                "blogName": r["blog_name"] or "Blog Desconocido",
                "category": cat,
                "emoji": emoji,
            })
        return 200, articles
    except Exception as e:
        return 500, {"error": f"Error al leer la base de datos de CDaily: {e}"}


def post_news_read(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, Any]:
    article_id = body.get("id")
    if not article_id:
        return 400, {"error": "Se requiere el ID del artículo"}

    db_path = _resolve_cdaily_db()
    if not db_path.exists():
        return 404, {"error": "Base de datos de CDaily no encontrada"}

    try:
        with closing(sqlite3.connect(str(db_path))) as conn:
            with conn:
                conn.execute("UPDATE articles SET is_read = 1 WHERE id = ?", (article_id,))
        return 200, {"success": True, "marked_id": article_id}
    except Exception as e:
        return 500, {"error": f"Error al actualizar la base de datos: {e}"}




def post_news_scan(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, Any]:
    """Escanear blogs ahora mismo via blogwatcher-cli."""
    try:
        import subprocess
        result = subprocess.run(
            ["blogwatcher-cli", "scan"],
            capture_output=True, text=True, timeout=120,
        )
        return 200, {
            "ok": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode,
        }
    except FileNotFoundError:
        return 500, {"ok": False, "error": "blogwatcher-cli no encontrado"}
    except subprocess.TimeoutExpired:
        return 500, {"ok": False, "error": "Timeout al escanear blogs (120s)"}
    except Exception as e:
        return 500, {"ok": False, "error": str(e)}

# ─── LabHub Status Routes ────────────────────────────────────────────────────

from server import labhub_adapter as _labhub


def get_labhub_status(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/labhub/status — overall Institutum reachability."""
    return 200, _labhub.get_labhub_overall_status()


def get_city_lab_status(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/labhub/status/{city_id} — lab status for a specific city.

    Query params:
        repoPath (str, optional): repo path for log link derivation.
    """
    city_id = ctx.get("city_id", "")
    if not city_id:
        return 400, {"error": "city_id is required"}
    params = ctx.get("params", {})
    repo_path = params.get("repoPath", "")
    return 200, _labhub.get_city_lab_status(city_id, repo_path=str(repo_path) if repo_path else None)


def get_all_cities_lab_status(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/labhub/status — batch lab status for all cities.

    Query params:
        cities (str, required): JSON-serialized list of city dicts with id, repoPath.
    """
    params = ctx.get("params", {})
    cities_raw = params.get("cities", "")
    if not cities_raw:
        return 400, {"error": "cities query param required (JSON array)"}
    try:
        cities = _json_lib.loads(str(cities_raw))
    except (_json_lib.JSONDecodeError, TypeError, ValueError):
        return 400, {"error": "cities must be valid JSON array"}
    if not isinstance(cities, list):
        return 400, {"error": "cities must be a JSON array"}
    return 200, _labhub.get_all_cities_lab_status(cities)


# ─── Wonder Registry Routes ──────────────────────────────────────────────────

from server import wonder_registry as _wr


def get_wonders(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /wonders — list all registered Wonder manifests."""
    return 200, _wr.list_wonders()


def get_wonder_by_id(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /wonders/{id} — single Wonder manifest."""
    wonder_id = ctx.get("wonder_id", "")
    manifest = _wr.get_wonder(wonder_id)
    if not manifest:
        return _error(404, f"wonder '{wonder_id}' not found",
                      f"No wonder registered with id '{wonder_id}'",
                      "Check available wonders: GET /api/wonders")
    return 200, manifest


def get_wonder_health(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /wonders/{id}/health — health check for a specific Wonder."""
    wonder_id = ctx.get("wonder_id", "")
    return 200, _wr.check_wonder_health(wonder_id)


# ─── Foreign Relations / Report Routes ────────────────────────────────────────

from server import repo_profile as _rp
from server import foreign_relations as _fr
from server import report_store as _rs
from server import city_graph_adapter as _cga
from server import graph_relations as _gr


def get_repo_profile(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/foreign/repo-profile — build profile for a repo path.

    Query params:
        repoPath (required): absolute path to the repo.
    """
    params = ctx.get("params", {})
    repo_path = params.get("repoPath", "")
    if not repo_path:
        return _error(400, "repoPath is required",
                      "Query parameter 'repoPath' is missing",
                      "Use /api/foreign/repo-profile?repoPath=/absolute/path/to/repo")
    profile = _rp.build_profile(repo_path)
    if profile is None:
        return _error(404, f"Repo path not found or not a directory: {repo_path}",
                      f"Path does not exist or is not a directory: {repo_path}",
                      "Verify the repo path exists and is a directory")
    return 200, profile


def get_repo_profile_cache(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/foreign/repo-profile/cache — list cached profiles."""
    cache = _rp.get_cached_profiles()
    return 200, {
        "count": len(cache),
        "profiles": {k: {"repoName": v.get("repoName", "") if v else None,
                         "recentFilesCount": v.get("recentFilesCount", 0) if v else 0}
                      for k, v in cache.items()},
    }


def post_foreign_score(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/foreign/score — score an article against a repo profile.

    Body:
        article (dict): article with title, blogName, category, url
        repoPath (str): path to the repo
        events (list, optional): recent events
    """
    article = body.get("article", {})
    repo_path = body.get("repoPath", "")
    events = body.get("events", [])

    if not article or not repo_path:
        return _error(400, "article and repoPath are required",
                      "Request body missing required fields",
                      "Send { article: {...}, repoPath: '/path/to/repo' }")

    profile = _rp.build_profile(repo_path)
    if profile is None:
        return _error(404, f"Repo path not found: {repo_path}",
                      f"Cannot build profile for '{repo_path}' — path does not exist or is not a directory",
                      "Send a valid repo path that exists on the filesystem")

    scoring = _fr.score_article_repo(article, profile, events=events if events else None)
    return 200, {
        "scoring": scoring,
        "profile": {
            "repoName": profile["repoName"],
            "repoPath": profile["repoPath"],
            "topLevelDirs": profile["topLevelDirs"][:10],
            "recentFilesCount": profile["recentFilesCount"],
            "skillTags": profile["skillTags"],
        },
    }


def post_foreign_report(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/foreign/report — generate and save a ForeignRelationsReport.

    Body:
        article (dict): article with title, blogName, category, url, id
        articles (list, optional): one or more related articles for grouped analysis
        repoPath (str): path to the target repo
        targetCityId (str): city ID for the target (optional, auto-detected if omitted)
        events (list, optional): recent events for context
        graphRelations (list, optional): bibliotheca graph relations
        agentId (str, optional): agent identifier (default 'diplomat')
    """
    article = body.get("article", {})
    articles = [a for a in body.get("articles", []) if isinstance(a, dict)]
    if not articles and article:
        articles = [article]
    repo_path = body.get("repoPath", "")
    target_city_id = body.get("targetCityId", "")
    events = body.get("events", [])
    graph_relations = body.get("graphRelations", [])
    agent_id = body.get("agentId", "diplomat")

    if not articles or not repo_path:
        return _error(400, "article/articles and repoPath are required",
                      "Request body missing required fields",
                      "Send { article: {...}|articles: [...], repoPath: '/path/to/repo' }")

    profile = _rp.build_profile(repo_path)
    if profile is None:
        return _error(404, f"Repo path not found: {repo_path}",
                      f"Cannot build profile for '{repo_path}' — path does not exist or is not a directory",
                      "Send a valid repo path that exists on the filesystem")

    primary_article = dict(articles[0])
    if len(articles) > 1:
        primary_article["title"] = f"{primary_article.get('title', '')} + {len(articles) - 1} noticia(s)"
        categories = sorted({str(a.get('category', '')).strip() for a in articles if a.get('category')})
        if categories:
            primary_article["category"] = ", ".join(categories[:3])

    scoring = _fr.score_article_repo(primary_article, profile, events=events if events else None)
    report = _fr.generate_report(
        article=primary_article,
        profile=profile,
        scoring=scoring,
        events=events if events else None,
        graph_relations=graph_relations if graph_relations else None,
        agent_id=agent_id,
    )

    if report is None:
        return 500, {"error": "Report generation failed"}

    # Enrich with article/repo links
    article_ids = [str(a.get("id", "")) for a in articles if a.get("id") is not None]
    report["articleIds"] = article_ids
    report["targetCityId"] = target_city_id or profile["repoName"]
    report["targetRepoPath"] = repo_path

    # Persist
    saved = _rs.save_report(report)
    return 200, saved


def get_reports(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/foreign/reports — list reports.

    Query params:
        cityId (str, optional): filter by target city
        articleId (str, optional): filter by article ID
    """
    params = ctx.get("params", {})
    city_id = params.get("cityId")
    article_id = params.get("articleId")
    reports = _rs.list_reports(city_id=city_id, article_id=article_id)
    return 200, reports


def get_report_by_id(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/foreign/reports/{id} — single report."""
    report_id = ctx.get("report_id", "")
    if not report_id:
        return _error(400, "report_id is required",
                      "Path parameter 'report_id' is missing",
                      "Use /api/foreign/reports/{report_id} with a valid report ID")
    report = _rs.get_report(report_id)
    if not report:
        return _error(404, f"Report not found: {report_id}",
                      f"No report exists with id '{report_id}'",
                      "Check existing reports: GET /api/foreign/reports")
    return 200, report


def delete_report_by_id(ctx: dict[str, Any], _body: dict[str, Any]) -> tuple[int, Any]:
    """DELETE /api/foreign/reports/{id} — delete a report."""
    report_id = ctx.get("report_id", "")
    if not report_id:
        return _error(400, "report_id is required",
                      "Path parameter 'report_id' is missing",
                      "Use /api/foreign/reports/{report_id} with a valid report ID")
    ok = _rs.delete_report(report_id)
    if not ok:
        return _error(404, f"Report not found: {report_id}",
                      f"No report exists with id '{report_id}'",
                      "Check existing reports: GET /api/foreign/reports")
    return 200, {"ok": True, "deleted": report_id}


# ─── Graph Relations Routes ──────────────────────────────────────────────


def get_graph_relations(ctx: dict[str, Any]) -> tuple[int, Any]:
    """GET /api/graph-relations — candidate relations for a city.

    Query params:
        cityId (str, required): the city ID to find relations for.
        limit (int, optional): max candidates (default 10).
        all (str, optional): if "true", return all candidates with no limit.
        cities (list, optional): serialized city list for name resolution.
    """
    params = ctx.get("params", {})
    city_id = params.get("cityId", "")
    if not city_id:
        return 400, {"error": "cityId is required"}

    limit_str = params.get("limit", "10")
    try:
        limit = int(limit_str)
    except (ValueError, TypeError):
        limit = 10

    if params.get("all", "").lower() in ("true", "1", "yes"):
        limit = 0  # unlimited

    # Cities list — passed either in params or as a serialized JSON string
    cities_raw = params.get("cities", "")
    cities: list[dict] = []
    if cities_raw:
        try:
            cities = _json_lib.loads(cities_raw)
        except (_json_lib.JSONDecodeError, TypeError):
            pass

    result = _cga.get_city_relations(city_id, cities, limit=limit if limit > 0 else 999)
    return 200, {"cityId": city_id, "count": len(result), "relations": result}


def get_graph_relations_evidence(ctx: dict[str, Any]) -> tuple[int, Any]:
    """GET /api/graph-relations/evidence — evidence between two cities.

    Query params:
        fromId (str, required): source city ID.
        toId (str, required): target city ID.
        cities (list, optional): serialized city list for name resolution.
    """
    params = ctx.get("params", {})
    from_id = ctx.get("from_id", params.get("fromId", ""))
    to_id = ctx.get("to_id", params.get("toId", ""))

    if not from_id or not to_id:
        return 400, {"error": "fromId and toId are required"}

    cities_raw = params.get("cities", "")
    cities: list[dict] = []
    if cities_raw:
        try:
            cities = _json_lib.loads(cities_raw)
        except (_json_lib.JSONDecodeError, TypeError):
            pass

    evidence = _cga.get_city_evidence(from_id, to_id, cities)
    return 200, evidence


def get_graph_relations_stats(_ctx: dict[str, Any]) -> tuple[int, Any]:
    """GET /api/graph-relations/stats — index stats."""
    stats = _gr.get_network_stats()
    return 200, stats


def post_graph_relations_flags(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/graph-relations/flags — sync opt-in flags from the UI."""
    flags = _gr.set_flags(
        graph_suggestions=body.get("graphSuggestions") if "graphSuggestions" in body else None,
        ai_relation_discovery=body.get("aiRelationDiscovery") if "aiRelationDiscovery" in body else None,
    )
    return 200, {"ok": True, "flags": flags}


def post_graph_relations_refresh(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/graph-relations/refresh — trigger index rebuild.

    Body:
        cities (list, optional): list of city dicts to rebuild index from.
        repoPaths (list, optional): direct repo paths for index build.
    """
    cities = body.get("cities", [])
    repo_paths = body.get("repoPaths", [])

    if cities:
        result = _cga.build_repo_index_from_cities(cities)
        return 200, result
    elif repo_paths:
        result = _gr.build_or_refresh_index(repo_paths)
        return 200, result
    else:
        return 400, {"error": "Provide either 'cities' or 'repoPaths' in the request body"}


def _validate_unit_id(raw: Any) -> str | None:
    """Return sanitized unit_id (uppercase, alphanumeric + dash/underscore, 1–32 chars)
    or None if the value is invalid. Guards against path-traversal attacks."""
    import re
    uid = str(raw or "").strip().upper()
    if not uid:
        return "DAVI"
    if re.fullmatch(r"[A-Z0-9_-]{1,32}", uid):
        return uid
    return None


def post_session_reset(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /session/reset — delete session files and return a new session nonce.

    Body: { "unit": "<unit_id>" }
    Response: { "ok": True, "newSessionId": "repociv-davi-<timestamp>" }
    """
    from server import sessions as _sessions
    unit_id = _validate_unit_id(body.get("unit", "DAVI"))
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
    unit_id = _validate_unit_id(body.get("unit", "DAVI"))
    if unit_id is None:
        return 400, {"error": "Invalid unit_id — must be alphanumeric/dash/underscore, max 32 chars"}
    provider = str(body.get("provider", "")).strip()
    model = str(body.get("model", "")).strip()
    if not provider or not model:
        return 400, {"error": "Both 'provider' and 'model' are required"}
    _ar.set_model_override(unit_id, provider, model)
    return 200, {"ok": True, "unit": unit_id, "provider": provider, "model": model}


# ─── Type alias ───────────────────────────────────────────────────────────────
RouteContext = dict[str, Any]
