"""RepoCiv — HTTP Route Handlers.

Each function here handles one route. It receives the parsed request body
(for POST) or query params (for GET), and returns a tuple:
  (status_code: int, response_body: Any)

BridgeHandler in bridge.py calls these and writes the response.
This makes routes individually testable without spinning up an HTTP server.
"""
from __future__ import annotations

from typing import Any


# ─── GET routes ───────────────────────────────────────────────────────────────

def get_health(ctx: "RouteContext") -> tuple[int, Any]:
    from server.agent_runner import _has_claude_code, _has_openclaw, _has_cursor
    return 200, {
        "ok": True,
        "openclaw": _has_openclaw(),
        "claudeCode": _has_claude_code(),
        "cursor": _has_cursor(),
        "defaultTransport": "hermes",
    }


def get_ready(ctx: "RouteContext") -> tuple[int, Any]:
    import os
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


def get_techdebt(ctx: "RouteContext") -> tuple[int, Any]:
    import os
    from pathlib import Path
    from server.bridge import scan_tech_debt
    root = os.environ.get("REPOCIV_REPOS_ROOT",
                          str(Path(__file__).parent.parent / "workspace" / "repos"))
    return 200, scan_tech_debt(root)


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


def get_harness_by_id(ctx: "RouteContext") -> tuple[int, Any]:
    from server import harness_registry as _hr
    harness_id = ctx.get("harness_id", "")
    harness = _hr.get_harness(harness_id)
    if harness is None:
        return 404, {"error": f"Harness '{harness_id}' not found"}
    return 200, harness


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
# RouteContext is just a plain dict carrying parsed path params or query params.
RouteContext = dict[str, Any]
