"""Tests for the DORMANT Agentic OS event-bus adapter (fail-open).

Covers:
  - bus_status: fail-open when root/schema missing; healthy snapshot when
    a fake bus tree exists (schema + inbox + archive).
  - poll_bus: since-filtered, newest-first, limited, fail-open.
  - to_repociv_event: schema translation + fallback for malformed input.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from server import agentic_os_bus
from server.agentic_os_bus import adapter, client


@pytest.fixture
def fake_bus(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point the client at a fake bus tree under tmp_path."""
    monkeypatch.setattr(client, "AGENTIC_OS_ROOT", tmp_path)
    monkeypatch.setattr(client, "_SCHEMA_PATH", tmp_path / "EVENT_SCHEMA.json")
    monkeypatch.setattr(client, "_INBOX", tmp_path / "events" / "inbox")
    (tmp_path / "events" / "inbox").mkdir(parents=True)
    (tmp_path / "events" / "archive").mkdir(parents=True)
    return tmp_path


def _write_schema(root: Path) -> None:
    (root / "EVENT_SCHEMA.json").write_text(
        json.dumps(
            {"title": "Agentic OS Event v1", "$id": "agentic-os://schemas/event.v1.json"}
        ),
        encoding="utf-8",
    )


def _write_archive(root: Path, events: list[dict]) -> None:
    with (root / "events" / "archive" / "test.jsonl").open("w", encoding="utf-8") as f:
        for e in events:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


# ── bus_status ────────────────────────────────────────────────────────────────


def test_bus_status_missing_root(fake_bus: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(client, "AGENTIC_OS_ROOT", tmp_path / "nope")
    status = client.bus_status()
    assert status.available is False
    assert "missing" in status.reason


def test_bus_status_missing_schema(fake_bus: Path):
    status = client.bus_status()
    assert status.available is False
    assert status.schema_present is False


def test_bus_status_healthy(fake_bus: Path):
    _write_schema(fake_bus)
    _write_archive(
        fake_bus,
        [
            {"id": "evt_1", "timestamp": 100.0, "type": "task.completed"},
            {"id": "evt_2", "timestamp": 200.0, "type": "task.completed"},
        ],
    )
    (fake_bus / "events" / "inbox" / "i1.jsonl").write_text("x\n")
    (fake_bus / "events" / "inbox" / "i2.jsonl").write_text("x\n")

    status = client.bus_status()
    assert status.available is True
    assert status.schema_present is True
    assert status.schema_version == "Agentic OS Event v1"
    assert status.inbox_count == 2
    assert status.archive_count == 2
    assert status.last_event_id == "evt_2"
    assert status.last_event_ts == 200.0


# ── poll_bus ──────────────────────────────────────────────────────────────────


def test_poll_bus_since_newest_first_limited(fake_bus: Path):
    _write_archive(
        fake_bus,
        [
            {"id": "e1", "timestamp": 100.0, "type": "a"},
            {"id": "e2", "timestamp": 200.0, "type": "b"},
            {"id": "e3", "timestamp": 300.0, "type": "c"},
        ],
    )
    got = client.poll_bus(since_ts=150.0, limit=2)
    assert [e["id"] for e in got] == ["e3", "e2"]


def test_poll_bus_missing_dir_fail_open(fake_bus: Path):
    assert client.poll_bus() == []


def test_poll_bus_skips_malformed_lines(fake_bus: Path):
    with (fake_bus / "events" / "archive" / "a.jsonl").open("w", encoding="utf-8") as f:
        f.write("not json\n")
        f.write(json.dumps({"id": "ok", "timestamp": 1.0, "type": "x"}) + "\n")
    got = client.poll_bus(since_ts=0.0)
    assert [e["id"] for e in got] == ["ok"]


# ── adapter ───────────────────────────────────────────────────────────────────


def test_adapter_maps_bus_event():
    bus_evt = {
        "id": "evt_20260916_1",
        "timestamp": "2026-09-16T00:22:30Z",
        "source": "hermes",
        "type": "task.completed",
        "severity": "info",
        "payload": {"task_id": "t1"},
        "provenance": {"session_id": "s1"},
    }
    mapped = adapter.to_repociv_event(bus_evt)
    assert mapped["type"] == "AgenticOsEvent"  # bus type not in store set
    assert mapped["actor"] == "OS"
    assert mapped["data"]["busEventId"] == "evt_20260916_1"
    assert mapped["data"]["source"] == "hermes"
    assert mapped["data"]["payload"] == {"task_id": "t1"}
    assert mapped["ts"] > 0


def test_adapter_passthrough_known_type():
    bus_evt = {"id": "e9", "timestamp": 5.0, "type": "CommandStarted", "severity": "info"}
    mapped = adapter.to_repociv_event(bus_evt)
    assert mapped["type"] == "CommandStarted"


def test_adapter_fail_open_malformed():
    mapped = adapter.to_repociv_event(None)
    assert mapped["type"] in {"AgenticOsEvent"}
    assert mapped["severity"] == "warn"


def test_package_imports():
    assert agentic_os_bus.poll_bus is client.poll_bus
    assert agentic_os_bus.bus_status is client.bus_status
    assert agentic_os_bus.to_repociv_event is adapter.to_repociv_event


def test_bus_status_missing_root_placeholder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Fail-open when the bus root does not exist."""
    monkeypatch.setattr(client, "AGENTIC_OS_ROOT", tmp_path / "nope")
    monkeypatch.setattr(client, "_SCHEMA_PATH", tmp_path / "nope" / "EVENT_SCHEMA.json")
    monkeypatch.setattr(client, "_INBOX", tmp_path / "nope" / "events" / "inbox")
    status = client.bus_status()
    assert status.available is False
    assert "missing" in status.reason


# ── parse_timestamp (ISO-8601 bus schema) ─────────────────────────────────────


def test_parse_timestamp_iso8601():
    ts = client.parse_timestamp("2026-09-16T00:22:30Z")
    assert ts > 0


def test_parse_timestamp_epoch_and_invalid():
    assert client.parse_timestamp(1700000000) == 1700000000.0
    assert client.parse_timestamp("garbage") == 0.0
    assert client.parse_timestamp(None) == 0.0


def test_bus_status_last_event_with_iso_timestamps(fake_bus: Path):
    _write_schema(fake_bus)
    _write_archive(
        fake_bus,
        [
            {"id": "old", "timestamp": "2026-09-15T10:00:00Z", "type": "a"},
            {"id": "new", "timestamp": "2026-09-16T00:22:30Z", "type": "b"},
        ],
    )
    status = client.bus_status()
    assert status.available is True
    assert status.last_event_id == "new"
    assert status.last_event_ts > 0


def test_poll_bus_iso_timestamps(fake_bus: Path):
    _write_archive(
        fake_bus,
        [
            {"id": "e1", "timestamp": "2026-09-15T10:00:00Z", "type": "a"},
            {"id": "e2", "timestamp": "2026-09-16T00:22:30Z", "type": "b"},
        ],
    )
    got = client.poll_bus(since_ts=0.0)
    assert [e["id"] for e in got] == ["e2", "e1"]
