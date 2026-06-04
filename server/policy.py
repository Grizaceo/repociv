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
from . import harness_registry as _hr

PolicyDecision = Literal["auto-safe", "approve", "blocked"]

# Trust-level hierarchy for policy (higher = more trusted)
_TRUST_HIERARCHY = [
    "reference_only",
    "read_only",
    "sandboxed",
    "local_cli",
    "privileged_external",
]

# ─── Capability check against harness allowed/blocked actions ───────────────


def _harness_allows(harness: dict, cmd_type: str) -> bool:
    """Return True if the harness descriptor allows cmd_type."""
    allowed = harness.get("allowedActions", [])
    blocked = harness.get("blockedActions", [])
    if cmd_type in blocked:
        return False
    if allowed and cmd_type not in allowed:
        return False
    return True


def _harness_trust_level(harness: dict) -> str:
    return harness.get("trustLevel", "read_only")


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
    "execute_agent": "auto-safe",   # chat flow — gated by UX (user types and sends)
    "e2e_probe":     "auto-safe",   # browser→bridge→event probe, no external agent
    "edit_file":     "approve",
    "create_branch": "approve",
    "git_commit":    "approve",
    "send_message":  "approve",
    "delete_file":   "approve",     # destructive but not blocked; needs explicit ok
    "subagent_spawn": "approve",    # high/destructive Task delegations — audit gate
}


def decide(cmd: Command) -> tuple[PolicyDecision, str]:
    """Return (decision, reason) for a command.

    Policy logic (in evaluation order):
      1. Reference-only harness → always blocked, regardless of type.
      2. Explicit harness: verify cmd_type is in allowedActions / not in blockedActions.
         If not capable, block.
      3. Inferred harness (no explicit harness_id): infer from command type.
      4. Trust-level overrides:
         - sandboxed + medium-risk command → promote to approve.
         - privileged_external + send_message → promote to approve (already approve
           by type, but this documents the extra gate).
         - privileged_external + high/destructive → stays approve.
      5. Type policy applies last (auto-safe / approve / blocked by type name).
    """
    # Step 1: resolve the harness descriptor
    harness: dict | None = None
    if cmd.harness_id:
        harness = _hr.get_harness(cmd.harness_id)
        if harness is None:
            return "blocked", f"Unknown harness '{cmd.harness_id}'"

    # Step 2: reference_only always blocks
    if harness and _harness_trust_level(harness) == "reference_only":
        return "blocked", (
            f"Harness '{cmd.harness_id}' has trust level 'reference_only' "
            "and may not execute any action."
        )

    # Step 3: capability check against harness allowed/blocked lists
    if harness:
        if not _harness_allows(harness, cmd.type):
            return "blocked", (
                f"Command type '{cmd.type}' is not allowed by harness "
                f"'{cmd.harness_id}' (trust level: {_harness_trust_level(harness)})."
            )

    # Step 4: infer harness if not specified (for allowed-actions coverage)
    if harness is None:
        inferred = _hr.infer_harness_for_command(cmd.type)
        if inferred is None:
            return "blocked", f"No harness found that supports command type '{cmd.type}'."
        harness = inferred

    # Step 5: trust-level upgrades for medium-risk commands
    trust = _harness_trust_level(harness)
    if trust == "sandboxed" and cmd.risk == "medium":
        return "approve", (
            f"Command '{cmd.type}' on sandboxed harness requires approval "
            "(medium risk on sandboxed harness)."
        )

    # Step 6: type policy
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
