"""RepoCiv — Command schema and validation.

A Command is the unit of intent: UI proposes, policy decides, executor acts.
No real action occurs without a validated Command flowing through this module.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from .identifiers import IdentifierError, validate_identifier

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
    "external_reply",  # one turn over a foreign agent session (server/session_reply.py)
    "subagent_spawn",  # high-risk Task delegation audit gate
    "subagent_dispatch",  # explicit sub-mission dispatch (phase 2 stub)
    "unit_command",  # legacy compat
    "quest_add",     # legacy compat
    "e2e_probe",     # safe browser/bridge test probe, no external agent
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
    "execute_agent":  "low",  # user-gated: the act of clicking/sending IS the approval
    "send_message":   "high",
    # Same rationale as execute_agent above: the user typing the message and
    # sending it IS the approval. Tag it "high" instead and the risk floor in
    # policy.py turns every reply into an approval prompt — that is the knob.
    "external_reply": "low",
    "subagent_spawn": "high",
    "subagent_dispatch": "high",
    "unit_command":   "medium",
    "quest_add":      "low",
    "e2e_probe":      "low",
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
    harness_id: str | None = None    # optional harness selected for this command


# ─── Validation ──────────────────────────────────────────────────────────────
_REQUIRED_FIELDS = {"type", "target"}
_MAX_PAYLOAD_KEYS = 32
_MAX_STRING_LEN = 4096


class CommandValidationError(ValueError):
    pass


# ─── R16 store-identifier contract ───────────────────────────────────────────

# Command types whose payload feeds the checkpoint / workspace_issue stores.
_STORE_SCOPED_TYPES = frozenset({"task_run"})


def _validate_store_identifiers(cmd_type: str, payload: dict[str, Any]) -> None:
    """Validate store-scoped identifiers for command payloads.

    Currently applies to ``task_run`` (the only dispatch path that joins
    ``repo``/``issue_id`` into local store paths). A missing issue id is
    rejected here too, so a store-bound command never reaches dispatch
    with an empty identifier. Malformed tokens are rejected without
    repair, exactly as the direct helpers do.
    """
    if cmd_type not in _STORE_SCOPED_TYPES:
        return
    issue_raw = payload.get("issueId", payload.get("issue_id"))
    if issue_raw is None or (isinstance(issue_raw, str) and not issue_raw.strip()):
        raise IdentifierError("task_run requires issueId in payload")
    validate_identifier(str(issue_raw), field="issueId")
    repo_raw = payload.get("repo")
    if repo_raw is not None:
        validate_identifier(str(repo_raw), field="repo")


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

    default_risk: Risk = COMMAND_RISK.get(cmd_type, "medium")  # unknown types default medium
    supplied_risk = data.get("risk")
    if isinstance(supplied_risk, str) and supplied_risk in ("low", "medium", "high", "destructive"):
        risk: Risk = supplied_risk  # type: ignore[assignment]
    else:
        risk = default_risk
    created_by = str(data.get("created_by", "user"))[:64]

    # Harness selection: top-level field or nested inside payload
    harness_id: str | None = None
    if data.get("harness_id"):
        harness_id = str(data["harness_id"])[:64]
    elif isinstance(payload, dict) and payload.get("harnessId"):
        harness_id = str(payload["harnessId"])[:64]

    # R16: store-scoped identifier contract shared with checkpoint.py and
    # workspace_issue.py. Payloads that name a repo/issue for the local
    # state stores must satisfy the same confinement rules as the direct
    # helpers — a valid token or approval cannot bypass this boundary.
    try:
        _validate_store_identifiers(cmd_type, payload)
    except IdentifierError as exc:
        raise CommandValidationError(str(exc)) from exc

    return Command(
        type=cmd_type,
        target=target,
        payload=payload,
        created_by=created_by,
        risk=risk,
        harness_id=harness_id,
    )
