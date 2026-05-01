"""RepoCiv — Phase State Machine (Fase 0).

Defines the canonical Phase enum as StrEnum so phase names are plain strings
in JSON/JSONL payloads, logs, and DuckDB rows. Using StrEnum means:

    Phase.SPEC == "spec"          # True
    json.dumps(Phase.SPEC)        # '"spec"'
    f"phase={Phase.DISPATCH}"     # 'phase=dispatch'

Adding a new phase (e.g. SECURITY_HARDENING) never breaks existing code that
already handles known phases — unknown values remain valid StrEnum members.

Hierarchy (linear happy path):
    IDLE → SPEC → PLAN → DISPATCH → COLLECT → CLOSE

Non-linear transitions allowed:
    any → BLOCKED   (A2O Sentinel: .repociv/status = "blocked")
    any → FAILED
    BLOCKED → SPEC  (resumption after human unblock)
    BLOCKED → IDLE  (abort)
"""
from __future__ import annotations

import sys

# StrEnum available in stdlib from Python 3.11+.
# For 3.10 and below we supply a compatible backport.
if sys.version_info >= (3, 11):
    from enum import StrEnum
else:
    from enum import Enum

    class StrEnum(str, Enum):  # type: ignore[no-redef]
        """Backport: enum members are their own string value."""

        def __str__(self) -> str:
            return self.value


class Phase(StrEnum):
    """Task lifecycle phases for the RepoCiv orchestrator.

    Phases map 1:1 to the ``phase`` field in:
      - ``run_state.py``  (live task snapshots)
      - ``server/research_ledger.py``  missions table
      - A2O Sentinel file (``.repociv/status``)
    """

    # ── Happy-path phases ──────────────────────────────────────────────────
    IDLE = "idle"
    """No active work. Unit is available for dispatch."""

    SPEC = "spec"
    """Gathering requirements and writing the issue specification."""

    PLAN = "plan"
    """Generating the step-by-step execution plan (H4 checkpoint gate)."""

    DISPATCH = "dispatch"
    """Sending steps to agents; awaiting responses."""

    COLLECT = "collect"
    """Aggregating agent outputs; running post-execution audit (Fase 1.5)."""

    CLOSE = "close"
    """Finalising artifacts, updating Ledger, closing the issue."""

    # ── Exception phases ───────────────────────────────────────────────────
    BLOCKED = "blocked"
    """A2O Sentinel active: human review required before resumption."""

    NEEDS_HUMAN_REVIEW = "needs-human-review"
    """Sentinel variant: agent flagged ambiguity, not a hard block."""

    FAILED = "failed"
    """Terminal failure. Preserved for post-mortem. Not retried automatically."""

    # ── Meta / future phases (declared now, used in Fase 3+) ──────────────
    SECURITY_HARDENING = "security-hardening"
    """Post-collect security scan gate (SecurityHarness, Fase 1.5)."""

    SWARM_DEBATE = "swarm-debate"
    """Consensus round between specialist agents (Fase 3)."""

    SELF_IMPROVE = "self-improve"
    """SICA loop: reflection and improvement proposal generation (Fase 5)."""


# ── Convenience sets ──────────────────────────────────────────────────────────

TERMINAL_PHASES: frozenset[Phase] = frozenset({Phase.CLOSE, Phase.FAILED})
"""Phases from which no automatic transition is expected."""

ACTIVE_PHASES: frozenset[Phase] = frozenset({
    Phase.SPEC, Phase.PLAN, Phase.DISPATCH, Phase.COLLECT,
    Phase.SECURITY_HARDENING, Phase.SWARM_DEBATE,
})
"""Phases that count as "actively working" for concurrency limits."""

BLOCKING_PHASES: frozenset[Phase] = frozenset({Phase.BLOCKED, Phase.NEEDS_HUMAN_REVIEW})
"""Phases that require human intervention before the orchestrator may advance."""
