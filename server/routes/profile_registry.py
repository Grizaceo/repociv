"""RepoCiv profile registry handlers, separate from native-profile identity."""
from __future__ import annotations

from typing import Any

RouteContext = dict[str, Any]


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
            harness_ref=body.get("harness_ref"),
            display_name=body.get("display_name"),
            identity_mode=body.get("identity_mode"),
            slot_order=body.get("slot_order"),
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
