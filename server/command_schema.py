"""RepoCiv — Command schema and validation.

A Command is the unit of intent: UI proposes, policy decides, executor acts.
No real action occurs without a validated Command flowing through this module.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Any, Literal

# ─── Risk levels ──────────────────────────────────────────────────────────────
Risk = Literal["low", "medium", "high", "destructive"]

# ─── Command types ─────────────────────────────────────────────────────────────
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
    "unit_command",  # legacy compat
    "quest_add",     # legacy compat
]

# ─── Command status ───────────────────────────────────────────────────────────
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

# ─── Risk table: default risk per command type ────────────────────────────────
COMMAND_RISK: dict[str, Risk] = {
    "inspect_repo":   "low",
    "read_file":      "low",
    "run_tests":      "low",
    "run_build":      "low",
    "edit_file":      "medium",
    "create_branch":  "medium",
    "git_commit":     "high",
    "delete_file":    "destructive",
    "execute_agent":  "medium",
    "send_message":   "high",
    "unit_command":   "medium",
    "quest_add":      "low",
}


@dataclass
class Command:
    type: str
    target: str                      # repo/city/file/coordinate
    payload: dict[str, Any] = field(default_factory=dict)
    created_by: str = "user"         # user | system | agentId
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:12])
    risk: Risk = "low"
    requires_approval: bool = False
    status: CommandStatus = "proposed"
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    result: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# ─── Validation ──────────────────────────────────────────────────────────────
_REQUIRED_FIELDS = {"type", "target"}
_MAX_PAYLOAD_KEYS = 32
_MAX_STRING_LEN = 4096


class CommandValidationError(ValueError):
    pass


def validate_command(data: dict[str, Any]) -> Command:
    """Parse and validate a raw dict into a Command. Raises CommandValidationError."""
    missing = _REQUIRED_FIELDS - data.keys()
    if missing:
        raise CommandValidationError(f"Missing required fields: {missing}")

    cmd_type = data.get("type", "")
    if not isinstance(cmd_type, str) or not cmd_type:
        raise CommandValidationError("type must be a non-empty string")

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

    risk: Risk = COMMAND_RISK.get(cmd_type, "medium")  # unknown types default medium
    created_by = str(data.get("created_by", "user"))[:64]

    return Command(
        type=cmd_type,
        target=target,
        payload=payload,
        created_by=created_by,
        risk=risk,
    )
