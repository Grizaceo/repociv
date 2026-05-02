"""Tests for server/rebuild_ledger.py.

Verifies the DuckDB Ledger can be reconstructed from a JSONL Event Store and
that the operation is idempotent (replay-safe).
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest

from server import rebuild_ledger as _rl


# ─── Fixtures ────────────────────────────────────────────────────────────────


def _write_events(path: Path, events: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for evt in events:
            f.write(json.dumps(evt) + "\n")


def _terminal_event(
    *, command_id: str, type_: str, actor: str = "WORKER", model: str = "haiku-4-5",
    tokens_in: int = 100, tokens_out: int = 50, cost: float = 0.001,
    duration: float = 1.5, error: str = "",
) -> dict[str, Any]:
    now = time.time()
    return {
        "id": f"evt-{command_id}",
        "commandId": command_id,
        "type": type_,
        "timestamp": now,
        "actor": actor,
        "data": {
            "startedAt": now - duration,
            "finishedAt": now,
            "model": model,
            "tokensIn": tokens_in,
            "tokensOut": tokens_out,
            "costEstimate": cost,
            "error": error,
        },
    }


# ─── Dry-run path (no DuckDB needed) ─────────────────────────────────────────


def test_dry_run_counts_terminal_events(tmp_path: Path):
    events_path = tmp_path / "events.jsonl"
    _write_events(events_path, [
        {"id": "1", "commandId": "c1", "type": "CommandCreated",
         "timestamp": time.time(), "actor": "user", "data": {}},
        _terminal_event(command_id="c1", type_="CommandCompleted"),
        _terminal_event(command_id="c2", type_="CommandFailed", error="boom"),
        _terminal_event(command_id="c3", type_="CommandRejected"),
    ])

    summary = _rl.rebuild(events_path, tmp_path / "state", dry_run=True)

    assert summary["events_total"] == 4
    assert summary["events_terminal"] == 3
    assert summary["by_type"]["CommandCompleted"] == 1
    assert summary["by_type"]["CommandFailed"] == 1
    assert summary["by_type"]["CommandRejected"] == 1


def test_missing_events_file_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        _rl.rebuild(tmp_path / "nope.jsonl", tmp_path / "state", dry_run=True)


def test_skips_malformed_lines(tmp_path: Path):
    events_path = tmp_path / "events.jsonl"
    events_path.write_text(
        '{"id":"a","commandId":"c1","type":"CommandCompleted","timestamp":1,"actor":"WORKER","data":{}}\n'
        "this is not json\n"
        '{"id":"b","commandId":"c2","type":"CommandFailed","timestamp":2,"actor":"WORKER","data":{}}\n',
        encoding="utf-8",
    )
    summary = _rl.rebuild(events_path, tmp_path / "state", dry_run=True)
    assert summary["events_total"] == 2
    assert summary["events_terminal"] == 2


# ─── Full rebuild (requires DuckDB) ──────────────────────────────────────────


pytest.importorskip("duckdb")


def test_rebuild_populates_missions_table(tmp_path: Path):
    events_path = tmp_path / "events.jsonl"
    _write_events(events_path, [
        _terminal_event(command_id="m1", type_="CommandCompleted",
                        tokens_in=200, tokens_out=80, cost=0.002),
        _terminal_event(command_id="m2", type_="CommandFailed", error="oops"),
    ])

    summary = _rl.rebuild(events_path, tmp_path / "state", dry_run=False)

    assert summary["events_terminal"] == 2
    assert summary["events_ingested"] == 2

    # Re-open ledger and verify rows landed.
    from server.research_ledger import ResearchLedger
    ledger = ResearchLedger(state_dir=tmp_path / "state")
    rows = ledger._conn.execute(
        "SELECT id, outcome, prompt_tokens, completion_tokens FROM missions ORDER BY id"
    ).fetchall()
    ledger.close()

    assert len(rows) == 2
    ids = {r[0]: r for r in rows}
    assert ids["m1"][1] == "success"
    assert ids["m1"][2] == 200
    assert ids["m2"][1] == "failed"


def test_rebuild_is_idempotent(tmp_path: Path):
    events_path = tmp_path / "events.jsonl"
    _write_events(events_path, [
        _terminal_event(command_id="m1", type_="CommandCompleted"),
        _terminal_event(command_id="m2", type_="CommandFailed"),
    ])

    s1 = _rl.rebuild(events_path, tmp_path / "state", dry_run=False)
    s2 = _rl.rebuild(events_path, tmp_path / "state", dry_run=False)

    assert s1["events_ingested"] == s2["events_ingested"] == 2

    from server.research_ledger import ResearchLedger
    ledger = ResearchLedger(state_dir=tmp_path / "state")
    count = ledger._conn.execute("SELECT COUNT(*) FROM missions").fetchone()[0]
    ledger.close()
    assert count == 2  # not 4 \u2014 INSERT OR REPLACE deduplicates


# ─── CLI entry point ─────────────────────────────────────────────────────────


def test_cli_dry_run_returns_zero(tmp_path: Path, capsys):
    events_path = tmp_path / "events.jsonl"
    _write_events(events_path, [_terminal_event(command_id="cli1", type_="CommandCompleted")])

    rc = _rl.main([
        "--events-path", str(events_path),
        "--state-dir", str(tmp_path / "state"),
        "--dry-run",
    ])
    assert rc == 0


def test_cli_missing_file_returns_one(tmp_path: Path):
    rc = _rl.main([
        "--events-path", str(tmp_path / "nope.jsonl"),
        "--state-dir", str(tmp_path / "state"),
        "--dry-run",
    ])
    assert rc == 1
