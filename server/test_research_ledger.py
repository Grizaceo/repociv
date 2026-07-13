"""Tests for server/research_ledger.py (Fase 0)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("duckdb", reason="duckdb not installed — skipping ResearchLedger tests")

from server.research_ledger import ResearchLedger  # noqa: E402


@pytest.fixture()
def ledger(tmp_path: Path) -> ResearchLedger:
    """Fresh ledger backed by a temp directory."""
    return ResearchLedger(state_dir=tmp_path)


# ── Availability ──────────────────────────────────────────────────────────────

def test_ledger_is_available(ledger: ResearchLedger) -> None:
    assert ledger.available is True


# ── record_cycle (missions table) ────────────────────────────────────────────

def test_record_cycle_stores_mission(ledger: ResearchLedger) -> None:
    ledger.record_cycle(
        mission_id="abc123",
        repo="repociv",
        agent="WORKER",
        model="claude-sonnet-4-5",
        outcome="success",
        prompt_tokens=1200,
        completion_tokens=450,
        cost_estimate=0.00185,
        duration_s=12.3,
    )
    rows = ledger.get_mission_stats(limit=10)
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == "abc123"
    assert row["agent"] == "WORKER"
    assert row["outcome"] == "success"
    assert row["prompt_tokens"] == 1200
    assert row["completion_tokens"] == 450


def test_mission_tree_is_json_serializable(ledger: ResearchLedger) -> None:
    ledger.record_cycle(
        mission_id="json-tree",
        repo="/selected/repo",
        agent="WORKER",
        outcome="success",
    )

    tree = ledger.get_mission_tree("json-tree")

    assert tree["mission"]["repo"] == "/selected/repo"
    assert isinstance(tree["mission"]["created_at"], str)
    assert json.loads(json.dumps(tree))["mission"]["outcome"] == "success"


def test_record_cycle_survives_restart(tmp_path: Path) -> None:
    l1 = ResearchLedger(state_dir=tmp_path)
    l1.record_cycle(mission_id="persist1", outcome="success")
    l1.close()

    l2 = ResearchLedger(state_dir=tmp_path)
    rows = l2.get_mission_stats(limit=10)
    ids = [r["id"] for r in rows]
    assert "persist1" in ids


def test_record_cycle_upserts_on_duplicate_id(ledger: ResearchLedger) -> None:
    ledger.record_cycle(mission_id="dup", outcome="success")
    ledger.record_cycle(mission_id="dup", outcome="failed")  # replace
    rows = ledger.get_mission_stats(limit=10)
    assert len(rows) == 1
    assert rows[0]["outcome"] == "failed"


# ── ingest_event (dual-write) ─────────────────────────────────────────────────

def test_ingest_event_completed(ledger: ResearchLedger) -> None:
    event = {
        "id": "evt1",
        "commandId": "cmd1",
        "type": "CommandCompleted",
        "timestamp": 1746100000.0,
        "actor": "WORKER-1",
        "data": {
            "repoPath": "/workspace/repo-a",
            "unitId": "WORKER",
            "commandType": "execute_agent",
            "model": "claude-haiku-3-5",
            "tokensIn": 800,
            "tokensOut": 200,
            "costEstimate": 0.00045,
            "startedAt": 1746100000.0,
            "finishedAt": 1746100010.0,
            "durationS": 10.0,
            "result": "Done.",
        },
    }
    ledger.ingest_event(event)
    rows = ledger.get_mission_stats(limit=5)
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == "cmd1"
    assert row["outcome"] == "success"
    assert row["repo"] == "/workspace/repo-a"
    assert row["agent"] == "WORKER"
    assert row["phase"] == "execute_agent"
    assert row["duration_s"] == pytest.approx(10.0)
    assert row["prompt_tokens"] == 800


def test_ingest_event_failed(ledger: ResearchLedger) -> None:
    event = {
        "commandId": "cmd2",
        "type": "CommandFailed",
        "timestamp": 1746100050.0,
        "actor": "SCOUT-1",
        "data": {"error": "timeout", "finishedAt": 1746100055.0},
    }
    ledger.ingest_event(event)
    rows = ledger.get_mission_stats(limit=5)
    assert rows[0]["outcome"] == "failed"


def test_ingest_event_rejected(ledger: ResearchLedger) -> None:
    event = {
        "commandId": "cmd3",
        "type": "CommandRejected",
        "timestamp": 1746100060.0,
        "actor": "system",
        "data": {"reason": "policy blocked"},
    }
    ledger.ingest_event(event)
    rows = ledger.get_mission_stats(limit=5)
    assert rows[0]["outcome"] == "rejected"


def test_ingest_event_ignores_non_terminal(ledger: ResearchLedger) -> None:
    event = {
        "commandId": "cmd4",
        "type": "CommandStarted",
        "timestamp": 1746100000.0,
        "actor": "system",
        "data": {},
    }
    ledger.ingest_event(event)
    assert ledger.get_mission_stats() == []


# ── get_mission_stats ─────────────────────────────────────────────────────────

def test_get_mission_stats_respects_limit(ledger: ResearchLedger) -> None:
    for i in range(10):
        ledger.record_cycle(mission_id=f"m{i}", outcome="success")
    rows = ledger.get_mission_stats(limit=3)
    assert len(rows) == 3


def test_get_mission_stats_returns_newest_first(ledger: ResearchLedger) -> None:
    import time
    for i in range(3):
        ledger.record_cycle(mission_id=f"seq{i}", outcome="success")
        time.sleep(0.01)
    rows = ledger.get_mission_stats(limit=3)
    ids = [r["id"] for r in rows]
    assert ids[0] == "seq2"  # newest first
