import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import graph_relations as gr
import http_routes as routes


def _sample_signals(tmp_path: Path) -> dict[str, dict]:
    repo_a = tmp_path / 'repo-a'
    repo_b = tmp_path / 'repo-b'
    repo_a.mkdir()
    repo_b.mkdir()
    return {
        'repo_a': {
            'repoName': 'repo-a',
            'repoPath': str(repo_a),
            'imports': ['alpha'],
            'dependencies': ['shared-lib'],
            'entities': ['python'],
            'tags': ['graph'],
            'topDirs': ['src'],
            'markdownLinks': [],
            'markdownHeadings': [],
        },
        'repo_b': {
            'repoName': 'repo-b',
            'repoPath': str(repo_b),
            'imports': ['beta'],
            'dependencies': ['shared-lib'],
            'entities': ['python'],
            'tags': ['graph'],
            'topDirs': ['src'],
            'markdownLinks': [],
            'markdownHeadings': [],
        },
    }


def test_load_flags_default_to_opt_in_off(tmp_path: Path, monkeypatch):
    flags_file = tmp_path / 'flags.json'
    flags_file.write_text('{"graphSuggestions": true, "aiRelationDiscovery": true}', encoding='utf-8')
    monkeypatch.setattr(gr, '_FLAGS_FILE', flags_file)
    monkeypatch.setattr(gr, '_RUNTIME_FLAGS', dict(gr._DEFAULT_FLAGS))
    monkeypatch.delenv('REPOCIV_GRAPH_SUGGESTIONS', raising=False)
    monkeypatch.delenv('REPOCIV_AI_RELATION_DISCOVERY', raising=False)

    flags = gr._load_flags()

    assert flags == {
        'graphSuggestions': False,
        'aiRelationDiscovery': False,
    }



def test_get_candidates_returns_empty_when_graph_suggestions_disabled(tmp_path: Path, monkeypatch):
    signals = _sample_signals(tmp_path)
    monkeypatch.setattr(gr, '_load_all_signals', lambda: signals)
    monkeypatch.setattr(
        gr,
        '_load_flags',
        lambda: {'graphSuggestions': False, 'aiRelationDiscovery': False},
    )

    candidates = gr.get_candidates('repo_a', limit=10)

    assert candidates == []



def test_score_pair_skips_advanced_scoring_when_ai_relation_discovery_disabled(tmp_path: Path, monkeypatch):
    signals = _sample_signals(tmp_path)
    # Patch all mutable state in graph_scoring directly (score_pair accesses them via module-level imports)
    try:
        import server.graph_scoring as _gs
    except ImportError:
        import graph_scoring as _gs
    monkeypatch.setattr(_gs, '_load_all_signals', lambda: signals)
    monkeypatch.setattr(_gs, '_personalized_pagerank', lambda *a, **kw: 0.0)
    monkeypatch.setattr(_gs, '_random_walk_similarity', lambda *a, **kw: 0.0)
    monkeypatch.setattr(_gs, '_check_coactivity', lambda *a, **kw: {})
    # _load_flags is accessed via _gr_base reference (patched at module level)
    monkeypatch.setattr(
        _gs._gr_base,
        '_load_flags',
        lambda: {'graphSuggestions': True, 'aiRelationDiscovery': False},
    )

    score = gr.score_pair('repo_a', 'repo_b')

    assert score['aiRelationDiscovery_enabled'] is False
    assert score['personalized_pagerank'] == 0.0
    assert score['random_walk'] == 0.0
    assert score['coactivity'] == 0.0



def test_post_graph_relations_flags_updates_backend_flags(monkeypatch):
    seen: dict[str, object] = {}

    def fake_set_flags(graph_suggestions=None, ai_relation_discovery=None):
        seen['graphSuggestions'] = graph_suggestions
        seen['aiRelationDiscovery'] = ai_relation_discovery
        return {
            'graphSuggestions': bool(graph_suggestions),
            'aiRelationDiscovery': bool(ai_relation_discovery),
        }

    monkeypatch.setattr(routes._gr, 'set_flags', fake_set_flags)

    status, body = routes.post_graph_relations_flags(
        {'graphSuggestions': False, 'aiRelationDiscovery': False},
        {},
    )

    assert status == 200
    assert body == {
        'ok': True,
        'flags': {'graphSuggestions': False, 'aiRelationDiscovery': False},
    }
    assert seen == {'graphSuggestions': False, 'aiRelationDiscovery': False}



def test_post_graph_relations_refresh_uses_post_body(monkeypatch):
    seen: dict[str, object] = {}

    def fake_build_from_cities(cities):
        seen['cities'] = cities
        return {'ok': True, 'source': 'cities'}

    monkeypatch.setattr(routes._cga, 'build_repo_index_from_cities', fake_build_from_cities)

    status, body = routes.post_graph_relations_refresh(
        {'cities': [{'id': 'repo_a', 'name': 'Repo A', 'repoPath': '/tmp/repo-a'}]},
        {},
    )

    assert status == 200
    assert body == {'ok': True, 'source': 'cities'}
    assert seen['cities'] == [{'id': 'repo_a', 'name': 'Repo A', 'repoPath': '/tmp/repo-a'}]
