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
