"""Schema translation: agentic-os.event.v1 → RepoCiv event shape.

The bus speaks `agentic-os.event.v1` (LABS/agentic-os/EVENT_SCHEMA.json);
RepoCiv's event_store speaks command-lifecycle events
(CommandCreated, CommandStarted, CommandCompleted, ...). This adapter maps
the bus schema into RepoCiv's store shape so the store can ingest foreign
events without schema changes (scope rule: no core changes).

Mapping is best-effort and lossy by design:
  - bus `type` (e.g. "task.completed") → store `type` passthrough
  - bus `severity` → store `severity`
  - bus `source` → store `data.source`
  - bus `id`/`timestamp` → store `data.busEventId`/`data.busTimestamp`
  - unknown keys under `data.bus` preserve provenance
"""

from __future__ import annotations

from typing import Any

from server.agentic_os_bus.client import parse_timestamp

# RepoCiv event_store event types (server/event_store.py)
_REPOCIV_EVENT_TYPES = {
    "CommandCreated",
    "CommandQueued",
    "CommandStarted",
    "AgentOutputChunk",
    "CommandCompleted",
    "CommandFailed",
    "CommandRejected",
}


def to_repociv_event(bus_event: dict[str, Any]) -> dict[str, Any]:
    """Translate one bus event into the RepoCiv event-store shape.

    Fail-open: a malformed/empty bus event yields a minimal record with
    `type: "AgenticOsEvent"` instead of raising.
    """
    if not isinstance(bus_event, dict):
        return _fallback("", 0, "malformed bus event")

    evt_type = str(bus_event.get("type", "")).strip()
    ts = parse_timestamp(bus_event.get("timestamp", bus_event.get("ts")))
    store_type = evt_type if evt_type in _REPOCIV_EVENT_TYPES else "AgenticOsEvent"

    data: dict[str, Any] = {
        "busEventId": bus_event.get("id", bus_event.get("event_id", "")),
        "busTimestamp": ts,
        "source": bus_event.get("source", ""),
    }
    raw_data = bus_event.get("payload") or bus_event.get("data")
    if isinstance(raw_data, dict):
        data["payload"] = raw_data
    data["bus"] = {
        k: v
        for k, v in bus_event.items()
        if k not in {"type", "timestamp", "ts", "id", "event_id", "source", "payload", "data", "severity"}
    }

    return {
        "type": store_type,
        "severity": bus_event.get("severity", "info"),
        "actor": "OS",
        "data": data,
        "ts": ts,
    }


def _fallback(event_id: str, ts: float, reason: str) -> dict[str, Any]:
    return {
        "type": "AgenticOsEvent",
        "severity": "warn",
        "actor": "OS",
        "data": {"busEventId": event_id, "busTimestamp": ts, "reason": reason},
        "ts": ts,
    }
