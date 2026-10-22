"""Health and readiness response handlers; transport registration stays in core."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

RouteContext = dict[str, Any]


def get_health(
    ctx: "RouteContext", *, identity_source: Callable[[], Any], now: Callable[[], float],
) -> tuple[int, Any]:
    from server.agent_runner import _has_claude_code, _has_openclaw, _has_cursor, _has_codex
    from server.bridge import _sched, get_gpu_info, _es, mcp_status
    from server import suvadu_tracker as _suvadu
    agent_status = _sched.get_agent_status()
    queue_depth = len(_sched.queue_snapshot())
    gpu = get_gpu_info()
    # R05: identity of the code actually loaded by this process. Served through
    # the module-level indirection so tests can stub it without a live bridge.
    build_identity = identity_source()
    if build_identity is None:
        from server import build_identity as build_identity_mod
        build_identity = build_identity_mod
    return 200, {
        "ok": True,
        "version": "0.1.0",
        "timestamp": now(),
        "openclaw": _has_openclaw(),
        "claudeCode": _has_claude_code(),
        "cursor": _has_cursor(),
        "codex": _has_codex(),
        "mcp": mcp_status(),
        "defaultTransport": "hermes",
        "agents": {
            "active": sum(1 for a in agent_status if a.get("status") == "active"),
            "total": len(agent_status),
            "queueDepth": queue_depth,
        },
        "gpu": gpu,
        "eventStore": str(_es._store_path) if hasattr(_es, "_store_path") else None,
        "externalAgents": _suvadu.status(),
        "buildDiagnostic": build_identity.snapshot(),
    }

def get_ready(ctx: "RouteContext") -> tuple[int, Any]:
    from server.bridge import _es, REPOCIV_TOKEN
    return 200, {"ok": True, "eventStore": str(_es._store_path), "token": bool(REPOCIV_TOKEN)}
