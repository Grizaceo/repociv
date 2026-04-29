"""RepoCiv — Policy Engine.

Decides whether a Command can run immediately (auto-safe), needs human approval,
or is blocked entirely. No real action bypasses this module.

Modes per command (in priority order):
  blocked         → rejected immediately, never executes
  approve         → placed in waiting_approval queue until user acts
  auto-safe       → queued and executed without human gate
"""
from __future__ import annotations

from typing import Literal
from .command_schema import Command, Risk
from .capabilities import check_capability

PolicyDecision = Literal["auto-safe", "approve", "blocked"]


# ─── Risk → default decision ───────────────────────────────────────────────────
_RISK_DEFAULT: dict[Risk, PolicyDecision] = {
    "low":         "auto-safe",
    "medium":      "approve",
    "high":        "approve",
    "destructive": "approve",
}

# ─── Per-type overrides (takes precedence over risk default) ──────────────────
_TYPE_POLICY: dict[str, PolicyDecision] = {
    "inspect_repo":  "auto-safe",
    "read_file":     "auto-safe",
    "run_tests":     "auto-safe",
    "run_build":     "auto-safe",
    "quest_add":     "auto-safe",   # low-risk bookkeeping
    "unit_command":  "auto-safe",   # legacy compat — already gated by UX
    "edit_file":     "approve",
    "create_branch": "approve",
    "git_commit":    "approve",
    "send_message":  "approve",
    "delete_file":   "approve",     # destructive but not blocked; needs explicit ok
    "execute_agent": "approve",
}


def decide(cmd: Command) -> tuple[PolicyDecision, str]:
    """Return (decision, reason) for a command.

    Capability check runs first; type policy applies only if agent is capable.
    """
    agent_id = str(cmd.payload.get("unit", "DAVI"))
    allowed, reason = check_capability(agent_id, cmd.type, cmd.target)
    if not allowed:
        return "blocked", reason

    if cmd.type in _TYPE_POLICY:
        return _TYPE_POLICY[cmd.type], ""
    return _RISK_DEFAULT.get(cmd.risk, "approve"), ""


def apply_policy(cmd: Command) -> tuple[Command, str]:
    """Mutate cmd.requires_approval and cmd.status according to policy.

    Returns (cmd, reason) — reason is non-empty only when blocked.
    """
    decision, reason = decide(cmd)
    if decision == "auto-safe":
        cmd.requires_approval = False
        cmd.status = "queued"
    elif decision == "approve":
        cmd.requires_approval = True
        cmd.status = "waiting_approval"
    elif decision == "blocked":
        cmd.requires_approval = False
        cmd.status = "rejected"
    return cmd, reason
