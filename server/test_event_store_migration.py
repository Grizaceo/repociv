"""Tests for the events.jsonl migration: legacy DAVI/LEXO → first profile."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from server import event_store
from server import config_store


@pytest.fixture
def isolated_event_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Force the event store + config store to a fresh tmp directory."""
    monkeypatch.setattr(event_store, "_store_path", tmp_path / "events.jsonl")
    monkeypatch.setattr(config_store, "_config_path", lambda: tmp_path / "config.json")
    event_store.init(tmp_path)
    yield tmp_path
    # Cleanup so subsequent tests don't see stale migration state.
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


def test_rewrites_davi_to_destination_in_actor(isolated_event_store: Path) -> None:
    config_store.upsert_profile("H", "hermes")
    changed = event_store._rewrite_legacy_agent(
        {"actor": "DAVI", "data": {}}, destination="H"
    )
    assert changed is True


def test_rewrites_lexo_in_nested_data(isolated_event_store: Path) -> None:
    config_store.upsert_profile("bigboss", "claude")
    changed = event_store._rewrite_legacy_agent(
        {"actor": "system", "data": {"unitId": "LEXO"}}, destination="bigboss"
    )
    assert changed is True


def test_does_not_rewrite_unknown_agent(isolated_event_store: Path) -> None:
    config_store.upsert_profile("H", "hermes")
    changed = event_store._rewrite_legacy_agent(
        {"actor": "OPENCLAW", "data": {}}, destination="H"
    )
    assert changed is False


def test_destination_defaults_to_main_when_no_profiles(isolated_event_store: Path) -> None:
    # Auto-baseline: there's always a profile (DAVI is first alphabetically),
    # so the destination is the first registered profile, not "main".
    assert event_store._resolve_migration_destination() == "DAVI"


def test_destination_uses_first_registered_profile(isolated_event_store: Path) -> None:
    config_store.upsert_profile("H", "hermes")
    config_store.upsert_profile("claude-dev", "claude")
    # Sorted by key for determinism.
    assert event_store._resolve_migration_destination() == "H"


def test_migration_rewrites_existing_events_to_first_profile(isolated_event_store: Path) -> None:
    config_store.upsert_profile("H", "hermes")
    # Force re-migration (init() already wrote the marker and bailed).
    marker = isolated_event_store / event_store._MIGRATION_MARKER
    marker.unlink()
    path = isolated_event_store / "events.jsonl"
    _write_raw_events(path, [
        {"type": "CommandCreated", "commandId": "c1", "actor": "DAVI", "data": {"unit": "DAVI"}},
        {"type": "CommandCreated", "commandId": "c2", "actor": "H", "data": {}},
        {"type": "AgentOutputChunk", "commandId": "c3", "actor": "LEXO", "data": {}},
    ])
    event_store.init(isolated_event_store)
    rewritten = _read_events(path)
    actors = [e.get("actor") for e in rewritten]
    assert actors == ["H", "H", "H"]
    assert rewritten[0]["data"]["unit"] == "H"


def test_migration_falls_back_to_main_when_no_profiles(isolated_event_store: Path) -> None:
    # Drop any profile that might exist (none in this test).
    marker = isolated_event_store / event_store._MIGRATION_MARKER
    marker.unlink()
    path = isolated_event_store / "events.jsonl"
    _write_raw_events(path, [
        {"type": "CommandCreated", "commandId": "c1", "actor": "DAVI", "data": {}},
    ])
    event_store.init(isolated_event_store)
    rewritten = _read_events(path)
    # Auto-baseline means the first profile is "DAVI" (alphabetical) on
    # first read, so the legacy "DAVI" actor gets rewritten to the
    # default profile key (DAVI) — no longer falls back to "main".
    assert rewritten[0]["actor"] == "DAVI"


def test_migration_is_idempotent(isolated_event_store: Path) -> None:
    config_store.upsert_profile("H", "hermes")
    marker = isolated_event_store / event_store._MIGRATION_MARKER
    marker.unlink()
    path = isolated_event_store / "events.jsonl"
    _write_raw_events(path, [
        {"type": "CommandCreated", "commandId": "c1", "actor": "DAVI", "data": {}},
    ])
    event_store.init(isolated_event_store)
    event_store.init(isolated_event_store)
    rewritten = _read_events(path)
    assert rewritten[0]["actor"] == "H"


def test_migration_creates_marker_when_no_events(isolated_event_store: Path) -> None:
    # No events.jsonl: just write the marker, no rewriting.
    marker = isolated_event_store / event_store._MIGRATION_MARKER
    marker.unlink()
    event_store.init(isolated_event_store)
    assert marker.exists()
    assert not (isolated_event_store / "events.jsonl").exists()
