"""RepoCiv — Command schema and validation.

A Command is the unit of intent: UI proposes, policy decides, executor acts.
No real action occurs without a validated Command flowing through this module.
"""
from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

Risk = Literal["low", "medium", "high", "destructive"]

CommandType = Literal[
    "inspect_repo",
    "read_file",
    "run_tests",
    "run_build",
    "edit_file",
    "create_branch",
    "git_commit",
    "delete_file",
    "execute_agent",
    "send_message",
    "subagent_spawn",
    "subagent_dispatch",
    "unit_command",
    "quest_add",
    "e2e_probe",
]

CommandStatus = Literal[
    "proposed",
    "queued",
    "running",
    "waiting_approval",
    "completed",
    "failed",
    "cancelled",
    "rejected",
]

COMMAND_RISK: dict[str, Risk] = {
    "inspect_repo": "low",
    "read_file": "low",
    "run_tests": "low",
    "run_build": "low",
    "edit_file": "medium",
    "create_branch": "medium",
    "git_commit": "high",
    "delete_file": "destructive",
    "execute_agent": "low",
    "send_message": "high",
    "subagent_spawn": "high",
    "subagent_dispatch": "high",
    "unit_command": "medium",
    "quest_add": "low",
    "e2e_probe": "low",
}

KNOWN_COMMAND_TYPES = frozenset(COMMAND_RISK)
_RISK_ORDER: dict[Risk, int] = {"low": 0, "medium": 1, "high": 2, "destructive": 3}
_SAFE_UNIT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


@dataclass
class Command:
    type: str
    target: str
    payload: dict[str, Any] = field(default_factory=dict)
    created_by: str = "user"
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:12])
    risk: Risk = "low"
    requires_approval: bool = False
    status: CommandStatus = "proposed"
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    result: str = ""
    harness_id: str | None = None


_REQUIRED_FIELDS = {"type", "target"}
_MAX_PAYLOAD_KEYS = 32
_MAX_STRING_LEN = 4096
_MAX_PAYLOAD_DEPTH = 6
_MAX_LIST_ITEMS = 128


class CommandValidationError(ValueError):
    pass


def _validate_payload_value(value: Any, path: str = "payload", depth: int = 0) -> None:
    if depth > _MAX_PAYLOAD_DEPTH:
        raise CommandValidationError(f"{path} exceeds max nesting depth")
    if isinstance(value, str):
        if len(value) > _MAX_STRING_LEN:
            raise CommandValidationError(f"payload string exceeds max length at {path}")
        return
    if value is None or isinstance(value, (bool, int, float)):
        return
    if isinstance(value, list):
        if len(value) > _MAX_LIST_ITEMS:
            raise CommandValidationError(f"{path} has too many items")
        for index, item in enumerate(value):
            _validate_payload_value(item, f"{path}[{index}]", depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > _MAX_PAYLOAD_KEYS:
            raise CommandValidationError(f"{path} has too many keys")
        for key, item in value.items():
            if not isinstance(key, str) or not key or len(key) > 128:
                raise CommandValidationError(f"{path} contains an invalid key")
            _validate_payload_value(item, f"{path}.{key}", depth + 1)
        return
    raise CommandValidationError(f"{path} contains unsupported value type")


def _server_default_risk(cmd_type: str, payload: dict[str, Any]) -> Risk:
    default = COMMAND_RISK[cmd_type]
    if cmd_type != "execute_agent":
        return default
    unit = str(payload.get("unit", "MAIN")).split("-", 1)[0].upper()
    harness = str(payload.get("harness", "")).strip().lower()
    has_repo = bool(str(payload.get("repoPath", "")).strip())
    conversational = not has_repo and unit == "MAIN" and harness in {"", "auto", "hermes"}
    return "low" if conversational else "medium"


def validate_command(data: dict[str, Any]) -> Command:
    """Parse and validate a raw dict into a Command."""
    missing = _REQUIRED_FIELDS - data.keys()
    if missing:
        raise CommandValidationError(f"Missing required fields: {missing}")

    cmd_type = data.get("type", "")
    if not isinstance(cmd_type, str) or not cmd_type:
        raise CommandValidationError("type must be a non-empty string")
    if cmd_type not in KNOWN_COMMAND_TYPES:
        raise CommandValidationError(f"unknown command type: {cmd_type}")

    target = data.get("target", "")
    if not isinstance(target, str):
        raise CommandValidationError("target must be a string")
    if len(target) > _MAX_STRING_LEN:
        raise CommandValidationError("target exceeds max length")

    payload = data.get("payload", {})
    if not isinstance(payload, dict):
        raise CommandValidationError("payload must be an object")
    if len(payload) > _MAX_PAYLOAD_KEYS:
        raise CommandValidationError(f"payload has too many keys (max {_MAX_PAYLOAD_KEYS})")
    _validate_payload_value(payload)

    if cmd_type == "execute_agent":
        unit = payload.get("unit", "MAIN")
        if not isinstance(unit, str) or not _SAFE_UNIT_RE.fullmatch(unit):
            raise CommandValidationError("payload.unit must be a safe unit identifier")
        mission = payload.get("mission", "")
        if not isinstance(mission, str) or not mission.strip():
            raise CommandValidationError("payload.mission must be a non-empty string")

    default_risk: Risk = _server_default_risk(cmd_type, payload)
    supplied_risk = data.get("risk")
    if isinstance(supplied_risk, str) and supplied_risk in _RISK_ORDER:
        requested: Risk = supplied_risk  # type: ignore[assignment]
        risk = requested if _RISK_ORDER[requested] > _RISK_ORDER[default_risk] else default_risk
    else:
        risk = default_risk
    created_by = str(data.get("created_by", "user"))[:64]

    harness_id: str | None = None
    if data.get("harness_id"):
        harness_id = str(data["harness_id"])[:64]
    elif payload.get("harnessId"):
        harness_id = str(payload["harnessId"])[:64]

    return Command(
        type=cmd_type,
        target=target,
        payload=payload,
        created_by=created_by,
        risk=risk,
        harness_id=harness_id,
    )
