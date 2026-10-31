"""Pending-task routes."""
from __future__ import annotations

from typing import Any

RouteContext = dict[str, Any]


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
