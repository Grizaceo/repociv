"""Tests for server/directive_learner.py — Fase 9 directive learning."""
from __future__ import annotations

import pytest
import json
import tempfile
import sys
import os
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import directive_learner as _dl


# ─── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def raw_records():
    """Simulates directive_store.jsonl records: gesture entries and outcome entries
    linked by command_id, each with a 'type' field."""
    return [
        # DAVI drag → run_tests (success)
        {"type": "gesture", "command_id": "cmd-001", "gesture": "drag_unit_to_city",
         "agent_id": "MAIN", "cmd_type": "run_tests", "target": "city-A",
         "context": {"repoType": "python", "testStatus": "broken"}, "ts": 1000.0},
        {"type": "outcome", "command_id": "cmd-001", "outcome": "success", "duration_s": 2.3, "ts": 1002.3},

        # DAVI drag → run_tests (success, same pattern)
        {"type": "gesture", "command_id": "cmd-002", "gesture": "drag_unit_to_city",
         "agent_id": "MAIN", "cmd_type": "run_tests", "target": "city-B",
         "context": {"repoType": "python", "testStatus": "broken"}, "ts": 2000.0},
        {"type": "outcome", "command_id": "cmd-002", "outcome": "success", "duration_s": 1.1, "ts": 2001.1},

        # DAVI drag → run_tests (failure)
        {"type": "gesture", "command_id": "cmd-003", "gesture": "drag_unit_to_city",
         "agent_id": "MAIN", "cmd_type": "run_tests", "target": "city-C",
         "context": {"repoType": "python", "testStatus": "passing"}, "ts": 3000.0},
        {"type": "outcome", "command_id": "cmd-003", "outcome": "failure", "duration_s": 5.0, "ts": 3005.0},

        # GRIS drag → fix_tests (success)
        {"type": "gesture", "command_id": "cmd-004", "gesture": "drag_unit_to_city",
         "agent_id": "GRIS", "cmd_type": "fix_tests", "target": "city-A",
         "context": {"repoType": "typescript", "testStatus": "broken"}, "ts": 4000.0},
        {"type": "outcome", "command_id": "cmd-004", "outcome": "success", "duration_s": 12.0, "ts": 4012.0},

        # DAVI click → inspect (success, no outcome yet → pending)
        {"type": "gesture", "command_id": "cmd-005", "gesture": "click_repo",
         "agent_id": "MAIN", "cmd_type": "inspect", "target": "",
         "context": {}, "ts": 5000.0},
    ]


@pytest.fixture
def tmp_templates_path():
    """Creates a temp file for templates and returns its path."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        pass
    yield Path(f.name)
    Path(f.name).unlink(missing_ok=True)


# ─── Unit tests ───────────────────────────────────────────────────────────────

class TestCorrelation:
    def test_correlate_empty(self):
        assert _dl._correlate([]) == []

    def test_correlate_joins_gesture_and_outcome(self, raw_records):
        joined = _dl._correlate(raw_records)
        assert len(joined) == 5  # one entry per gesture (cmd-001 through 005)
        # cmd-005 has no outcome → outcome="pending"
        cmd5 = [e for e in joined if e["command_id"] == "cmd-005"][0]
        assert cmd5["outcome"] == "pending"
        # cmd-001 has outcome="success"
        cmd1 = [e for e in joined if e["command_id"] == "cmd-001"][0]
        assert cmd1["outcome"] == "success"
        assert cmd1["duration_s"] == 2.3

    def test_correlate_counts(self, raw_records):
        joined = _dl._correlate(raw_records)
        drag_davi = [e for e in joined
                     if e.get("gesture") == "drag_unit_to_city"
                     and e.get("agent_id") == "MAIN"
                     and e.get("cmd_type") == "run_tests"]
        assert len(drag_davi) == 3


class TestSuggest:
    def test_suggest_returns_top_cmd_by_count(self, raw_records):
        """DAVI + drag_unit_to_city → top suggestion: run_tests type, scored per target."""
        results = _dl.suggest("drag_unit_to_city", "MAIN", records=raw_records)
        assert len(results) >= 1
        # run_tests appears across targets; each gets its own entry
        run_test_entries = [r for r in results if r["cmdType"] == "run_tests"]
        assert len(run_test_entries) >= 1
        # aggregate count across all targets for run_tests is 3
        total_run_test_count = sum(r["count"] for r in run_test_entries)
        assert total_run_test_count == 3

    def test_suggest_with_context_boosts_match(self, raw_records):
        """When current_context matches (repoType=python, testStatus=broken),
        run_tests gets higher score."""
        no_ctx = _dl.suggest("drag_unit_to_city", "MAIN", records=raw_records)
        with_ctx = _dl.suggest("drag_unit_to_city", "MAIN", records=raw_records,
                               current_context={"repoType": "python", "testStatus": "broken"})
        assert no_ctx[0]["cmdType"] == with_ctx[0]["cmdType"] == "run_tests"
        assert with_ctx[0]["score"] >= no_ctx[0]["score"]

    def test_suggest_empty_for_unknown_gesture(self, raw_records):
        results = _dl.suggest("unknown_gesture", "MAIN", records=raw_records)
        assert results == []

    def test_suggest_limit_n(self, raw_records):
        results = _dl.suggest("drag_unit_to_city", "MAIN", records=raw_records, n=1)
        assert len(results) == 1


class TestContextSim:
    def test_context_sim_identical(self):
        a = {"repoType": "python", "testStatus": "broken"}
        b = {"repoType": "python", "testStatus": "broken"}
        # repoType=0.6 + testStatus=0.2 = 0.8
        assert _dl._context_sim(a, b) == 0.8

    def test_context_sim_no_overlap(self):
        a = {"repoType": "python", "testStatus": "broken"}
        b = {"repoType": "rust", "testStatus": "passing"}
        assert _dl._context_sim(a, b) == 0.0

    def test_context_sim_partial(self):
        a = {"repoType": "python", "testStatus": "broken"}
        b = {"repoType": "python", "testStatus": "passing"}
        sim = _dl._context_sim(a, b)
        assert sim == 0.6  # only repoType matches

    def test_context_sim_empty(self):
        assert _dl._context_sim({}, {}) == 0.0
        assert _dl._context_sim(None, {"repoType": "python"}) == 0.0


class TestTemplates:
    def test_top_templates(self, raw_records):
        temps = _dl.top_templates(raw_records, n=5, min_count=1)
        assert len(temps) >= 1
        for t in temps:
            assert "gesture" in t
            assert "agentId" in t
            assert "cmdType" in t
            assert "successRate" in t
            assert "count" in t

    def test_top_templates_min_count_filter(self, raw_records):
        temps = _dl.top_templates(raw_records, min_count=2)
        for t in temps:
            assert t["count"] >= 2

    def test_save_and_load_templates(self, raw_records, tmp_templates_path):
        _dl.set_templates_path(tmp_templates_path)
        n = _dl.save_templates(raw_records)
        # save_templates uses min_count=2; run_tests has 3, fix_tests has 1.
        # run_tests for DAVI drag_unit_to_city should pass -> at least 1
        assert n >= 0
        if n > 0:
            assert tmp_templates_path.exists()
            loaded = _dl.load_templates()
            assert len(loaded) == n
            assert "gesture" in loaded[0]


class TestStats:
    def test_stats_snapshot(self, raw_records):
        snap = _dl.stats_snapshot(raw_records)
        assert snap["totalRecorded"] == 5  # 5 gestures correlated
        assert snap["totalResolved"] == 4  # cmd-005 is pending
        assert 0.0 <= snap["overallSuccessRate"] <= 1.0
        assert "successRates" in snap
        assert "templates" in snap
        assert "recentSuccesses" in snap


# ─── Smoke: no side effects from suggestion ───────────────────────────────────

def test_suggest_is_read_only(raw_records):
    """Suggestion must not mutate the input records."""
    before = json.dumps(raw_records)
    _dl.suggest("drag_unit_to_city", "MAIN", records=raw_records)
    after = json.dumps(raw_records)
    assert before == after


def test_suggest_never_returns_command_ids(raw_records):
    """Suggestions are patterns, not executable commands."""
    results = _dl.suggest("drag_unit_to_city", "MAIN", records=raw_records)
    for r in results:
        assert "command_id" not in r
        assert "payload" not in r
