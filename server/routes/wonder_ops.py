"""Routes for the wonder auto-start endpoints (F2).

Wires ``server.wonder_launcher`` into the bridge HTTP layer. All
endpoints are token-gated and rate-limited at ``do_POST`` / ``do_GET``
in bridge.py; this module only validates inputs and maps the launcher
exceptions to HTTP responses.
"""

from __future__ import annotations

from typing import Any

from server import wonder_launcher, wonder_registry
from server.wonder_launcher import WonderLauncherError


def _err(code: int, msg: str, error_code: str | None = None) -> tuple[int, Any]:
    body: dict[str, Any] = {"ok": False, "error": msg}
    if error_code is not None:
        body["code"] = error_code
    return code, body


def _ok(body: dict[str, Any]) -> tuple[int, Any]:
    return 200, {"ok": True, **body}


def _wonder_id_from(body: dict[str, Any], ctx: dict[str, Any]) -> str:
    """Extract wonder id from the URL path first, falling back to the body.

    For prefix-match routes like ``/api/wonders/{id}/launch`` the bridge
    passes ``ctx["wonder_id"]`` derived from the URL — the URL wins
    over any body field to avoid surprises (POSTing
    /api/wonders/bibliotheca/launch with ``{"id":"institutum"}`` is
    a no-op for the URL, even though the allowlist would still accept
    the body value).

    For routes that don't have the id in the URL (e.g. an exact-match
    /api/wonders/launch), the body is the only source.
    """
    if isinstance(ctx, dict) and ctx.get("wonder_id"):
        return str(ctx["wonder_id"])
    if body and isinstance(body, dict):
        bid = body.get("id") or body.get("wonder_id")
        if bid:
            return str(bid)
    params = ctx.get("params", {}) if isinstance(ctx, dict) else {}
    if params.get("id"):
        return str(params["id"])
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


# ─── POST /api/wonders/connect ────────────────────────────────────────────────


def post_wonder_connect(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """Persist a user-connected wonder manifest and make it launchable.

    Body: a WonderManifest (+ optional ``launch`` block). Writes
    ~/.repociv/wonders/<id>.json and hot-reloads the launcher's custom specs
    so auto-start works without a bridge restart. Loopback-only is enforced at
    the launch layer; here we only gate the *launch* capability — connecting a
    manifest is a local-disk write, already token-gated by do_POST.
    """
    manifest = body.get("manifest") if isinstance(body, dict) and "manifest" in body else body
    saved, err = wonder_registry.save_custom_manifest(manifest)
    if err is not None:
        return _err(400, err, "invalid_manifest")
    wonder_launcher.reload_custom_specs()
    assert saved is not None
    return _ok({"id": saved["id"], "manifest": saved})


# ─── POST /api/wonders/{id}/disconnect ────────────────────────────────────────


def post_wonder_disconnect(body: dict[str, Any], ctx: dict[str, Any]) -> tuple[int, Any]:
    wonder_id = _wonder_id_from(body, ctx)
    if not wonder_id:
        return _err(400, "missing wonder id (in URL path or body.id)")
    ok, err = wonder_registry.delete_custom_manifest(wonder_id)
    if not ok:
        code = 404 if err == "not connected" else 400
        return _err(code, err or "disconnect failed", "disconnect_failed")
    wonder_launcher.reload_custom_specs()
    return _ok({"id": wonder_id})
