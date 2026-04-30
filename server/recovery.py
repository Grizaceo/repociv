"""RepoCiv — Recovery Planning.

Centralizes recovery planning: given a harness descriptor and a failure context,
returns a declarative recovery object describing what the operator can do next.

Recovery objects describe actions (copy_command, tmux_attach, view_logs,
no_recovery_available) but do NOT launch anything — that is the caller's
responsibility.

Failure reasons:
  command_failed    — a command run on this harness failed
  harness_unreachable — health check timed out or errored
  harness_healthy  — operator asked for recovery without a failure (exploratory)
  harness_not_found — the harness_id does not exist in the registry
  unknown          — uncategorized reason
"""
from __future__ import annotations

import shlex
from typing import Any, Literal

# ─── Types ────────────────────────────────────────────────────────────────────

RecoveryMode = Literal[
    "copy_command",
    "tmux_attach",
    "view_logs",
    "no_recovery_available",
]

FailureReason = Literal[
    "command_failed",
    "harness_unreachable",
    "harness_healthy",
    "harness_not_found",
    "unknown",
]

# ─── Internal helpers ─────────────────────────────────────────────────────────


def _normalize_recovery_modes(harness: dict[str, Any]) -> list[str]:
    """Tolerate both recovery_modes and recoveryModes keys."""
    modes = harness.get("recoveryModes", []) or harness.get("recovery_modes", [])
    if isinstance(modes, list) and all(isinstance(m, str) for m in modes):
        return modes
    return []


def _normalize_recovery(harness: dict[str, Any]) -> dict[str, Any]:
    """Tolerate both recovery and recovery dict keys."""
    rec = harness.get("recovery", {}) or {}
    if not isinstance(rec, dict):
        return {}
    return rec


def _select_mode(
    modes: list[str],
    preferred: RecoveryMode,
) -> "RecoveryMode | None":
    if preferred in modes:
        return preferred
    for m in modes:
        if m != "no_recovery_available":
            return m  # type: ignore[return-value]
    return "no_recovery_available" if "no_recovery_available" in modes else None


def _risk_from_trust(trust: str) -> str:
    """Map a trust level to a human-readable risk label."""
    mapping = {
        "reference_only":     "informational",
        "read_only":          "low",
        "sandboxed":          "low",
        "local_cli":          "medium",
        "privileged_external":"high",
    }
    return mapping.get(trust, "unknown")


# ─── Public API ───────────────────────────────────────────────────────────────


def build_recovery_plan(
    harness: dict[str, Any],
    failure_context: dict[str, Any],
) -> dict[str, Any]:
    """Build a declarative recovery plan.

    Parameters
    ----------
    harness :
        A harness descriptor dict loaded from harness_registry.
    failure_context :
        A dict that must contain a ``reason`` key with one of the FailureReason
        values. Optional keys include ``command_type`` (str),
        ``target`` (str), and ``details`` (str).

    Returns
    -------
    dict
        A recovery plan with the following keys:

        mode                : RecoveryMode — the selected mode
        harness_id          : str
        harness_label       : str
        trust_level         : str
        command             : str — shell command to run (copy_command / tmux_attach)
        cwd                 : str — working directory for the command
        session             : str — tmux session name (tmux_attach only)
        notes               : list[str] — human-readable notes
        requires_approval    : bool — whether this recovery action needs approval
        risk                : str — informational risk label
        reason              : FailureReason — why recovery was triggered
        explanation         : str — human-readable explanation of the plan
        available_modes     : list[str] — all recovery modes available
    """
    reason: FailureReason = failure_context.get("reason", "unknown")
    cmd_type: str = failure_context.get("command_type", "")
    target: str = failure_context.get("target", "")
    details: str = failure_context.get("details", "")

    harness_id = harness.get("id", "unknown")
    harness_label = harness.get("label", harness_id)
    trust_level = harness.get("trustLevel", "read_only")
    modes = _normalize_recovery_modes(harness)
    recovery_config = _normalize_recovery(harness)

    # Always report available modes
    available_modes = list(modes) if modes else ["no_recovery_available"]

    # No recovery available
    # Only bail out when no_recovery_available is the ONLY mode available
    if not modes or (len(modes) == 1 and "no_recovery_available" in modes):
        return _build_no_recovery(
            harness_id=harness_id,
            harness_label=harness_label,
            trust_level=trust_level,
            reason=reason,
            cmd_type=cmd_type,
            target=target,
            details=details,
            available_modes=available_modes,
        )

    # Choose preferred mode based on context
    preferred: RecoveryMode = "copy_command"
    if reason == "harness_healthy":
        preferred = "copy_command"
    elif reason == "command_failed":
        preferred = "copy_command"

    selected = _select_mode(modes, preferred)

    if selected == "no_recovery_available" or selected is None:
        return _build_no_recovery(
            harness_id=harness_id,
            harness_label=harness_label,
            trust_level=trust_level,
            reason=reason,
            cmd_type=cmd_type,
            target=target,
            details=details,
            available_modes=available_modes,
        )

    if selected == "copy_command":
        return _build_copy_command(
            harness=harness,
            harness_id=harness_id,
            harness_label=harness_label,
            trust_level=trust_level,
            reason=reason,
            cmd_type=cmd_type,
            target=target,
            details=details,
            recovery_config=recovery_config,
            available_modes=available_modes,
        )

    if selected == "tmux_attach":
        return _build_tmux_attach(
            harness=harness,
            harness_id=harness_id,
            harness_label=harness_label,
            trust_level=trust_level,
            reason=reason,
            cmd_type=cmd_type,
            target=target,
            details=details,
            recovery_config=recovery_config,
            available_modes=available_modes,
        )

    if selected == "view_logs":
        return _build_view_logs(
            harness=harness,
            harness_id=harness_id,
            harness_label=harness_label,
            trust_level=trust_level,
            reason=reason,
            cmd_type=cmd_type,
            target=target,
            details=details,
            recovery_config=recovery_config,
            available_modes=available_modes,
        )

    # Fallback — should not reach here
    return _build_no_recovery(
        harness_id=harness_id,
        harness_label=harness_label,
        trust_level=trust_level,
        reason=reason,
        cmd_type=cmd_type,
        target=target,
        details=details,
        available_modes=available_modes,
    )


def _build_no_recovery(
    harness_id: str,
    harness_label: str,
    trust_level: str,
    reason: FailureReason,
    cmd_type: str,
    target: str,
    details: str,
    available_modes: list[str],
) -> dict[str, Any]:
    explanations = {
        "command_failed": (
            f"The last command on harness '{harness_id}' failed. "
            "This harness does not expose a recovery path."
        ),
        "harness_unreachable": (
            f"Harness '{harness_id}' is not reachable. "
            "No recovery path is available."
        ),
        "harness_healthy": (
            f"Harness '{harness_id}' is healthy. "
            "No recovery is needed at this time."
        ),
        "harness_not_found": (
            f"Harness '{harness_id}' was not found in the registry. "
            "Cannot build a recovery plan."
        ),
        "unknown": (
            f"No recovery plan is available for harness '{harness_id}'."
        ),
    }

    return {
        "mode": "no_recovery_available",
        "harness_id": harness_id,
        "harness_label": harness_label,
        "trust_level": trust_level,
        "command": "",
        "cwd": "",
        "session": "",
        "notes": [],
        "requires_approval": False,
        "risk": _risk_from_trust(trust_level),
        "reason": reason,
        "explanation": explanations.get(reason, explanations["unknown"]),
        "available_modes": available_modes,
    }


def _build_copy_command(
    harness: dict[str, Any],
    harness_id: str,
    harness_label: str,
    trust_level: str,
    reason: FailureReason,
    cmd_type: str,
    target: str,
    details: str,
    recovery_config: dict[str, Any],
    available_modes: list[str],
) -> dict[str, Any]:
    cfg = recovery_config.get("copy_command", {})
    command = cfg.get("command", "")
    cwd = cfg.get("cwd", "~/.hermes")
    notes_raw = cfg.get("notes", [])
    notes = [notes_raw] if isinstance(notes_raw, str) else list(notes_raw or [])

    explanations = {
        "command_failed": (
            f"Command '{cmd_type}' on target '{target}' failed on harness "
            f"'{harness_id}'. Copy the command below to retry manually."
        ),
        "harness_unreachable": (
            f"Harness '{harness_id}' is unreachable. Copy the command to "
            "attempt recovery manually."
        ),
        "harness_healthy": (
            f"Attach to harness '{harness_id}' using the command below."
        ),
        "unknown": (
            f"Recovery for harness '{harness_id}': copy and run the command below."
        ),
    }

    # Add context notes if available
    if cmd_type:
        notes.insert(0, f"Failed command type: {cmd_type}")
    if target:
        notes.insert(0, f"Target: {target}")
    if details:
        notes.insert(0, f"Details: {details}")

    # copy_command on privileged_external harness needs approval
    requires_approval = trust_level == "privileged_external"

    return {
        "mode": "copy_command",
        "harness_id": harness_id,
        "harness_label": harness_label,
        "trust_level": trust_level,
        "command": command,
        "cwd": cwd,
        "session": "",
        "notes": notes,
        "requires_approval": requires_approval,
        "risk": _risk_from_trust(trust_level),
        "reason": reason,
        "explanation": explanations.get(reason, explanations["unknown"]),
        "available_modes": available_modes,
    }


def _build_tmux_attach(
    harness: dict[str, Any],
    harness_id: str,
    harness_label: str,
    trust_level: str,
    reason: FailureReason,
    cmd_type: str,
    target: str,
    details: str,
    recovery_config: dict[str, Any],
    available_modes: list[str],
) -> dict[str, Any]:
    cfg = recovery_config.get("tmux_attach", {})
    session = cfg.get("session", harness_id)
    notes_raw = cfg.get("notes", [])
    notes = [notes_raw] if isinstance(notes_raw, str) else list(notes_raw or [])

    quoted_session = shlex.quote(session)
    command = f"tmux attach-session -t {quoted_session} || tmux new-session -s {quoted_session}"

    explanations = {
        "command_failed": (
            f"Command '{cmd_type}' failed on harness '{harness_id}'. "
            f"Attach to the tmux session '{session}' to inspect the harness state."
        ),
        "harness_unreachable": (
            f"Harness '{harness_id}' is unreachable. "
            f"Attach to tmux session '{session}' to check its status."
        ),
        "harness_healthy": (
            f"Open tmux session '{session}' to interact with harness '{harness_id}'."
        ),
        "unknown": (
            f"Attach to tmux session '{session}' for harness '{harness_id}'."
        ),
    }

    if details:
        notes.insert(0, f"Details: {details}")

    return {
        "mode": "tmux_attach",
        "harness_id": harness_id,
        "harness_label": harness_label,
        "trust_level": trust_level,
        "command": command,
        "cwd": "~/.hermes",
        "session": session,
        "notes": notes,
        "requires_approval": False,
        "risk": _risk_from_trust(trust_level),
        "reason": reason,
        "explanation": explanations.get(reason, explanations["unknown"]),
        "available_modes": available_modes,
    }


def _build_view_logs(
    harness: dict[str, Any],
    harness_id: str,
    harness_label: str,
    trust_level: str,
    reason: FailureReason,
    cmd_type: str,
    target: str,
    details: str,
    recovery_config: dict[str, Any],
    available_modes: list[str],
) -> dict[str, Any]:
    cfg = recovery_config.get("view_logs", {})
    notes_raw = cfg.get("notes", [])
    notes = [notes_raw] if isinstance(notes_raw, str) else list(notes_raw or [])

    explanations = {
        "command_failed": (
            f"Command '{cmd_type}' failed on sandbox harness '{harness_id}'. "
            "Check the dashboard for logs."
        ),
        "harness_unreachable": (
            f"Harness '{harness_id}' is unreachable. "
            "Logs may be available in the sandbox dashboard."
        ),
        "harness_healthy": (
            f"View logs for harness '{harness_id}' in the sandbox dashboard."
        ),
        "unknown": (
            f"View logs for harness '{harness_id}'."
        ),
    }

    if details:
        notes.insert(0, f"Details: {details}")

    return {
        "mode": "view_logs",
        "harness_id": harness_id,
        "harness_label": harness_label,
        "trust_level": trust_level,
        "command": "",
        "cwd": "",
        "session": "",
        "notes": notes,
        "requires_approval": False,
        "risk": _risk_from_trust(trust_level),
        "reason": reason,
        "explanation": explanations.get(reason, explanations["unknown"]),
        "available_modes": available_modes,
    }


# ─── Session / Run-state aware recovery (P1 enrichment) ──────────────────────


def build_recovery_with_state(
    harness: dict[str, Any],
    failure_context: dict[str, Any],
    *,
    unit_id: str = "",
    run_id: str = "",
) -> dict[str, Any]:
    """Build a recovery plan enriched with session and run_state context.

    On top of the base build_recovery_plan(), this also:
    - Looks up the canonical session to include workspace/workingDirectory
    - Pulls run_state for the current/past run to contextualize the failure
    - Returns `sessionContext` and `runContext` fields for downstream consumers
    """
    plan = build_recovery_plan(harness, failure_context)

    session_ctx: dict[str, Any] | None = None
    run_ctx: dict[str, Any] | None = None

    if unit_id:
        try:
            from . import sessions as _sessions
            session_ctx = _sessions.get_or_create(unit_id)
        except Exception:
            pass

    if run_id:
        try:
            from . import run_state as _run_state
            run_ctx = _run_state.load(run_id)
        except Exception:
            pass

    plan["sessionContext"] = session_ctx
    plan["runContext"] = run_ctx
    return plan


def auto_resolve_recovery(
    unit_id: str,
    harness_id: str = "",
    failure_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Attempt automatic recovery resolution from stored state.

    Checks whether a previous run_state or session already has recovery
    instructions recorded — avoids re-deriving the same plan.

    Returns a dict with:
    - resolved: bool — whether auto-resolution was possible
    - plan: recovery plan (if resolved) or None
    - source: where the resolution came from
    """
    failure_context = failure_context or {}
    reason = failure_context.get("reason", "unknown")

    try:
        from . import sessions as _sessions
        from . import run_state as _run_state
    except Exception:
        return {"resolved": False, "plan": None, "source": "import-error"}

    # 1. Check if there's a previous recovery recorded in run_state
    session = _sessions.get_or_create(unit_id)
    last_mission = session.get("lastMissionId", "")
    if last_mission:
        run = _run_state.load(last_mission)
        if run:
            prev_recovery = run.get("lastRecovery", None)
            if prev_recovery and isinstance(prev_recovery, dict):
                prev_reason = prev_recovery.get("reason", "")
                same_reason = prev_reason == reason or prev_reason == "unknown"
                if same_reason:
                    return {
                        "resolved": True,
                        "plan": prev_recovery,
                        "source": f"run_state:{last_mission}",
                    }

    # 2. Check recent transcript for recovery instructions
    recent = _sessions.get_recent(unit_id, limit=10)
    for entry in reversed(recent):
        content = entry.get("content", "")
        if isinstance(content, str) and "[recovery]" in content.lower():
            return {
                "resolved": True,
                "plan": None,
                "source": "transcript-hint",
                "hint": content[:500],
            }

    return {"resolved": False, "plan": None, "source": "no-prior-state"}


def record_recovery_outcome(
    unit_id: str,
    run_id: str,
    plan: dict[str, Any],
    *,
    success: bool,
    notes: str = "",
) -> dict[str, Any] | None:
    """Persist recovery outcome to the run_state and session transcript.

    Called after a recovery action was attempted — records the result so
    the next reconciliation pass can see it.
    """
    try:
        from . import sessions as _sessions
        from . import run_state as _run_state
    except Exception:
        return None

    # Update run_state with recovery info
    try:
        _run_state.patch(
            run_id,
            lastRecovery=plan,
            lastRecoverySuccess=success,
            lastRecoveryNotes=notes[:500],
        )
    except Exception:
        pass

    # Log to session transcript
    try:
        status = "applied" if success else "failed"
        _sessions.append_message(
            unit_id,
            "system",
            f"[recovery] {plan.get('mode', 'unknown')} → {status}",
            meta={
                "missionId": run_id,
                "recoveryMode": plan.get("mode"),
                "success": success,
            },
        )
    except Exception:
        pass

    # Return the updated run_state
    try:
        return _run_state.load(run_id)
    except Exception:
        return None
