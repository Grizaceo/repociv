"""Tests for the one-shot events.jsonl migration DAVI → MAIN.

The migration runs on event_store.init() and rewrites historical events
that referenced the legacy personal agent name "DAVI" to the generic
"MAIN" slot. The marker file makes the migration idempotent.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from server import event_store


@pytest.fixture
def isolated_event_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Force the event store to a fresh tmp directory and reset module state."""
    monkeypatch.setattr(event_store, "_store_path", None)
    event_store.init(tmp_path)
    yield tmp_path
    # Clean up: remove marker + events so other tests can re-init in the same dir.
    marker = tmp_path / event_store._MIGRATION_MARKER
    if marker.exists():
        marker.unlink()
    events = tmp_path / "events.jsonl"
    if events.exists():
        events.unlink()


def _write_raw_events(path: Path, events: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for e in events:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


def _read_events(path: Path) -> list[dict]:
    out: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            out.append(json.loads(line))
    return out


def test_rewrites_davi_actor_in_top_level_field(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    _write_raw_events(path, [
        {"type": "CommandCreated", "commandId": "c1", "actor": "DAVI", "data": {}},
        {"type": "CommandCreated", "commandId": "c2", "actor": "MAIN", "data": {}},
    ])
    assert event_store._rewrite_event_actor({"actor": "DAVI", "data": {}}) is True
    assert event_store._rewrite_event_actor({"actor": "MAIN", "data": {}}) is False
    assert event_store._rewrite_event_actor({"actor": "WORKER", "data": {}}) is False


def test_rewrites_davi_unit_in_data_dict(tmp_path: Path) -> None:
    changed = event_store._rewrite_event_actor(
        {"actor": "system", "data": {"unit": "DAVI"}}
    )
    assert changed is True


def test_rewrites_davi_unit_at_top_level(tmp_path: Path) -> None:
    changed = event_store._rewrite_event_actor(
        {"actor": "system", "unitId": "DAVI", "data": {}}
    )
    assert changed is True


def test_migrate_skips_when_marker_present(
    isolated_event_store: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # First init wrote the marker. Re-call init to make sure it short-circuits.
    event_store.init(isolated_event_store)
    # No .tmp file should have been left behind.
    tmp = isolated_event_store / "events.jsonl.tmp"
    assert not tmp.exists()


def test_migrate_rewrites_legacy_events(isolated_event_store: Path) -> None:
    path = isolated_event_store / "events.jsonl"
    _write_raw_events(path, [
        {"type": "CommandCreated", "commandId": "c1", "actor": "DAVI", "data": {"unit": "DAVI"}},
        {"type": "CommandCreated", "commandId": "c2", "actor": "MAIN", "data": {}},
        {"type": "AgentOutputChunk", "commandId": "c3", "actor": "DAVI", "data": {}},
    ])
    # Re-run init so the migration actually runs (first init created the marker
    # and bailed). Force a re-migration by removing the marker.
    marker = isolated_event_store / event_store._MIGRATION_MARKER
    marker.unlink()
    event_store.init(isolated_event_store)

    rewritten = _read_events(path)
    actors = [e.get("actor") for e in rewritten]
    assert actors == ["MAIN", "MAIN", "MAIN"]


def test_migrate_is_idempotent(isolated_event_store: Path) -> None:
    path = isolated_event_store / "events.jsonl"
    _write_raw_events(path, [
        {"type": "CommandCreated", "commandId": "c1", "actor": "DAVI", "data": {}},
    ])
    # Force re-migration twice; the second time the marker should skip it.
    marker = isolated_event_store / event_store._MIGRATION_MARKER
    marker.unlink()
    event_store.init(isolated_event_store)
    event_store.init(isolated_event_store)
    rewritten = _read_events(path)
    assert rewritten[0]["actor"] == "MAIN"


def test_migrate_creates_marker_when_no_events(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Don't go through the fixture — set up a fresh state with no events.
    monkeypatch.setattr(event_store, "_store_path", None)
    event_store.init(tmp_path)
    marker = tmp_path / event_store._MIGRATION_MARKER
    assert marker.exists()
    # events.jsonl was not created (nothing to migrate to)
    assert not (tmp_path / "events.jsonl").exists()
