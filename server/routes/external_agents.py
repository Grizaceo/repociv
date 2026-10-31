"""External and own agent session routes."""
from __future__ import annotations

from typing import Any

RouteContext = dict[str, Any]


def get_external_agents(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/external-agents — Suvadu / Hermes agent sessions (metadata only)."""
    from server import suvadu_tracker as _suvadu
    return 200, _suvadu.snapshot()

def get_external_agent_sessions(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/external-agents/sessions — every recent session, active or not."""
    from server import suvadu_tracker as _suvadu
    return 200, _suvadu.sessions()

def get_herdr_agents(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/herdr/agents — herdr's state and the agents it holds, for the terminal."""
    from server import herdr_runtime as _herdr
    status = _herdr.probe()
    if status.state != "ready":
        return 200, {"runtime": status.to_dict(), "agents": []}
    try:
        agents = [agent.to_dict() for agent in _herdr.list_agents()]
    except _herdr.HerdrError:
        return 200, {"runtime": _herdr.RuntimeStatus("stopped", status.version).to_dict(), "agents": []}
    return 200, {"runtime": status.to_dict(), "agents": agents}

def get_herdr_launch(ctx: "RouteContext") -> tuple[int, Any]:
    from server import herdr_launches
    entry = herdr_launches.get(str(ctx.get("command_id") or ""))
    return (200, entry) if entry is not None else (404, {"error": "launch_not_found"})

def get_own_sessions(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/own-sessions — RepoCiv's own sessions on disk + liveness."""
    from server import own_sessions as _own
    return 200, _own.snapshot()

def post_own_session_close(body: Any, ctx: "RouteContext") -> tuple[int, Any]:
    """POST /api/own-sessions/<unit>/close — retire the session's map unit.

    Explicit user action only: marks the canonical ``status: closed`` so the
    next snapshot reports the unit as closed (and the client despawns it).
    Never infers closure from liveness — an idle conversation is not a dead
    one (resumable-chat model, docs/plans/2026-09-19-hud-agentes-y-sesiones.md).
    """
    from server import sessions as _sessions

    unit_id = str((ctx or {}).get("params", {}).get("unit", ""))
    if not unit_id or not unit_id.replace("-", "").replace("_", "").isalnum():
        return 400, {"error": "invalid unit id"}
    canonical = _sessions.get(unit_id)
    if not isinstance(canonical, dict):
        return 404, {"error": "no such own session"}
    data = _sessions.patch(unit_id, status="closed")
    return 200, {"ok": True, "unit": unit_id, "status": data.get("status", "closed")}

def get_external_agent_chat(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/external-agents/<session>/chat[?limit=N&refresh=1] — prompts + responses."""
    from server import suvadu_tracker as _suvadu
    params = ctx.get("params", {})
    try:
        limit = int(params.get("limit", "80"))
    except (TypeError, ValueError):
        limit = 80
    refresh = str(params.get("refresh", "")).lower() in ("1", "true", "yes")
    return _suvadu.chat(str(ctx.get("session_id", "")), limit=limit, refresh=refresh)

def post_external_agent_chat(body: Any, ctx: "RouteContext") -> tuple[int, Any]:
    """POST /api/external-agents/<session>/chat — deliver to a verified live session."""
    import uuid

    from server import suvadu_tracker as _suvadu

    session_id = str(ctx.get("session_id", ""))
    text = body.get("text") if isinstance(body, dict) else None
    return _suvadu.send_live_chat(session_id, text, uuid.uuid4().hex)

def get_external_agent_resume(ctx: "RouteContext") -> tuple[int, Any]:
    """GET /api/external-agents/<session>/resume — the command to pick it back up."""
    from server import suvadu_tracker as _suvadu
    return _suvadu.resume(str(ctx.get("session_id", "")))

def post_external_agent_reply(body: Any, ctx: "RouteContext") -> tuple[int, Any]:
    """POST /api/external-agents/<session>/reply — run one turn with {text}.

    Policy first: this is the ``external_reply`` command type, so a policies.d
    overlay can promote it to approve/blocked before anything spawns."""
    from server import suvadu_tracker as _suvadu
    from server.command_schema import COMMAND_RISK, Command
    from server.policy import decide

    session_id = str(ctx.get("session_id", ""))
    text = str((body or {}).get("text", ""))
    cmd = Command(
        type="external_reply",
        target=session_id,
        risk=COMMAND_RISK.get("external_reply", "high"),
    )
    decision, reason = decide(cmd)
    if decision == "blocked":
        return 403, {"error": "blocked_by_policy", "reason": reason, "sessionId": session_id}
    if decision == "approve":
        return 409, {"error": "needs_approval", "reason": reason, "sessionId": session_id}
    return _suvadu.reply(session_id, text)
