#!/usr/bin/env python3
"""RepoCiv — Graph Relations: Public API Facade.

Re-exports public API + internal functions needed by tests/city_graph_adapter.
Submodule details:
    graph_relations_base.py: shared constants, _load_flags, _save_flags
    graph_signals.py: signal extraction (_extract_repo_signals, _has_repo_changed)
    graph_index.py: index persistence (_load_meta, _save_meta)
    graph_scoring.py: scoring, candidates, main public API

Backward compatible — existing imports of server.graph_relations work unchanged.
"""

from __future__ import annotations

# ── Re-export from submodules (dual import style: server.X and direct X) ──────

try:
    # Package import: server.graph_relations
    from server.graph_relations_base import *  # noqa: F401,F403
    from server.graph_relations_base import (  # noqa: F401
        _DEFAULT_FLAGS, _INDEX_DIR, _REPO_SIGNALS_DIR, _RELATION_CACHE_DIR,
        _META_FILE, _FLAGS_FILE, _MAX_EVENTS, _MAX_RANDOM_WALK_STEPS,
        _RUNTIME_FLAGS, _SUGGESTED_ACTIONS, _RELATION_TYPES,
        _IMPORT_PATTERNS, _MARKDOWN_LINK_RE, _MARKDOWN_HEADING_RE,
        _ENTITY_PATTERNS, _MANIFEST_PARSERS, _lock,
        _load_flags, _save_flags,
    )
    from server.graph_signals import (
        _extract_repo_signals, _has_repo_changed, _load_recent_events,
        _get_file_mtimes, _repo_id_from_path, _jaccard,
        _extract_package_deps, _extract_imports,
    )
    from server.graph_index import (
        _load_all_signals, _load_meta, _save_meta,
        _save_repo_signals, _load_repo_signals,
        _save_relation_cache, _load_relation_cache,
        _get_git_committers, _check_coactivity,
    )
    from server.graph_scoring import (
        build_or_refresh_index, get_candidates, get_relation_evidence,
        score_pair, get_network_stats, set_flags, get_flags,
        attach_events_to_signals, _score_jaccard, _generate_candidates_for,
    )
except ImportError:
    from graph_relations_base import *  # noqa: F401,F403
    from graph_relations_base import (  # noqa: F401
        _DEFAULT_FLAGS, _INDEX_DIR, _REPO_SIGNALS_DIR, _RELATION_CACHE_DIR,
        _META_FILE, _FLAGS_FILE, _MAX_EVENTS, _MAX_RANDOM_WALK_STEPS,
        _RUNTIME_FLAGS, _SUGGESTED_ACTIONS, _RELATION_TYPES,
        _IMPORT_PATTERNS, _MARKDOWN_LINK_RE, _MARKDOWN_HEADING_RE,
        _ENTITY_PATTERNS, _MANIFEST_PARSERS, _lock,
        _load_flags, _save_flags,
    )
    from graph_signals import (
        _extract_repo_signals, _has_repo_changed, _load_recent_events,
        _get_file_mtimes, _repo_id_from_path, _jaccard,
        _extract_package_deps, _extract_imports,
    )
    from graph_index import (
        _load_all_signals, _load_meta, _save_meta,
        _save_repo_signals, _load_repo_signals,
        _save_relation_cache, _load_relation_cache,
        _get_git_committers, _check_coactivity,
    )
    from graph_scoring import (
        build_or_refresh_index, get_candidates, get_relation_evidence,
        score_pair, get_network_stats, set_flags, get_flags,
        attach_events_to_signals, _score_jaccard, _generate_candidates_for,
    )

__all__ = [
    # Public API
    "build_or_refresh_index", "get_candidates", "get_network_stats",
    "get_relation_evidence", "score_pair",
    "set_flags", "get_flags", "attach_events_to_signals",
    # Internal (used by tests and city_graph_adapter)
    "_extract_repo_signals", "_has_repo_changed", "_load_recent_events",
    "_load_all_signals", "_load_flags", "_save_flags",
    "_load_meta", "_save_meta",
    "_save_repo_signals", "_load_repo_signals",
    "_save_relation_cache", "_load_relation_cache",
    "_get_git_committers", "_check_coactivity",
    "_score_jaccard", "_generate_candidates_for",
]
