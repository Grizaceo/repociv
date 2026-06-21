"""Exact-match HTTP route tables (path → handler).

Extracted from ``bridge.py``'s ``BridgeHandler``, which used to rebuild these
dicts on every single request. Centralizing them in the routes/ layer keeps the
HTTP-server module lean and makes the route map a single, greppable source of
truth. Resolution is unchanged: the same paths map to the same handlers that
``bridge.py`` dispatched before.

Handlers are sourced from ``http_routes``, the aggregation shim that re-exports
every domain handler from ``routes/*``. Importing it here adds no new import
cycle: ``http_routes`` and the ``routes/*`` modules only import ``bridge`` lazily
(inside functions), so this module loads cleanly at import time.

Note: parameterised / prefix routes (``/tasks/{repo}/{id}``, ``/api/wonders/{id}``,
``/harnesses/{id}``, …) still dispatch imperatively in ``bridge.py`` because they
mutate the request context; only the no-param exact matches live here.
"""
from __future__ import annotations

from typing import Any, Callable

from server import http_routes as _routes

# ── GET: no path params, matched by exact string ───────────────────────────────
GET_EXACT: dict[str, Callable[..., Any]] = {
    "/health": _routes.get_health,
    "/ready": _routes.get_ready,
    "/missions": _routes.get_missions,
    "/subagents": _routes.get_subagents,
    "/gpu": _routes.get_gpu,
    "/pending": _routes.get_pending,
    "/context": _routes.get_context,
    "/approvals": _routes.get_approvals,
    "/agents": _routes.get_agents,
    "/agents/capabilities": _routes.get_agents_capabilities,
    "/api/providers": _routes.get_chat_config,
    "/providers": _routes.get_chat_config,
    "/api/chat-config": _routes.get_chat_config,
    "/metrics": _routes.get_metrics,
    "/directives/stats": _routes.get_directives_stats,
    "/directives/suggest": _routes.get_directives_suggest,
    "/harnesses": _routes.get_harnesses,
    "/api/config/default-harness": _routes.get_default_harness,
    "/log": _routes.get_log,
    "/tasks": _routes.get_tasks,
    "/improve/reflect": _routes.get_improve_reflect,
    "/improve/proposals": _routes.get_improve_proposals,
    "/providers/live": _routes.get_providers_live,
    "/api/hermes/status": _routes.get_hermes_status_route,
    "/ws": _routes.get_ws_info,
    "/api/news/latest": _routes.get_latest_news,
    "/api/news/sources": _routes.get_news_sources,
    "/api/wonders": _routes.get_wonders,
    "/api/wonders/launchable": _routes.get_wonder_launchable,
    "/wonders": _routes.get_wonders,  # legacy alias
    "/api/graph-relations": _routes.get_graph_relations,
    "/api/graph-relations/stats": _routes.get_graph_relations_stats,
    "/api/foreign/repo-profile": _routes.get_repo_profile,
    "/api/foreign/repo-profile/cache": _routes.get_repo_profile_cache,
    "/api/foreign/reports": _routes.get_reports,
    "/api/labhub/status": _routes.get_labhub_status,
    "/api/profiles": _routes.get_profiles,
}

# ── POST: no path params, matched by exact string ──────────────────────────────
POST_EXACT: dict[str, Callable[..., Any]] = {
    "/directives/record": _routes.post_directives_record,
    "/commands": _routes.post_commands,
    "/pending/add": _routes.post_pending_add,
    "/pending/resolve": _routes.post_pending_resolve,
    "/pending/edit": _routes.post_pending_edit,
    "/pending/delete": _routes.post_pending_delete,
    "/pending/state": _routes.post_pending_state,
    "/api/news/read": _routes.post_news_read,
    "/api/news/scan": _routes.post_news_scan,
    "/api/news/sources/add": _routes.post_news_source_add,
    "/api/news/sources/remove": _routes.post_news_source_remove,
    "/api/foreign/score": _routes.post_foreign_score,
    "/api/foreign/report": _routes.post_foreign_report,
    "/api/graph-relations/flags": _routes.post_graph_relations_flags,
    "/api/graph-relations/refresh": _routes.post_graph_relations_refresh,
    "/session/reset": _routes.post_session_reset,
    "/model/override": _routes.post_model_override,
    "/api/config/default-harness": _routes.post_default_harness,
    "/subagents/cancel": _routes.post_subagent_cancel,
    "/api/profiles": _routes.post_profiles,
    "/api/profiles/delete": _routes.post_profiles_delete,
    "/api/wonders/connect": _routes.post_wonder_connect,
}
