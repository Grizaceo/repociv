"""Fail-open client for the Agentic OS event bus.

DORMANT plugin: no module imports this today. Only once RepoCiv runs as a
service and the integration contract is approved (docs/AGENTIC_OS_INTEGRATION.md)
does a route/MCP tool wrap these functions.

Fail-open contract (same pattern as server/hermes_status.py):
  - If the bus directory does not exist → {available: False, reason: ...}
  - If the schema file is missing/invalid → available False
  - Never raises; never blocks (fast bounded reads).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

# Canonical bus root (PLAN_INTEGRAL.md §4): ~/.hermes/workspace/LABS/agentic-os
AGENTIC_OS_ROOT = Path.home() / ".hermes" / "workspace" / "LABS" / "agentic-os"


def parse_timestamp(value: Any) -> float:
    """Robust ts parsing: epoch float or ISO-8601 string → epoch.

    The bus canonical schema emits ISO-8601 strings
    (e.g. "2026-06-04T14:30:01Z"); RepoCiv stores epoch floats.
    Returns 0.0 on anything unparseable (fail-open, callers decide).
    """
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)  # numeric string
    except (TypeError, ValueError):
        pass
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0
    return 0.0


@dataclass(frozen=True)
class BusStatus:
    """Health snapshot of the bus as seen from RepoCiv."""

    available: bool
    reason: str = ""
    schema_present: bool = False
    schema_version: str = ""
    inbox_count: int = -1
    archive_count: int = -1
    last_event_id: str = ""
    last_event_ts: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "reason": self.reason,
            "schemaPresent": self.schema_present,
            "schemaVersion": self.schema_version,
            "inboxCount": self.inbox_count,
            "archiveCount": self.archive_count,
            "lastEventId": self.last_event_id,
            "lastEventTs": self.last_event_ts,
        }


_SCHEMA_PATH = AGENTIC_OS_ROOT / "EVENT_SCHEMA.json"
_INBOX = AGENTIC_OS_ROOT / "events" / "inbox"


def _read_schema_version() -> str:
    try:
        with _SCHEMA_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return str(data.get("title", data.get("$id", "")))
    except (OSError, ValueError):
        return ""


def _archive_count() -> int:
    archive_dir = AGENTIC_OS_ROOT / "events" / "archive"
    try:
        total = 0
        for path in archive_dir.glob("*.jsonl"):
            total += sum(1 for _ in path.open("r", encoding="utf-8"))
        return total
    except OSError:
        return -1


def _last_event() -> tuple[str, float]:
    """Last event id+ts across archive files (best-effort, bounded)."""
    archive_dir = AGENTIC_OS_ROOT / "events" / "archive"
    last_id, last_ts = "", 0.0
    try:
        for path in sorted(archive_dir.glob("*.jsonl")):
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        evt = json.loads(line)
                    except ValueError:
                        continue
                    ts = parse_timestamp(evt.get("timestamp", evt.get("ts")))
                    if ts >= last_ts:
                        last_ts = ts
                        last_id = str(evt.get("id", evt.get("event_id", "")))
    except OSError:
        pass
    return last_id, last_ts


def bus_status() -> BusStatus:
    """Health snapshot of the bus. Fail-open: never raises."""
    if not AGENTIC_OS_ROOT.exists():
        return BusStatus(False, reason="bus root missing")

    schema_version = _read_schema_version()
    schema_present = bool(schema_version)
    if not schema_present:
        return BusStatus(False, reason="schema missing", schema_present=False)

    try:
        inbox_count = sum(1 for _ in _INBOX.glob("*.jsonl"))
    except OSError:
        inbox_count = -1

    archive_count = _archive_count()
    last_id, last_ts = _last_event()

    return BusStatus(
        available=True,
        reason="ok",
        schema_present=True,
        schema_version=schema_version,
        inbox_count=inbox_count,
        archive_count=archive_count,
        last_event_id=last_id,
        last_event_ts=last_ts,
    )


def poll_bus(since_ts: float = 0.0, limit: int = 50) -> list[dict[str, Any]]:
    """Return archived bus events with ts >= since_ts, newest first.

    Fail-open: returns [] on any error (missing dir, unreadable file,
    malformed line). Events are NOT translated — the adapter does that,
    separately, so polling stays a thin read.
    """
    archive_dir = AGENTIC_OS_ROOT / "events" / "archive"
    out: list[dict[str, Any]] = []
    try:
        for path in sorted(archive_dir.glob("*.jsonl")):
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        evt = json.loads(line)
                    except ValueError:
                        continue
                    ts = parse_timestamp(evt.get("timestamp", evt.get("ts")))
                    if ts >= since_ts:
                        out.append(evt)
    except OSError:
        return []
    out.sort(key=lambda e: parse_timestamp(e.get("timestamp", e.get("ts"))), reverse=True)
    return out[:limit]
