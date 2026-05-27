#!/usr/bin/env python3
"""RepoCiv — Graph Relations: Incremental Relation Index & Scoring Engine.

Builds a persistent, incremental index of repo signals (imports, dependencies,
entities, tags, events, README links/headings) using mtime-based change
detection. Generates candidate relations between repos using cheap local
heuristics. No LLM calls. No full re-scan on each query.

API:
    build_or_refresh_index(repo_base_paths)
    get_candidates(repo_id, limit)
    get_relation_evidence(from_id, to_id)
    score_pair(from_id, to_id)
    get_network_stats()

Internal functions are split into submodules for maintainability:
    graph_signals.py: signal extraction (_extract_repo_signals, _has_repo_changed, etc.)
    graph_index.py: index persistence (_load_meta, _save_meta, _check_coactivity, etc.)
    graph_scoring.py: scoring & candidates (_score_jaccard, _generate_candidates_for, etc.)

This module re-exports everything for backward compatibility.
"""

from __future__ import annotations

# ── Imports from submodules (work both as server.graph_relations and direct import) ──

try:
    # When imported as server.graph_relations (via package)
    from server.graph_relations_base import *  # noqa: F401,F403
    from server.graph_relations_base import (  # noqa: F401
        _DEFAULT_FLAGS,
        _INDEX_DIR,
        _REPO_SIGNALS_DIR,
        _RELATION_CACHE_DIR,
        _META_FILE,
        _FLAGS_FILE,
        _MAX_EVENTS,
        _MAX_RANDOM_WALK_STEPS,
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
    from server.graph_signals import (  # noqa: F402
        _extract_imports,
        _extract_markdown_links,
        _extract_markdown_headings,
        _extract_package_deps,
        _extract_entities,
        _extract_tags_from_agent_files,
        _get_file_mtimes,
        _extract_repo_signals,
        _has_repo_changed,
        _load_recent_events,
        _repo_id_from_path,
        _slugify,
        _tokenize,
        _read_file_safe,
        _jaccard,
    )
    from server.graph_index import (  # noqa: F402
        _save_repo_signals,
        _load_repo_signals,
        _load_all_signals,
        _save_relation_cache,
        _load_relation_cache,
        _get_git_committers,
        _check_coactivity,
        _load_flags,
        _save_flags,
        _load_meta,
        _save_meta,
    )
    from server.graph_scoring import (  # noqa: F402
        _score_jaccard,
        _adamic_adar,
        _resource_allocation,
        _build_neighbor_graph,
        _build_item_graph,
        _personalized_pagerank,
        _random_walk_similarity,
        _generate_candidates_for,
        build_or_refresh_index,
        get_candidates,
        get_relation_evidence,
        score_pair,
        get_network_stats,
        set_flags,
        get_flags,
        attach_events_to_signals,
    )
except ImportError:
    # When imported directly as graph_relations (tests add server/ to sys.path)
    from graph_relations_base import *  # noqa: F401,F403
    from graph_relations_base import (  # noqa: F401
        _DEFAULT_FLAGS,
        _INDEX_DIR,
        _REPO_SIGNALS_DIR,
        _RELATION_CACHE_DIR,
        _META_FILE,
        _FLAGS_FILE,
        _MAX_EVENTS,
        _MAX_RANDOM_WALK_STEPS,
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
    from graph_signals import (  # noqa: F402
        _extract_imports,
        _extract_markdown_links,
        _extract_markdown_headings,
        _extract_package_deps,
        _extract_entities,
        _extract_tags_from_agent_files,
        _get_file_mtimes,
        _extract_repo_signals,
        _has_repo_changed,
        _load_recent_events,
        _repo_id_from_path,
        _slugify,
        _tokenize,
        _read_file_safe,
        _jaccard,
    )
    from graph_index import (  # noqa: F402
        _save_repo_signals,
        _load_repo_signals,
        _load_all_signals,
        _save_relation_cache,
        _load_relation_cache,
        _get_git_committers,
        _check_coactivity,
        _load_flags,
        _save_flags,
        _load_meta,
        _save_meta,
    )
    from graph_scoring import (  # noqa: F402
        _score_jaccard,
        _adamic_adar,
        _resource_allocation,
        _build_neighbor_graph,
        _build_item_graph,
        _personalized_pagerank,
        _random_walk_similarity,
        _generate_candidates_for,
        build_or_refresh_index,
        get_candidates,
        get_relation_evidence,
        score_pair,
        get_network_stats,
        set_flags,
        get_flags,
        attach_events_to_signals,
    )

__all__ = [
    # Public API
    "build_or_refresh_index",
    "get_candidates",
    "get_network_stats",
    "get_relation_evidence",
    "score_pair",
    "set_flags",
    "get_flags",
    "attach_events_to_signals",
    # Internal (used by tests and city_graph_adapter)
    "_extract_repo_signals",
    "_has_repo_changed",
    "_load_recent_events",
    "_load_all_signals",
    "_load_flags",
    "_save_flags",
    "_load_meta",
    "_save_meta",
    "_save_repo_signals",
    "_load_repo_signals",
    "_save_relation_cache",
    "_load_relation_cache",
    "_get_git_committers",
    "_check_coactivity",
    "_score_jaccard",
    "_generate_candidates_for",
]
