"""RepoCiv HTTP route handlers split by domain (Phase 4)."""
from __future__ import annotations

from typing import Any

RouteContext = dict[str, Any]

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
