"""Routes for the wonder auto-start endpoints (F2).

Wires ``server.wonder_launcher`` into the bridge HTTP layer. All
endpoints are token-gated and rate-limited at ``do_POST`` / ``do_GET``
in bridge.py; this module only validates inputs and maps the launcher
exceptions to HTTP responses.
"""

from __future__ import annotations

from typing import Any

from server import wonder_launcher
from server.wonder_launcher import WonderLauncherError


def _err(code: int, msg: str, error_code: str | None = None) -> tuple[int, Any]:
    body: dict[str, Any] = {"ok": False, "error": msg}
    if error_code is not None:
        body["code"] = error_code
    return code, body


def _ok(body: dict[str, Any]) -> tuple[int, Any]:
    return 200, {"ok": True, **body}


def _wonder_id_from(body: dict[str, Any], ctx: dict[str, Any]) -> str:
    """Extract wonder id from JSON body or path params.

    Both shapes are accepted so the same handler works for:
      POST /api/wonders/{id}/launch   (id in URL prefix-match)
      POST /api/wonders/launch        (id in body)
    The same shape applies to /stop.
    """
    if body and isinstance(body, dict):
        bid = body.get("id") or body.get("wonder_id")
        if bid:
            return str(bid)
    params = ctx.get("params", {}) if isinstance(ctx, dict) else {}
    if params.get("id"):
        return str(params["id"])
    if ctx.get("wonder_id"):
        return str(ctx["wonder_id"])
    return ""


# ─── POST /api/wonders/{id}/launch ────────────────────────────────────────────


def post_wonder_launch(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, Any]:
    wonder_id = _wonder_id_from(body, ctx)
    if not wonder_id:
        return _err(400, "missing wonder id (in URL path or body.id)")
    try:
        result = wonder_launcher.launch_wonder(wonder_id)
    except WonderLauncherError as e:
        return _err(e.status, e.message, e.code)
    return _ok(result)


# ─── GET /api/wonders/{id}/launch-status ──────────────────────────────────────


def get_wonder_launch_status(ctx: dict[str, Any]) -> tuple[int, Any]:
    wonder_id = ctx.get("wonder_id", "") if isinstance(ctx, dict) else ""
    if not wonder_id:
        return _err(400, "missing wonder id")
    try:
        result = wonder_launcher.wonder_launch_status(wonder_id)
    except WonderLauncherError as e:
        return _err(e.status, e.message, e.code)
    return _ok(result)


# ─── POST /api/wonders/{id}/stop ──────────────────────────────────────────────


def post_wonder_stop(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, Any]:
    wonder_id = _wonder_id_from(body, ctx)
    if not wonder_id:
        return _err(400, "missing wonder id (in URL path or body.id)")
    try:
        result = wonder_launcher.stop_wonder(wonder_id)
    except WonderLauncherError as e:
        return _err(e.status, e.message, e.code)
    # stop_wonder returns {ok, id, ...} with ok=False for "not launched".
    status = 200 if result.get("ok") else 400
    return status, result


# ─── GET /api/wonders/launchable ─────────────────────────────────────────────


def get_wonder_launchable(_ctx: dict[str, Any]) -> tuple[int, Any]:
    return _ok({"launchable": wonder_launcher.list_launchable()})
