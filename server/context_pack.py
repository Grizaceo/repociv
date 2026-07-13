"""RepoCiv — minimal context pack built from canonical Event Store v1 events."""
from __future__ import annotations

from typing import Any


def _event_values(event: dict[str, Any]) -> list[str]:
    raw_data = event.get("data")
    data: dict[str, Any] = raw_data if isinstance(raw_data, dict) else {}
    raw_payload = data.get("payload")
    payload: dict[str, Any] = raw_payload if isinstance(raw_payload, dict) else {}
    return [
        str(event.get("commandId") or event.get("command_id") or ""),
        str(data.get("target") or ""),
        str(data.get("repoPath") or ""),
        str(data.get("unitId") or ""),
        str(payload.get("city") or ""),
        str(payload.get("repoPath") or ""),
        str(payload.get("unit") or ""),
    ]


def _matches_target(event: dict[str, Any], target: str) -> bool:
    needle = target.strip().lower()
    return bool(needle) and any(needle in value.lower() for value in _event_values(event))


def build_context_pack(
    agent_id: str,
    target: str,
    event_store: Any,
    max_events: int = 10,
) -> dict[str, Any]:
    """Return target-specific recent events and truthful last/test outcomes."""
    all_events = event_store.read_events(since=0, limit=500)
    target_events = [event for event in all_events if _matches_target(event, target)]
    recent = target_events[-max_events:]

    last_status = "unknown"
    last_error = ""
    for event in reversed(target_events):
        raw_data = event.get("data")
        data: dict[str, Any] = raw_data if isinstance(raw_data, dict) else {}
        event_type = event.get("type", "")
        if event_type == "CommandCompleted":
            last_status = "ok"
            break
        if event_type == "CommandCancelled":
            last_status = "cancelled"
            last_error = str(data.get("reason") or "")
            break
        if event_type in {"CommandFailed", "CommandRejected"}:
            last_status = "failed"
            last_error = str(data.get("error") or data.get("reason") or "")
            break

    test_status = "unknown"
    for event in reversed(target_events):
        if event.get("type") not in {"CommandCompleted", "CommandFailed"}:
            continue
        raw_data = event.get("data")
        data: dict[str, Any] = raw_data if isinstance(raw_data, dict) else {}
        if data.get("commandType") != "run_tests":
            continue
        test_status = "passed" if event.get("type") == "CommandCompleted" else "failed"
        break

    return {
        "agent_id": agent_id,
        "target": target,
        "recent_events": [_slim(event) for event in recent],
        "last_status": last_status,
        "last_error": last_error,
        "test_status": test_status,
    }


def _slim(event: dict[str, Any]) -> dict[str, Any]:
    raw_data = event.get("data")
    data: dict[str, Any] = raw_data if isinstance(raw_data, dict) else {}
    return {
        "schemaVersion": int(event.get("schemaVersion") or 0),
        "type": str(event.get("type") or ""),
        "commandId": str(event.get("commandId") or event.get("command_id") or ""),
        "timestamp": float(event.get("timestamp") or event.get("ts") or 0.0),
        "actor": str(event.get("actor") or ""),
        "data": data,
    }
