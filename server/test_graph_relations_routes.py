"""Tests for graph relations HTTP route handlers — get_graph_relations,
get_graph_relations_evidence, get_graph_relations_stats,
post_graph_relations_flags, post_graph_relations_refresh.

These test the route functions directly (passing ctx/body dicts) with
unittest.mock.patch on the upstream dependencies (_cga, _gr).
"""
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Import the module under test so we can patch its imports
import http_routes as routes  # noqa: E402


# ─── get_graph_relations ─────────────────────────────────────────────────────

def test_graph_relations_missing_city_id_returns_400():
    status, body = routes.get_graph_relations({"params": {}})
    assert status == 400
    assert "cityId" in body["error"]


def test_graph_relations_default_limit():
    mock_result = [{"targetId": "repo2", "score": 0.5}]
    with patch("http_routes._cga") as mock_cga:
        mock_cga.get_city_relations.return_value = mock_result
        status, body = routes.get_graph_relations({"params": {"cityId": "repo1"}})
    assert status == 200
    assert body["cityId"] == "repo1"
    assert body["count"] == 1
    assert body["relations"] == mock_result
    mock_cga.get_city_relations.assert_called_once_with("repo1", [], limit=10)


def test_graph_relations_custom_limit():
    with patch("http_routes._cga") as mock_cga:
        mock_cga.get_city_relations.return_value = []
        status, _ = routes.get_graph_relations({"params": {"cityId": "r1", "limit": "5"}})
    assert status == 200
    mock_cga.get_city_relations.assert_called_once_with("r1", [], limit=5)


def test_graph_relations_invalid_limit_defaults_to_10():
    with patch("http_routes._cga") as mock_cga:
        mock_cga.get_city_relations.return_value = []
        status, _ = routes.get_graph_relations({"params": {"cityId": "r1", "limit": "abc"}})
    assert status == 200
    mock_cga.get_city_relations.assert_called_once_with("r1", [], limit=10)


def test_graph_relations_all_flag():
    with patch("http_routes._cga") as mock_cga:
        mock_cga.get_city_relations.return_value = []
        status, _ = routes.get_graph_relations({"params": {"cityId": "r1", "all": "true"}})
    assert status == 200
    mock_cga.get_city_relations.assert_called_once_with("r1", [], limit=999)


def test_graph_relations_with_cities_json():
    import json
    cities = [{"id": "r1", "name": "Repo One"}]
    cities_json = json.dumps(cities)
    with patch("http_routes._cga") as mock_cga:
        mock_cga.get_city_relations.return_value = []
        status, _ = routes.get_graph_relations({"params": {"cityId": "r1", "cities": cities_json}})
    assert status == 200
    mock_cga.get_city_relations.assert_called_once_with("r1", cities, limit=10)


def test_graph_relations_invalid_cities_json_ignored():
    with patch("http_routes._cga") as mock_cga:
        mock_cga.get_city_relations.return_value = []
        status, _ = routes.get_graph_relations({"params": {"cityId": "r1", "cities": "not-json"}})
    assert status == 200
    mock_cga.get_city_relations.assert_called_once_with("r1", [], limit=10)


# ─── get_graph_relations_evidence ─────────────────────────────────────────────

def test_graph_relations_evidence_missing_ids_returns_400():
    status, body = routes.get_graph_relations_evidence({"params": {}})
    assert status == 400
    assert "fromId" in body["error"]


def test_graph_relations_evidence_success():
    mock_evidence = {"imports": ["dep1"], "entities": ["SAIR"], "score": 0.8}
    with patch("http_routes._cga") as mock_cga:
        mock_cga.get_city_evidence.return_value = mock_evidence
        status, body = routes.get_graph_relations_evidence(
            {"params": {"fromId": "r1", "toId": "r2"}}
        )
    assert status == 200
    assert body == mock_evidence
    mock_cga.get_city_evidence.assert_called_once_with("r1", "r2", [])


def test_graph_relations_evidence_with_cities():
    import json
    cities = [{"id": "r1"}]
    with patch("http_routes._cga") as mock_cga:
        mock_cga.get_city_evidence.return_value = {}
        routes.get_graph_relations_evidence(
            {"params": {"fromId": "r1", "toId": "r2", "cities": json.dumps(cities)}}
        )
    mock_cga.get_city_evidence.assert_called_once_with("r1", "r2", cities)


# ─── get_graph_relations_stats ────────────────────────────────────────────────

def test_graph_relations_stats_returns_stats():
    mock_stats = {"reposIndexed": 5, "totalEdges": 42, "lastUpdated": "2026-05-27"}
    with patch("http_routes._gr") as mock_gr:
        mock_gr.get_network_stats.return_value = mock_stats
        status, body = routes.get_graph_relations_stats({})
    assert status == 200
    assert body == mock_stats
    mock_gr.get_network_stats.assert_called_once()


# ─── post_graph_relations_flags ───────────────────────────────────────────────

def test_graph_relations_flags_graph_suggestions():
    with patch("http_routes._gr") as mock_gr:
        mock_gr.set_flags.return_value = {"graphSuggestions": True, "aiRelationDiscovery": False}
        status, body = routes.post_graph_relations_flags({"graphSuggestions": True}, {})
    assert status == 200
    assert body["ok"] is True
    mock_gr.set_flags.assert_called_once_with(graph_suggestions=True, ai_relation_discovery=None)


def test_graph_relations_flags_ai_discovery():
    with patch("http_routes._gr") as mock_gr:
        mock_gr.set_flags.return_value = {"graphSuggestions": True, "aiRelationDiscovery": True}
        status, body = routes.post_graph_relations_flags({"aiRelationDiscovery": True}, {})
    assert status == 200
    mock_gr.set_flags.assert_called_once_with(graph_suggestions=None, ai_relation_discovery=True)


def test_graph_relations_flags_both():
    with patch("http_routes._gr") as mock_gr:
        mock_gr.set_flags.return_value = {"graphSuggestions": False, "aiRelationDiscovery": False}
        status, body = routes.post_graph_relations_flags(
            {"graphSuggestions": False, "aiRelationDiscovery": False}, {}
        )
    assert status == 200
    mock_gr.set_flags.assert_called_once_with(graph_suggestions=False, ai_relation_discovery=False)


def test_graph_relations_flags_empty_body():
    with patch("http_routes._gr") as mock_gr:
        mock_gr.set_flags.return_value = {"graphSuggestions": True, "aiRelationDiscovery": True}
        status, body = routes.post_graph_relations_flags({}, {})
    assert status == 200
    mock_gr.set_flags.assert_called_once_with(graph_suggestions=None, ai_relation_discovery=None)


# ─── post_graph_relations_refresh ─────────────────────────────────────────────

def test_graph_relations_refresh_with_cities():
    mock_result = {"status": "ok", "reposIndexed": 3}
    with patch("http_routes._cga") as mock_cga:
        mock_cga.build_repo_index_from_cities.return_value = mock_result
        body = {"cities": [{"id": "r1", "repoPath": "/tmp/r1"}]}
        status, resp = routes.post_graph_relations_refresh(body, {})
    assert status == 200
    assert resp == mock_result
    mock_cga.build_repo_index_from_cities.assert_called_once_with(body["cities"])


def test_graph_relations_refresh_with_repo_paths():
    mock_result = {"status": "ok", "reposIndexed": 2}
    with patch("http_routes._gr") as mock_gr:
        mock_gr.build_or_refresh_index.return_value = mock_result
        body = {"repoPaths": ["/tmp/r1", "/tmp/r2"]}
        status, resp = routes.post_graph_relations_refresh(body, {})
    assert status == 200
    mock_gr.build_or_refresh_index.assert_called_once_with(["/tmp/r1", "/tmp/r2"])


def test_graph_relations_refresh_neither_returns_400():
    status, body = routes.post_graph_relations_refresh({}, {})
    assert status == 400
    assert "cities" in body["error"] or "repoPaths" in body["error"]
