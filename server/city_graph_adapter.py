#!/usr/bin/env python3
"""RepoCiv — City-to-Graph-Relations Adapter.

Bridges between RepoCiv city state (list of cities with ids + repoPaths)
and the graph_relations.py index/scoring engine.

Functions:
    build_repo_index_from_cities(cities)  — extract repo_base_paths, build/refresh index
    get_city_relations(city_id, cities, limit) — candidate relations for a city, mapped to city names
    get_bibliotheca_relations(repo_paths, limit) — direct repo-path lookup
    get_city_evidence(from_city_id, to_city_id, cities) — evidence between two cities
"""

from __future__ import annotations

from typing import Any

from server import graph_relations as _gr


def _cities_by_id(cities: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Build a quick lookup dict: city_id -> city dict."""
    return {c["id"]: c for c in cities if c.get("id")}


def _repo_paths_from_cities(cities: list[dict[str, Any]]) -> list[str]:
    """Extract all non-empty repo base paths from a list of cities."""
    paths: list[str] = []
    for c in cities:
        rp = c.get("repoPath", "") or ""
        if rp.strip():
            paths.append(rp.strip())
    return paths


def _city_name_for_id(city_id: str, cities_by_id: dict[str, dict[str, Any]]) -> str:
    """Return the city name for a given city ID, or the ID as fallback."""
    c = cities_by_id.get(city_id)
    if c:
        return c.get("name", city_id)
    return city_id


def _repo_id_from_city(city: dict[str, Any]) -> str | None:
    """Derive a graph_relations repo ID from a city.

    Uses the city's repoPath to compute a stable repo ID via
    graph_relations._repo_id_from_path.
    """
    rp = city.get("repoPath", "") or ""
    if not rp.strip():
        city_name = city.get("name", city.get("id", "unknown"))
        rp = f"/tmp/repociv_city/{city_name}"
    return _gr._repo_id_from_path(rp)


def build_repo_index_from_cities(cities: list[dict[str, Any]]) -> dict[str, Any]:
    """Build or refresh the graph relation index from city repo paths.

    Args:
        cities: List of city dicts, each containing at least 'id' and
                optionally 'repoPath'.

    Returns:
        dict with 'ok', 'indexedRepos', and 'stats' keys.
    """
    paths = _repo_paths_from_cities(cities)
    if not paths:
        return {"ok": False, "error": "No cities with repoPath found", "indexedRepos": 0}

    result = _gr.build_or_refresh_index(paths)
    return result


def get_city_relations(
    city_id: str,
    cities: list[dict[str, Any]],
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Get candidate relations for a city, mapping results to include city names.

    Args:
        city_id: The ID of the city to find relations for.
        cities: Full list of city dicts for name resolution.
        limit: Maximum number of candidates to return (default 10).

    Returns:
        List of candidate relation dicts, each augmented with:
          - fromCityName / toCityName
          - fromRepoPath / toRepoPath (if available)
    """
    lookup = _cities_by_id(cities)
    source_city = lookup.get(city_id)
    if not source_city:
        return []

    repo_id = _repo_id_from_city(source_city)
    if not repo_id:
        return [{"error": f"Could not derive repo ID for city '{city_id}'"}]

    candidates = _gr.get_candidates(repo_id, limit=limit)

    # Map results to include city names
    for cand in candidates:
        cand_repo_id = cand.get("to_node", "")
        # Try to find a city whose repo maps to this candidate
        matched_city = None
        for c in cities:
            c_repo_id = _repo_id_from_city(c)
            if c_repo_id == cand_repo_id:
                matched_city = c
                break

        # Map to frontend-expected field names
        cand["fromId"] = cand.get("from_node", repo_id)
        cand["toId"] = cand.get("to_node", cand_repo_id)
        cand["fromName"] = source_city.get("name", city_id)
        cand["toName"] = "???"
        cand["fromCityName"] = source_city.get("name", city_id)
        cand["fromRepoPath"] = source_city.get("repoPath", "")
        if matched_city:
            cand["toName"] = matched_city.get("name", cand_repo_id)
            cand["toCityName"] = matched_city.get("name", cand_repo_id)
            cand["toRepoPath"] = matched_city.get("repoPath", "")
            cand["toCityId"] = matched_city.get("id", cand_repo_id)
        else:
            cand["toName"] = cand_repo_id
            cand["toCityName"] = cand_repo_id
            cand["toRepoPath"] = cand.get("repoPath", cand_repo_id)
            cand["toCityId"] = cand_repo_id

    return candidates


def get_bibliotheca_relations(
    repo_paths: list[str],
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Direct repo-path lookup for candidate relations.

    Builds an index over the given repo paths (if not already built) and
    returns candidate relations for each path.

    Args:
        repo_paths: List of absolute repo base paths.
        limit: Maximum candidates per repo (default 10).

    Returns:
        List of candidate relation dicts for all repos.
    """
    if not repo_paths:
        return []

    # Build index if needed
    _gr.build_or_refresh_index(repo_paths)

    all_candidates: list[dict[str, Any]] = []
    seen_pairs: set[tuple[str, str]] = set()

    for rp in repo_paths:
        repo_id = _gr._repo_id_from_path(rp)
        candidates = _gr.get_candidates(repo_id, limit=limit)
        for cand in candidates:
            pair = (repo_id, cand.get("repoId", ""))
            if pair not in seen_pairs:
                seen_pairs.add(pair)
                cand["fromRepoPath"] = rp
                all_candidates.append(cand)

    return all_candidates


def get_city_evidence(
    from_city_id: str,
    to_city_id: str,
    cities: list[dict[str, Any]],
) -> dict[str, Any]:
    """Get relation evidence between two cities.

    Args:
        from_city_id: Source city ID.
        to_city_id: Target city ID.
        cities: Full list of city dicts for repo path resolution.

    Returns:
        Evidence dict from graph_relations.get_relation_evidence, augmented
        with city names and repo paths.
    """
    lookup = _cities_by_id(cities)
    from_city = lookup.get(from_city_id)
    to_city = lookup.get(to_city_id)

    if not from_city or not to_city:
        missing = []
        if not from_city:
            missing.append(f"from_city '{from_city_id}'")
        if not to_city:
            missing.append(f"to_city '{to_city_id}'")
        return {"error": f"City not found: {', '.join(missing)}"}

    from_repo_id = _repo_id_from_city(from_city)
    to_repo_id = _repo_id_from_city(to_city)

    if not from_repo_id or not to_repo_id:
        return {"error": "Could not derive repo IDs for one or both cities"}

    evidence = _gr.get_relation_evidence(from_repo_id, to_repo_id)

    # Enrich with city info
    evidence["fromCityId"] = from_city_id
    evidence["fromCityName"] = from_city.get("name", from_city_id)
    evidence["fromRepoPath"] = from_city.get("repoPath", "")
    evidence["toCityId"] = to_city_id
    evidence["toCityName"] = to_city.get("name", to_city_id)
    evidence["toRepoPath"] = to_city.get("repoPath", "")

    return evidence
