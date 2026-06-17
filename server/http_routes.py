"""Compatibility shim for bridge.py and tests after Phase 4 route split."""
from __future__ import annotations

import json as _json_lib
from typing import Any

from server import city_graph_adapter as _cga  # noqa: E402
from server import graph_relations as _gr  # noqa: E402

from server.routes.core import _error  # noqa: F401
from server.routes.core import _auth_headers  # noqa: F401
from server.routes.core import _probe_url  # noqa: F401
from server.routes.core import _extract_model_ids  # noqa: F401
from server.routes.core import get_health  # noqa: F401
from server.routes.core import get_ready  # noqa: F401
from server.routes.core import get_missions  # noqa: F401
from server.routes.core import post_subagent_cancel  # noqa: F401
from server.routes.core import get_subagents  # noqa: F401
from server.routes.core import get_mission_tree  # noqa: F401
from server.routes.core import get_gpu  # noqa: F401
from server.routes.core import get_pending  # noqa: F401
from server.routes.core import get_context  # noqa: F401
from server.routes.core import get_approvals  # noqa: F401
from server.routes.core import get_agents  # noqa: F401
from server.routes.core import get_agents_capabilities  # noqa: F401
from server.routes.core import get_chat_config  # noqa: F401
from server.routes.core import get_metrics  # noqa: F401
from server.routes.core import get_directives_stats  # noqa: F401
from server.routes.core import get_directives_suggest  # noqa: F401
from server.routes.core import get_harnesses  # noqa: F401
from server.routes.core import get_default_harness  # noqa: F401
from server.routes.core import post_default_harness  # noqa: F401
from server.routes.core import get_profiles  # noqa: F401
from server.routes.core import post_profiles  # noqa: F401
from server.routes.core import post_profiles_delete  # noqa: F401
from server.routes.core import get_providers_live  # noqa: F401
from server.routes.core import get_log  # noqa: F401
from server.routes.core import get_ws_info  # noqa: F401
from server.routes.core import post_directives_record  # noqa: F401
from server.routes.core import post_commands  # noqa: F401
from server.routes.core import post_pending_add  # noqa: F401
from server.routes.core import post_pending_resolve  # noqa: F401
from server.routes.core import post_pending_edit  # noqa: F401
from server.routes.core import post_pending_delete  # noqa: F401
from server.routes.core import post_pending_state  # noqa: F401
from server.routes.core import _validate_unit_id  # noqa: F401
from server.routes.core import post_session_reset  # noqa: F401
from server.routes.core import post_model_override  # noqa: F401
from server.routes.core import get_hermes_status_route  # noqa: F401
from server.routes.tasks import get_tasks  # noqa: F401
from server.routes.tasks import get_task_by_key  # noqa: F401
from server.routes.tasks import get_improve_reflect  # noqa: F401
from server.routes.tasks import get_improve_proposals  # noqa: F401
from server.routes.graph import _resolve_cdaily_db  # noqa: F401
from server.routes.graph import _infer_category  # noqa: F401
from server.routes.graph import get_latest_news  # noqa: F401
from server.routes.graph import post_news_read  # noqa: F401
from server.routes.graph import post_news_scan  # noqa: F401
from server.routes.graph import get_wonders  # noqa: F401
from server.routes.graph import get_wonder_by_id  # noqa: F401
from server.routes.graph import get_wonder_health  # noqa: F401
from server.routes.foreign import get_labhub_status  # noqa: F401
from server.routes.foreign import get_city_lab_status  # noqa: F401
from server.routes.foreign import get_all_cities_lab_status  # noqa: F401
from server.routes.foreign import get_repo_profile  # noqa: F401
from server.routes.foreign import get_repo_profile_cache  # noqa: F401
from server.routes.foreign import post_foreign_score  # noqa: F401
from server.routes.foreign import post_foreign_report  # noqa: F401
from server.routes.foreign import get_reports  # noqa: F401
from server.routes.foreign import get_report_by_id  # noqa: F401
from server.routes.foreign import delete_report_by_id  # noqa: F401
from server.routes.foreign import get_repo_file_tree  # noqa: F401
from server.routes.wonder_ops import post_wonder_launch  # noqa: F401
from server.routes.wonder_ops import post_wonder_stop  # noqa: F401
from server.routes.wonder_ops import get_wonder_launch_status  # noqa: F401
from server.routes.wonder_ops import get_wonder_launchable  # noqa: F401

RouteContext = dict[str, Any]

def get_graph_relations(ctx: dict[str, Any]) -> tuple[int, Any]:
    """GET /api/graph-relations — candidate relations for a city.

    Query params:
        cityId (str, required): the city ID to find relations for.
        limit (int, optional): max candidates (default 10).
        all (str, optional): if "true", return all candidates with no limit.
        cities (list, optional): serialized city list for name resolution.
    """
    params = ctx.get("params", {})
    city_id = params.get("cityId", "")
    if not city_id:
        return 400, {"error": "cityId is required"}

    limit_str = params.get("limit", "10")
    try:
        limit = int(limit_str)
    except (ValueError, TypeError):
        limit = 10

    if params.get("all", "").lower() in ("true", "1", "yes"):
        limit = 0  # unlimited

    # Cities list — passed either in params or as a serialized JSON string
    cities_raw = params.get("cities", "")
    cities: list[dict] = []
    if cities_raw:
        try:
            cities = _json_lib.loads(cities_raw)
        except (_json_lib.JSONDecodeError, TypeError):
            pass

    result = _cga.get_city_relations(city_id, cities, limit=limit if limit > 0 else 999)
    return 200, {"cityId": city_id, "count": len(result), "relations": result}

def get_graph_relations_evidence(ctx: dict[str, Any]) -> tuple[int, Any]:
    """GET /api/graph-relations/evidence — evidence between two cities.

    Query params:
        fromId (str, required): source city ID.
        toId (str, required): target city ID.
        cities (list, optional): serialized city list for name resolution.
    """
    params = ctx.get("params", {})
    from_id = ctx.get("from_id", params.get("fromId", ""))
    to_id = ctx.get("to_id", params.get("toId", ""))

    if not from_id or not to_id:
        return 400, {"error": "fromId and toId are required"}

    cities_raw = params.get("cities", "")
    cities: list[dict] = []
    if cities_raw:
        try:
            cities = _json_lib.loads(cities_raw)
        except (_json_lib.JSONDecodeError, TypeError):
            pass

    evidence = _cga.get_city_evidence(from_id, to_id, cities)
    return 200, evidence

def get_graph_relations_stats(_ctx: dict[str, Any]) -> tuple[int, Any]:
    """GET /api/graph-relations/stats — index stats."""
    stats = _gr.get_network_stats()
    return 200, stats

def post_graph_relations_flags(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/graph-relations/flags — sync opt-in flags from the UI."""
    flags = _gr.set_flags(
        graph_suggestions=body.get("graphSuggestions") if "graphSuggestions" in body else None,
        ai_relation_discovery=body.get("aiRelationDiscovery") if "aiRelationDiscovery" in body else None,
    )
    return 200, {"ok": True, "flags": flags}

def post_graph_relations_refresh(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/graph-relations/refresh — trigger index rebuild.

    Body:
        cities (list, optional): list of city dicts to rebuild index from.
        repoPaths (list, optional): direct repo paths for index build.
    """
    cities = body.get("cities", [])
    repo_paths = body.get("repoPaths", [])

    # Cheap validation first — don't burn rate-limit tokens on bad input.
    if not cities and not repo_paths:
        return 400, {"error": "Provide either 'cities' or 'repoPaths' in the request body"}

    # Fase 1 / audit 1.2: per-endpoint cap (5/min). A full graph index
    # rebuild reads + writes the whole index — one of the heaviest
    # operations the bridge can do. Cap it so a stuck "refresh" button
    # or a malicious extension can't pin the CPU.
    from server.bridge import _endpoint_rate_limiter
    if not _endpoint_rate_limiter.check_and_consume("post_graph_relations_refresh"):
        return 429, {"error": "rate_limit", "endpoint": "post_graph_relations_refresh"}

    if cities:
        result = _cga.build_repo_index_from_cities(cities)
        return 200, result
    else:
        result = _gr.build_or_refresh_index(repo_paths)
        return 200, result
