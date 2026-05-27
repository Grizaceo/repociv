"""RepoCiv — Graph Relations: Scoring & Candidate Generation Module.

Generates candidate relations between repos using Jaccard similarity,
Adamic-Adar, resource allocation, PageRank, and random walks.
Exposes the public API: build_or_refresh_index, get_candidates,
get_relation_evidence, score_pair, get_network_stats, set_flags.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from collections import Counter, defaultdict
from functools import lru_cache
from math import log
from pathlib import Path
from typing import Any

# ── Import shared constants and keep module ref for mutable state ──────────

try:
    from server.graph_relations_base import *  # noqa: F401,F403
    from server.graph_relations_base import (  # noqa: F401
        _INDEX_DIR,
        _REPO_SIGNALS_DIR,
        _RELATION_CACHE_DIR,
        _META_FILE,
        _FLAGS_FILE,
        _MAX_EVENTS,
        _MAX_RANDOM_WALK_STEPS,
        _DEFAULT_FLAGS,
        _RUNTIME_FLAGS,
        _SUGGESTED_ACTIONS,
        _RELATION_TYPES,
        _IMPORT_PATTERNS,
        _MARKDOWN_LINK_RE,
        _MARKDOWN_HEADING_RE,
        _ENTITY_PATTERNS,
        _MANIFEST_PARSERS,
        _lock,
    )
    import server.graph_relations_base as _gr_base
except ImportError:
    from graph_relations_base import *  # noqa: F401,F403
    from graph_relations_base import (  # noqa: F401
        _INDEX_DIR,
        _REPO_SIGNALS_DIR,
        _RELATION_CACHE_DIR,
        _META_FILE,
        _FLAGS_FILE,
        _MAX_EVENTS,
        _MAX_RANDOM_WALK_STEPS,
        _DEFAULT_FLAGS,
        _RUNTIME_FLAGS,
        _SUGGESTED_ACTIONS,
        _RELATION_TYPES,
        _IMPORT_PATTERNS,
        _MARKDOWN_LINK_RE,
        _MARKDOWN_HEADING_RE,
        _ENTITY_PATTERNS,
        _MANIFEST_PARSERS,
        _lock,
    )
    import graph_relations_base as _gr_base

# ── Cross-module imports (functions used from sibling modules) ─────────────

try:
    from server.graph_signals import (  # noqa: F402
        _extract_repo_signals,
        _get_file_mtimes,
        _has_repo_changed,
        _jaccard,
        _load_recent_events,
        _repo_id_from_path,
    )
    from server.graph_index import (  # noqa: F402
        _check_coactivity,
        _load_all_signals,
        _load_meta,
        _load_relation_cache,
        _save_meta,
        _save_relation_cache,
        _save_repo_signals,
    )
except ImportError:
    from graph_signals import (  # noqa: F402
        _extract_repo_signals,
        _get_file_mtimes,
        _has_repo_changed,
        _jaccard,
        _load_recent_events,
        _repo_id_from_path,
    )
    from graph_index import (  # noqa: F402
        _check_coactivity,
        _load_all_signals,
        _load_meta,
        _load_relation_cache,
        _save_meta,
        _save_relation_cache,
        _save_repo_signals,
    )

def _score_jaccard(sig_a: dict[str, Any], sig_b: dict[str, Any]) -> dict[str, float]:
    """Compute Jaccard similarities across all signal dimensions."""
    scores: dict[str, float] = {}

    # Import overlap
    imps_a = set(sig_a.get("imports", []))
    imps_b = set(sig_b.get("imports", []))
    scores["imports"] = _jaccard(imps_a, imps_b)

    # Dependency overlap
    deps_a = set(sig_a.get("dependencies", []))
    deps_b = set(sig_b.get("dependencies", []))
    scores["dependencies"] = _jaccard(deps_a, deps_b)

    # Entity overlap
    ents_a = set(sig_a.get("entities", []))
    ents_b = set(sig_b.get("entities", []))
    scores["entities"] = _jaccard(ents_a, ents_b)

    # Tag overlap
    tags_a = set(sig_a.get("tags", []))
    tags_b = set(sig_b.get("tags", []))
    scores["tags"] = _jaccard(tags_a, tags_b)

    # Top dir overlap
    dirs_a = set(sig_a.get("topDirs", []))
    dirs_b = set(sig_b.get("topDirs", []))
    scores["topDirs"] = _jaccard(dirs_a, dirs_b)

    # Composite Jaccard: combined set of all signals
    all_a = imps_a | deps_a | ents_a | tags_a | dirs_a
    all_b = imps_b | deps_b | ents_b | tags_b | dirs_b
    scores["composite"] = _jaccard(all_a, all_b)

    return scores


def _adamic_adar(
    common: set[str], neighbor_sets: dict[str, set[str]]
) -> float:
    """Adamic-Adar: sum(1/log(degree(n))) over common neighbors."""
    total = 0.0
    for n in common:
        deg = len(neighbor_sets.get(n, set()))
        if deg > 1:
            total += 1.0 / log(deg)
        elif deg == 1:
            total += 1.0
    return total


def _resource_allocation(
    common: set[str], neighbor_sets: dict[str, set[str]]
) -> float:
    """Resource allocation: sum(1/degree(n)) over common neighbors."""
    total = 0.0
    for n in common:
        deg = len(neighbor_sets.get(n, set()))
        if deg > 0:
            total += 1.0 / deg
    return total


def _build_neighbor_graph(all_signals: dict[str, dict[str, Any]]) -> dict[str, set[str]]:
    """Build a simple neighbor graph from signal overlaps for Adamic-Adar / RA."""
    graph: dict[str, set[str]] = defaultdict(set)
    repo_ids = list(all_signals.keys())
    for i, rid_a in enumerate(repo_ids):
        sig_a = all_signals[rid_a]
        set_a = (
            set(sig_a.get("imports", []))
            | set(sig_a.get("dependencies", []))
            | set(sig_a.get("entities", []))
            | set(sig_a.get("tags", []))
        )
        for rid_b in repo_ids[i + 1:]:
            sig_b = all_signals[rid_b]
            set_b = (
                set(sig_b.get("imports", []))
                | set(sig_b.get("dependencies", []))
                | set(sig_b.get("entities", []))
                | set(sig_b.get("tags", []))
            )
            if set_a & set_b:
                graph[rid_a].add(rid_b)
                graph[rid_b].add(rid_a)
    return dict(graph)


def _build_item_graph(
    all_signals: dict[str, dict[str, Any]]
) -> dict[str, set[str]]:
    """Build a bipartite-like graph: items (deps, entities, tags) -> set of repo IDs."""
    item_graph: dict[str, set[str]] = defaultdict(set)
    for rid, sig in all_signals.items():
        for item in sig.get("imports", []):
            item_graph[f"__import__:{item}"].add(rid)
        for item in sig.get("dependencies", []):
            item_graph[f"__dep__:{item}"].add(rid)
        for item in sig.get("entities", []):
            item_graph[f"__ent__:{item}"].add(rid)
        for item in sig.get("tags", []):
            item_graph[f"__tag__:{item}"].add(rid)
        for d in sig.get("topDirs", []):
            item_graph[f"__dir__:{d}"].add(rid)
    return dict(item_graph)


def _personalized_pagerank(
    seed: str,
    neighbor_graph: dict[str, set[str]],
    alpha: float = 0.85,
    max_iter: int = 50,
    tol: float = 1e-6,
) -> dict[str, float]:
    """Personalized PageRank (random walk with restart) from a seed node."""
    nodes = list(neighbor_graph.keys())
    if not nodes or seed not in neighbor_graph:
        return {}
    ranks: dict[str, float] = {n: 0.0 for n in nodes}
    ranks[seed] = 1.0
    for _ in range(max_iter):
        new_ranks: dict[str, float] = defaultdict(float)
        for n in nodes:
            if ranks[n] == 0:
                continue
            neighbors = neighbor_graph.get(n, set())
            if neighbors:
                share = ranks[n] / len(neighbors)
                for nb in neighbors:
                    new_ranks[nb] += share * alpha
            # Restart probability
            new_ranks[n] += ranks[n] * (1 - alpha)
        # Add teleport back to seed
        new_ranks[seed] += (1 - sum(new_ranks.values())) if sum(new_ranks.values()) < 1.0 else 0
        # Check convergence
        diff = sum(abs(new_ranks.get(n, 0) - ranks.get(n, 0)) for n in nodes)
        ranks = dict(new_ranks)
        if diff < tol:
            break
    # Normalize so max is 1.0
    max_r = max(ranks.values()) if ranks else 1.0
    return {k: v / max_r for k, v in ranks.items()}


def _random_walk_similarity(
    from_id: str,
    to_id: str,
    neighbor_graph: dict[str, set[str]],
    budget: int = 100,
) -> float:
    """Estimate similarity via short random walks from from_id hitting to_id."""
    if from_id not in neighbor_graph or to_id not in neighbor_graph:
        return 0.0
    if from_id == to_id:
        return 1.0
    import random as _random
    hits = 0
    for _ in range(budget):
        current = from_id
        for step in range(10):  # Max walk length
            neighbors = list(neighbor_graph.get(current, set()))
            if not neighbors:
                break
            current = _random.choice(neighbors)
            if current == to_id:
                hits += 1
                break
    return hits / budget


# ─── Candidate Generation ──────────────────────────────────────────────────────


def _generate_candidates_for(
    repo_id: str,
    all_signals: dict[str, dict[str, Any]],
    neighbor_graph: dict[str, set[str]],
    flags: dict[str, bool],
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Generate relation candidates for a given repo using cheap heuristics."""
    sig_a = all_signals.get(repo_id)
    if not sig_a:
        return []

    candidates: dict[str, dict[str, Any]] = {}

    # Skip candidate generation unless graphSuggestions was explicitly enabled.
    if not flags.get("graphSuggestions", False):
        return []

    ai_discovery = flags.get("aiRelationDiscovery", False)

    for other_id, sig_b in all_signals.items():
        if other_id == repo_id:
            continue

        relations: list[dict[str, Any]] = []

        # --- Shared dependencies ---
        deps_a = set(sig_a.get("dependencies", []))
        deps_b = set(sig_b.get("dependencies", []))
        shared_deps = deps_a & deps_b
        if shared_deps:
            score = min(len(shared_deps) / max(len(deps_a | deps_b), 1) * 2, 1.0)
            relations.append({
                "relation_type": "shared_dependency",
                "score": round(score, 4),
                "evidence": [f"Both depend on {d}" for d in list(shared_deps)[:5]],
                "suggested_actions": _SUGGESTED_ACTIONS,
                "from_node": repo_id,
                "to_node": other_id,
            })

        # --- Shared entities ---
        ents_a = set(sig_a.get("entities", []))
        ents_b = set(sig_b.get("entities", []))
        shared_ents = ents_a & ents_b
        if shared_ents:
            score = min(len(shared_ents) / max(len(ents_a | ents_b), 1) * 2, 1.0)
            relations.append({
                "relation_type": "shared_entity",
                "score": round(score, 4),
                "evidence": [f"Both contain entity '{e}'" for e in list(shared_ents)[:5]],
                "suggested_actions": _SUGGESTED_ACTIONS,
                "from_node": repo_id,
                "to_node": other_id,
            })

        # --- Imports or links ---
        imps_a = set(sig_a.get("imports", []))
        imps_b = set(sig_b.get("imports", []))
        shared_imps = imps_a & imps_b
        if shared_imps:
            score = min(len(shared_imps) / max(len(imps_a | imps_b), 1) * 2, 1.0)
            relations.append({
                "relation_type": "imports_or_links",
                "score": round(score, 4),
                "evidence": [f"Both import '{i}'" for i in list(shared_imps)[:5]],
                "suggested_actions": _SUGGESTED_ACTIONS,
                "from_node": repo_id,
                "to_node": other_id,
            })

        # --- Markdown links (repo A links to repo B) ---
        other_name = sig_b.get("repoName", "")
        for link in sig_a.get("markdownLinks", []):
            url = link.get("url", "")
            if other_name.lower() in url.lower() or other_name.lower() in link.get("text", "").lower():
                relations.append({
                    "relation_type": "imports_or_links",
                    "score": 0.8,
                    "evidence": [f"README links to '{other_name}' via [{link['text']}]({link['url']})"],
                    "suggested_actions": _SUGGESTED_ACTIONS,
                    "from_node": repo_id,
                    "to_node": other_id,
                })
                break

        # --- Same lab family (same parent directory prefix) ---
        path_a = sig_a.get("repoPath", "")
        path_b = sig_b.get("repoPath", "")
        parent_a = str(Path(path_a).parent)
        parent_b = str(Path(path_b).parent)
        if parent_a and parent_b and parent_a == parent_b:
            relations.append({
                "relation_type": "same_lab_family",
                "score": 0.7,
                "evidence": [f"Both repos live under '{parent_a}'"],
                "suggested_actions": _SUGGESTED_ACTIONS,
                "from_node": repo_id,
                "to_node": other_id,
            })

        # --- Similar paths ---
        dirs_a = set(sig_a.get("topDirs", []))
        dirs_b = set(sig_b.get("topDirs", []))
        shared_dirs = dirs_a & dirs_b
        if shared_dirs:
            score = min(len(shared_dirs) / max(len(dirs_a | dirs_b), 1) * 2, 1.0)
            relations.append({
                "relation_type": "conceptual_overlap",
                "score": round(score, 4),
                "evidence": [f"Both have '{d}' directory" for d in list(shared_dirs)[:3]],
                "suggested_actions": _SUGGESTED_ACTIONS,
                "from_node": repo_id,
                "to_node": other_id,
            })

        # --- Security relevance ---
        all_text_a = " ".join(sig_a.get("entities", []) + sig_a.get("tags", []) + sig_a.get("markdownHeadings", []))
        all_text_b = " ".join(sig_b.get("entities", []) + sig_b.get("tags", []) + sig_b.get("markdownHeadings", []))
        sec_words = {"security", "vulnerability", "cve", "exploit", "yara", "malware", "pentest", "cyber"}
        sec_in_a = any(w in all_text_a.lower() for w in sec_words)
        sec_in_b = any(w in all_text_b.lower() for w in sec_words)
        if sec_in_a and sec_in_b:
            relations.append({
                "relation_type": "security_relevance",
                "score": 0.6,
                "evidence": ["Both repos contain security-related terms in entities/tags/headings"],
                "suggested_actions": _SUGGESTED_ACTIONS,
                "from_node": repo_id,
                "to_node": other_id,
            })

        # --- Temporal coactivity ---
        if ai_discovery and os.path.isdir(path_a) and os.path.isdir(path_b):
            coact_score, coact_evidence = _check_coactivity(path_a, path_b)
            if coact_score > 0:
                relations.append({
                    "relation_type": "temporal_coactivity",
                    "score": round(coact_score, 4),
                    "evidence": coact_evidence[:3],
                    "suggested_actions": _SUGGESTED_ACTIONS,
                    "from_node": repo_id,
                    "to_node": other_id,
                })

        # --- Conceptual overlap via Jaccard composite ---
        set_a = deps_a | ents_a | imps_a | set(sig_a.get("tags", []))
        set_b = deps_b | ents_b | imps_b | set(sig_b.get("tags", []))
        jacc = _jaccard(set_a, set_b)
        threshold = 0.1
        if jacc >= threshold and not any(r["relation_type"] in ("shared_dependency", "shared_entity", "imports_or_links") for r in relations):
            relations.append({
                "relation_type": "conceptual_overlap",
                "score": round(jacc, 4),
                "evidence": [f"Composite Jaccard similarity: {jacc:.3f}"],
                "suggested_actions": _SUGGESTED_ACTIONS,
                "from_node": repo_id,
                "to_node": other_id,
            })

        # --- Unknown but interesting (low-level noise but non-zero signal) ---
        if not relations and jacc > 0.03:
            relations.append({
                "relation_type": "unknown_but_interesting",
                "score": round(jacc, 4),
                "evidence": [f"Weak composite overlap (Jaccard={jacc:.3f}) — may warrant investigation"],
                "suggested_actions": _SUGGESTED_ACTIONS,
                "from_node": repo_id,
                "to_node": other_id,
            })

        # Pick the best relation for this pair
        if relations:
            best = max(relations, key=lambda r: r["score"])
            candidates[other_id] = best

    # Add PageRank-based candidates if aiRelationDiscovery is enabled
    if ai_discovery and neighbor_graph and repo_id in neighbor_graph:
        ppr = _personalized_pagerank(repo_id, neighbor_graph, max_iter=30)
        for other_id, pr_score in ppr.items():
            if other_id == repo_id:
                continue
            if pr_score < 0.05:
                continue
            if other_id not in candidates:
                candidates[other_id] = {
                    "relation_type": "conceptual_overlap",
                    "score": round(pr_score, 4),
                    "evidence": [f"Personalized PageRank score: {pr_score:.3f} (random walk with restart)"],
                    "suggested_actions": _SUGGESTED_ACTIONS,
                    "from_node": repo_id,
                    "to_node": other_id,
                }
            else:
                # Boost existing candidate if PageRank agrees
                candidates[other_id]["score"] = min(candidates[other_id]["score"] + pr_score * 0.2, 1.0)
                candidates[other_id]["evidence"].append(f"PageRank boost: {pr_score:.3f}")

    # Sort by score descending and limit
    sorted_candidates = sorted(candidates.values(), key=lambda r: r["score"], reverse=True)
    return sorted_candidates[:limit]


# ─── Public API ────────────────────────────────────────────────────────────────


def build_or_refresh_index(repo_base_paths: list[str]) -> dict[str, Any]:
    """Scan repos, build/update the signal index incrementally.

    Args:
        repo_base_paths: List of absolute paths to repos to index.

    Returns:
        dict with stats: nodes_indexed, nodes_skipped, errors, last_updated, elapsed
    """
    start = time.time()
    meta = _load_meta()
    flags = _gr_base._load_flags()
    stats: dict[str, Any] = {
        "nodes_indexed": 0,
        "nodes_skipped": 0,
        "errors": [],
        "last_updated": time.time(),
        "elapsed": 0.0,
    }

    for repo_path_str in repo_base_paths:
        repo_path = Path(repo_path_str).expanduser().resolve()
        if not repo_path.is_dir():
            stats["errors"].append(f"Not a directory: {repo_path_str}")
            continue

        try:
            repo_id = _repo_id_from_path(str(repo_path))

            # Incremental check: only re-process if files changed
            if not _has_repo_changed(repo_path, meta):
                stats["nodes_skipped"] += 1
                continue

            signals = _extract_repo_signals(repo_path)
            _save_repo_signals(repo_id, signals)

            # Update meta with current mtimes
            current_mtimes = _get_file_mtimes(repo_path)
            if current_mtimes:
                meta[repo_id] = current_mtimes

            stats["nodes_indexed"] += 1
        except Exception as exc:
            stats["errors"].append(f"{repo_path_str}: {exc}")

    # Save updated meta
    _save_meta(meta)

    # Invalidate relation caches on re-index
    if stats["nodes_indexed"] > 0:
        _RELATION_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        for fp in _RELATION_CACHE_DIR.glob("*.json"):
            try:
                fp.unlink()
            except OSError:
                pass

    # Load recent events and save as a global signal
    try:
        events = _load_recent_events()
        _INDEX_DIR.mkdir(parents=True, exist_ok=True)
        (_INDEX_DIR / "recent_events.json").write_text(
            json.dumps(events, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    except Exception:
        pass

    stats["elapsed"] = round(time.time() - start, 3)
    return stats


def get_candidates(repo_id: str, limit: int = 10) -> list[dict[str, Any]]:
    """Return candidate relations for a repo. Uses cached results when available.

    Args:
        repo_id: The repo identifier (from _repo_id_from_path).
        limit: Max candidates to return.

    Returns:
        List of relation dicts, each with:
            relation_type, score, evidence, suggested_actions, from_node, to_node
    """
    all_signals = _load_all_signals()
    if not all_signals:
        return []
    if repo_id not in all_signals:
        return []

    flags = _gr_base._load_flags()

    # Build neighbor graph for scoring
    neighbor_graph = _build_neighbor_graph(all_signals)

    candidates = _generate_candidates_for(repo_id, all_signals, neighbor_graph, flags, limit=limit)
    return candidates


def get_relation_evidence(from_id: str, to_id: str) -> dict[str, Any]:
    """Get detailed evidence between two repos.

    Returns a dict with:
        from_id, to_id, relation_type, score, evidence, suggested_actions,
        jaccard_scores, coactivity, exists
    """
    cache_key = f"{from_id}__{to_id}"
    cached = _load_relation_cache(cache_key)
    if cached:
        return cached

    all_signals = _load_all_signals()
    sig_a = all_signals.get(from_id)
    sig_b = all_signals.get(to_id)

    if not sig_a or not sig_b:
        return {
            "from_id": from_id,
            "to_id": to_id,
            "exists": False,
            "error": "One or both repos not in index",
        }

    flags = _gr_base._load_flags()
    neighbor_graph = _build_neighbor_graph(all_signals)

    # Generate all candidates for from_id and find the one for to_id
    candidates = _generate_candidates_for(from_id, all_signals, neighbor_graph, flags, limit=100)
    match = None
    for c in candidates:
        if c["to_node"] == to_id:
            match = c
            break

    # Compute Jaccard dimensions
    jaccard_scores = _score_jaccard(sig_a, sig_b)

    # Coactivity
    coact_score = 0.0
    coact_evidence: list[str] = []
    path_a = sig_a.get("repoPath", "")
    path_b = sig_b.get("repoPath", "")
    if flags.get("aiRelationDiscovery", False) and os.path.isdir(path_a) and os.path.isdir(path_b):
        coact_score, coact_evidence = _check_coactivity(path_a, path_b)

    result: dict[str, Any] = {
        "from_id": from_id,
        "to_id": to_id,
        "exists": match is not None,
        "relation": match,
        "jaccard_scores": jaccard_scores,
        "coactivity": {"score": coact_score, "evidence": coact_evidence},
        "from_signals": {
            "repoName": sig_a.get("repoName"),
            "entity_count": len(sig_a.get("entities", [])),
            "import_count": len(sig_a.get("imports", [])),
            "dependency_count": len(sig_a.get("dependencies", [])),
            "tag_count": len(sig_a.get("tags", [])),
            "link_count": len(sig_a.get("markdownLinks", [])),
            "heading_count": len(sig_a.get("markdownHeadings", [])),
        },
        "to_signals": {
            "repoName": sig_b.get("repoName"),
            "entity_count": len(sig_b.get("entities", [])),
            "import_count": len(sig_b.get("imports", [])),
            "dependency_count": len(sig_b.get("dependencies", [])),
            "tag_count": len(sig_b.get("tags", [])),
            "link_count": len(sig_b.get("markdownLinks", [])),
            "heading_count": len(sig_b.get("markdownHeadings", [])),
        },
    }

    _save_relation_cache(cache_key, result)
    return result


def score_pair(from_id: str, to_id: str) -> dict[str, Any]:
    """Score two repos with all scoring functions (Jaccard, Adamic-Adar, RA, PageRank, random walks).

    Returns:
        dict with all scoring dimensions.
    """
    all_signals = _load_all_signals()
    sig_a = all_signals.get(from_id)
    sig_b = all_signals.get(to_id)

    if not sig_a or not sig_b:
        return {
            "from_id": from_id,
            "to_id": to_id,
            "error": "One or both repos not in index",
        }

    flags = _gr_base._load_flags()
    neighbor_graph = _build_neighbor_graph(all_signals)
    item_graph = _build_item_graph(all_signals)

    # Jaccard scores
    jaccard_scores = _score_jaccard(sig_a, sig_b)

    # Composite sets for link prediction
    set_a = (
        set(sig_a.get("imports", []))
        | set(sig_a.get("dependencies", []))
        | set(sig_a.get("entities", []))
        | set(sig_a.get("tags", []))
        | set(sig_a.get("topDirs", []))
    )
    set_b = (
        set(sig_b.get("imports", []))
        | set(sig_b.get("dependencies", []))
        | set(sig_b.get("entities", []))
        | set(sig_b.get("tags", []))
        | set(sig_b.get("topDirs", []))
    )
    common = set_a & set_b

    # Adamic-Adar
    # Build neighbor sets for each common item
    neighbor_sets: dict[str, set[str]] = {}
    for item in common:
        for prefix in ("__import__:", "__dep__:", "__ent__:", "__tag__:", "__dir__:"):
            key = f"{prefix}{item}"
            if key in item_graph:
                neighbor_sets[item] = item_graph[key]
                break

    aa_score = _adamic_adar(common, neighbor_sets)
    ra_score = _resource_allocation(common, neighbor_sets)

    # Normalize AA and RA by max possible (every item shared by exactly 2 repos)
    max_aa = sum(1.0 / log(2) for _ in common) if common else 1.0
    max_ra = sum(1.0 / 2 for _ in common) if common else 1.0
    aa_norm = min(aa_score / max_aa, 1.0) if max_aa > 0 else 0.0
    ra_norm = min(ra_score / max_ra, 1.0) if max_ra > 0 else 0.0

    # PageRank
    ppr_score = 0.0
    if flags.get("aiRelationDiscovery", False) and neighbor_graph and from_id in neighbor_graph:
        ppr = _personalized_pagerank(from_id, neighbor_graph, max_iter=30)
        ppr_score = ppr.get(to_id, 0.0)

    # Random walk
    rw_score = 0.0
    if flags.get("aiRelationDiscovery", False) and neighbor_graph:
        rw_score = _random_walk_similarity(from_id, to_id, neighbor_graph, budget=_MAX_RANDOM_WALK_STEPS)

    # Coactivity
    coact_score = 0.0
    coact_evidence: list[str] = []
    path_a = sig_a.get("repoPath", "")
    path_b = sig_b.get("repoPath", "")
    if flags.get("aiRelationDiscovery", False) and os.path.isdir(path_a) and os.path.isdir(path_b):
        coact_score, coact_evidence = _check_coactivity(path_a, path_b)

    # Composite score (weighted average)
    w_jaccard = 0.25
    w_aa = 0.15
    w_ra = 0.10
    w_ppr = 0.20 if flags.get("aiRelationDiscovery", False) else 0.0
    w_rw = 0.10 if flags.get("aiRelationDiscovery", False) else 0.0
    w_coact = 0.10 if flags.get("aiRelationDiscovery", False) else 0.0
    w_extra = 0.10

    composite = (
        jaccard_scores.get("composite", 0) * w_jaccard
        + aa_norm * w_aa
        + ra_norm * w_ra
        + ppr_score * w_ppr
        + rw_score * w_rw
        + coact_score * w_coact
        + (jaccard_scores.get("imports", 0) + jaccard_scores.get("dependencies", 0)) / 2 * w_extra
    )
    composite = min(max(composite, 0.0), 1.0)

    return {
        "from_id": from_id,
        "to_id": to_id,
        "composite_score": round(composite, 4),
        "jaccard": {k: round(v, 4) for k, v in jaccard_scores.items()},
        "adamic_adar": round(aa_norm, 4),
        "resource_allocation": round(ra_norm, 4),
        "personalized_pagerank": round(ppr_score, 4),
        "random_walk": round(rw_score, 4),
        "coactivity": round(coact_score, 4),
        "coactivity_evidence": coact_evidence,
        "common_items_count": len(common),
        "aiRelationDiscovery_enabled": flags.get("aiRelationDiscovery", False),
    }


def get_network_stats() -> dict[str, Any]:
    """Get index statistics: nodes, edges, last_updated, signal counts, etc."""
    meta = _load_meta()
    all_signals = _load_all_signals()

    node_count = len(all_signals)
    last_updated = 0.0
    for sig in all_signals.values():
        ts = sig.get("lastIndexed", 0)
        if ts > last_updated:
            last_updated = ts

    # Count edges (pairs with any overlap)
    edge_count = 0
    total_imports = 0
    total_deps = 0
    total_entities = 0
    total_tags = 0
    total_links = 0

    repo_ids = list(all_signals.keys())
    for i, rid in enumerate(repo_ids):
        sig = all_signals[rid]
        total_imports += len(sig.get("imports", []))
        total_deps += len(sig.get("dependencies", []))
        total_entities += len(sig.get("entities", []))
        total_tags += len(sig.get("tags", []))
        total_links += len(sig.get("markdownLinks", []))
        for j in range(i + 1, len(repo_ids)):
            sig_b = all_signals[repo_ids[j]]
            set_a = set(sig.get("imports", [])) | set(sig.get("dependencies", [])) | set(sig.get("entities", [])) | set(sig.get("tags", []))
            set_b = set(sig_b.get("imports", [])) | set(sig_b.get("dependencies", [])) | set(sig_b.get("entities", [])) | set(sig_b.get("tags", []))
            if set_a & set_b:
                edge_count += 1

    return {
        "nodes": node_count,
        "edges": edge_count,
        "last_updated": last_updated,
        "last_updated_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last_updated)) if last_updated else "never",
        "index_meta_files": len(meta),
        "total_signals": {
            "imports": total_imports,
            "dependencies": total_deps,
            "entities": total_entities,
            "tags": total_tags,
            "markdownLinks": total_links,
        },
        "cache_dir": str(_INDEX_DIR),
        "flags": _gr_base._load_flags(),
    }


# ─── Utility: set flags ────────────────────────────────────────────────────────


def set_flags(graph_suggestions: bool | None = None, ai_relation_discovery: bool | None = None) -> dict[str, bool]:
    """Set feature flags globally. Returns current flags after update."""
    flags = _gr_base._load_flags()
    if graph_suggestions is not None:
        flags["graphSuggestions"] = graph_suggestions
    if ai_relation_discovery is not None:
        flags["aiRelationDiscovery"] = ai_relation_discovery
    _gr_base._save_flags(flags)
    return flags


def get_flags() -> dict[str, bool]:
    """Return current feature flags."""
    return _gr_base._load_flags()


# ─── Event integration helper ──────────────────────────────────────────────────


def attach_events_to_signals(events: list[dict[str, Any]], max_events: int = 50) -> list[dict[str, Any]]:
    """Tag repo signals with matching events for richer relation evidence.

    Matches events to repos via commandId or actor name patterns.
    Returns the filtered events list.
    """
    all_signals = _load_all_signals()
    if not all_signals or not events:
        return []

    matched: list[dict[str, Any]] = []
    for evt in events[:max_events]:
        cmd_id = evt.get("commandId", evt.get("command_id", ""))
        actor = evt.get("actor", "")
        evt_type = evt.get("type", "")

        # Try to match commandId to repo name patterns
        for rid, sig in all_signals.items():
            repo_name = sig.get("repoName", "").lower()
            if repo_name and (repo_name in cmd_id.lower() or repo_name in actor.lower()):
                matched.append(evt)
                break

    return matched


# ─── CLI / standalone test ─────────────────────────────────────────────────────


def _usage() -> None:
    print("Usage: python server/graph_relations.py <command> [args...]")
    print()
    print("Commands:")
    print("  index <path1> [path2 ...]    Build/refresh index for repo paths")
    print("  candidates <repo_id>         Show candidates for a repo")
    print("  evidence <from_id> <to_id>   Show evidence between two repos")
    print("  score <from_id> <to_id>      Score two repos with all functions")
    print("  stats                        Show network/index statistics")
    print("  flags [on|off]              Set graphSuggestions (default: show)")
    print("  flags-ai [on|off]           Set aiRelationDiscovery (default: show)")


def main() -> None:
    """Minimal CLI for testing and debugging."""
    import sys as _sys

    if len(_sys.argv) < 2:
        _usage()
        return

    cmd = _sys.argv[1]

    if cmd == "index":
        if len(_sys.argv) < 3:
            print("Error: Need at least one repo path")
            return
        result = build_or_refresh_index(_sys.argv[2:])
        print(json.dumps(result, indent=2, ensure_ascii=False))

    elif cmd == "candidates":
        if len(_sys.argv) < 3:
            print("Error: Need repo_id")
            return
        repo_id = _sys.argv[2]
        limit = int(_sys.argv[3]) if len(_sys.argv) > 3 else 10
        candidates = get_candidates(repo_id, limit)
        print(json.dumps(candidates, indent=2, ensure_ascii=False))

    elif cmd == "evidence":
        if len(_sys.argv) < 4:
            print("Error: Need from_id and to_id")
            return
        result = get_relation_evidence(_sys.argv[2], _sys.argv[3])
        print(json.dumps(result, indent=2, ensure_ascii=False))

    elif cmd == "score":
        if len(_sys.argv) < 4:
            print("Error: Need from_id and to_id")
            return
        result = score_pair(_sys.argv[2], _sys.argv[3])
        print(json.dumps(result, indent=2, ensure_ascii=False))

    elif cmd == "stats":
        result = get_network_stats()
        print(json.dumps(result, indent=2, ensure_ascii=False))

    elif cmd == "flags":
        if len(_sys.argv) > 2:
            val = _sys.argv[2].lower() in ("1", "true", "on", "yes")
            set_flags(graph_suggestions=val)
        current = get_flags()
        print(f"graphSuggestions: {current.get('graphSuggestions', True)}")
        print(f"aiRelationDiscovery: {current.get('aiRelationDiscovery', True)}")

    elif cmd == "flags-ai":
        if len(_sys.argv) > 2:
            val = _sys.argv[2].lower() in ("1", "true", "on", "yes")
            set_flags(ai_relation_discovery=val)
        current = get_flags()
        print(f"aiRelationDiscovery: {current.get('aiRelationDiscovery', True)}")

    else:
        print(f"Unknown command: {cmd}")
        _usage()


if __name__ == "__main__":
    main()

