"""H2/H5: terminal events carry attribution; each command starts once."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

import server.event_store as _es
from server.research_ledger import ResearchLedger


@pytest.fixture
def store(tmp_path: Path, monkeypatch):
    _es.init(tmp_path)
    ingested: list[dict] = []
    monkeypatch.setattr(_es, "_ledger_ingest", ingested.append)
    return tmp_path / "events.jsonl", ingested


def _events(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_completed_event_carries_agent_model_start_and_tokens(store):
    path, ingested = store
    started = time.time() - 12.5
    _es.record_completed("cmd-h2", "ok", agent="WORKER", model="gpt-4o",
                         started_at=started, tokens_in=1200, tokens_out=300)
    (evt,) = ingested
    assert evt["actor"] == "system"  # the bridge still emits terminal events
    assert evt["data"]["agentId"] == "WORKER"
    assert evt["data"]["model"] == "gpt-4o"
    assert evt["data"]["startedAt"] == pytest.approx(started)
    assert (evt["data"]["tokensIn"], evt["data"]["tokensOut"]) == (1200, 300)
    assert _events(path)[-1]["data"] == evt["data"]


def test_ledger_row_is_attributed_instead_of_system(store, tmp_path):
    _path, ingested = store
    _es.record_failed("cmd-h2f", "boom", agent="SCOUT", model="m1",
                      started_at=time.time() - 3, tokens_in=10, tokens_out=2)
    _es.record_completed("cmd-legacy", "ok")  # legacy shape: no attribution
    ledger = ResearchLedger(state_dir=tmp_path / "ledger")
    if not ledger.available:
        pytest.skip("duckdb not installed")
    for evt in ingested:
        ledger.ingest_event(evt)
    rows = {r["id"]: r for r in ledger.get_mission_stats()}
    assert rows["cmd-h2f"]["agent"] == "SCOUT"
    assert rows["cmd-h2f"]["model"] == "m1"
    assert rows["cmd-h2f"]["duration_s"] >= 2.5
    assert (rows["cmd-h2f"]["prompt_tokens"], rows["cmd-h2f"]["completion_tokens"]) == (10, 2)
    assert rows["cmd-legacy"]["agent"] == "SYSTEM"  # unchanged for old events


def test_command_started_is_recorded_once_per_command(store):
    path, _ingested = store
    _es.record_started("cmd-h5")   # scheduler dispatch
    _es.record_started("cmd-h5")   # run_agent execution
    _es.record_started("cmd-other")
    starts = [e["commandId"] for e in _events(path) if e["type"] == "CommandStarted"]
    assert starts == ["cmd-h5", "cmd-other"]
