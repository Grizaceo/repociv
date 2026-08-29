"""RepoCiv — P4: Production step executor — wires orchestrator to agent dispatch.

Connects task_orchestrator (P3) to agent_runner (SCOUT/WORKER/MAIN).
Provides dispatch_plan_step for injection via _to.set_step_executor().

Security integration (Fase 1.5):
  - Pre-dispatch: SecurityHarness.pre_dispatch_gate() scans mission text
  - Post-execution: SecurityHarness.post_execution_audit() verifies output

Workspace safety invariants (Symphony §9.5 extraction):
  - Workspace key validation: repo + issue_id sanitised before any dispatch
  - Path traversal prevention: no '..', '/', '\\', '~' in workspace identifiers
"""

from __future__ import annotations

import concurrent.futures
import logging
import re
import uuid
from typing import Any

from . import agent_runner as _agent_runner
from . import model_router as _mr
from . import workspace_issue as _wi
from . import step_retry as _sr
from . import security_harness as _sec
from .tensor_context import ContextDirective, TensorContext, DEONTIC_MUST, DEONTIC_SHOULD

logger = logging.getLogger(__name__)

STEP_TIMEOUT = 300  # default per-step timeout in seconds
STALL_TIMEOUT_MS = 300_000  # 5 min — no events in this window → stall (Symphony §8.5A)
STALL_WARN_SECONDS = 120  # log warning when step exceeds this duration

# ─── Workspace safety invariants (Symphony §9.5 extraction) ──────────────────

# Only [A-Za-z0-9._-] — no path traversal, no shell metacharacters
_WORKSPACE_KEY_RE = re.compile(r'^[A-Za-z0-9._-]{1,128}$')


class WorkspaceSafetyError(ValueError):
    """Raised when workspace identifiers violate safety invariants.

    Prevents path traversal and sandbox escape. Aligned with Symphony §9.5.
    """


def _validate_workspace_safety(repo: str, issue_id: str) -> None:
    """Validate workspace identifiers before agent dispatch (Symphony §9.5).

    Invariants:
      1. repo in [A-Za-z0-9._-]{1,128} — no '..', '/', '~'
      2. issue_id in [A-Za-z0-9._-]{1,128} — no shell metacharacters
      3. Neither is empty

    Raises WorkspaceSafetyError on violation.
    """
    for label, value in (("repo", repo), ("issue_id", issue_id)):
        if not value:
            raise WorkspaceSafetyError(
                f"{label} must not be empty"
            )
        if not _WORKSPACE_KEY_RE.match(value):
            raise WorkspaceSafetyError(
                f"Invalid {label} {value!r}: "
                "only [A-Za-z0-9._-] allowed. "
                "Path traversal characters ('..', '/', '~') are rejected."
            )


# ─── Agent selection heuristic ────────────────────────────────────────────────

SCOUT_KEYWORDS: list[str] = [
    "analyze", "audit", "inspect", "review", "explore", "assess",
    "check", "scan", "survey", "evaluate", "examine", "investigate",
    "diagnose", "profile", "trace", "report", "understand", "study",
]

WORKER_KEYWORDS: list[str] = [
    "implement", "create", "build", "write", "fix", "add", "modify",
    "change", "update", "remove", "delete", "refactor", "extract",
    "wire", "connect", "install", "configure", "patch", "migrate",
    "deploy", "commit", "set up", "upgrade",
]


PRAETORIAN_KEYWORDS: list[str] = [
    # Narrow by design: generic planning/coordination stays with MAIN.
    # PRAETORIAN is for expensive deep reasoning after cheaper tiers fail.
    "root cause", "root-cause", "postmortem", "incident", "escalat",
    "arbitrat", "adjudicat", "trade-off", "tradeoff", "threat model",
    "failure mode", "risk analysis", "final design decision",
]


def select_agent_for_step(step_description: str) -> str:
    """Heuristic: SCOUT for analysis/inspection, WORKER for implementation,
    PRAETORIAN for deep reasoning, MAIN as fallback (the player, not a field unit).

    Examples:
        "inspect the codebase"     → "SCOUT"
        "implement login handler"  → "WORKER"
        "root cause of the flaky tests" → "PRAETORIAN"
        "discuss roadmap"          → "MAIN"
    """
    step_lower = step_description.lower()
    for kw in PRAETORIAN_KEYWORDS:
        if kw in step_lower:
            return "PRAETORIAN"
    for kw in SCOUT_KEYWORDS:
        if kw in step_lower:
            return "SCOUT"
    for kw in WORKER_KEYWORDS:
        if kw in step_lower:
            return "WORKER"
    return "MAIN"


def _infer_task_type(agent: str) -> str:
    """Map agent type to a default task_type for model routing."""
    mapping = {
        "MAIN":     "orchestrate",
        "HERMES":   "orchestrate",
        "WORKER":   "edit",
        "SCOUT":    "read",
        "PRAETORIAN": "orchestrate",
        "OPENCLAW": "edit",
        }
    return mapping.get(agent.upper(), "edit")


# ─── Mission builder ──────────────────────────────────────────────────────────

_MAX_PRIOR_TOKENS = 3_000   # rough char cap for prior artifact context
_MAX_PRIOR_ARTIFACTS = 3    # max number of prior step outputs to include
_MISSION_BUDGET_TOKENS = 4_000  # total token budget for assembled mission prompt


def _select_relevant_artifacts(
    artifacts: list[tuple[str, str]], max_chars: int, max_count: int
) -> list[tuple[str, str]]:
    """Return the most recent artifacts that fit within the char budget."""
    # Prefer the most recent (end of list). Iterate in reverse and pick until budget.
    selected: list[tuple[str, str]] = []
    remaining = max_chars
    for name, content in reversed(artifacts[-max_count:]):
        snippet = content[:remaining]
        selected.insert(0, (name, snippet))
        remaining -= len(snippet)
        if remaining <= 0:
            break
    return selected


def build_step_mission(
    step: str,
    spec_context: str,
    prior_artifacts: list[tuple[str, str]] | None = None,
    latest_handoff: dict[str, Any] | None = None,
) -> str:
    """Build a self-contained agent mission using TensorContext.

    Assembles the prompt from three layers:
      1. Base DC (must_include): step instruction + spec context header.
      2. Prior artifact DCs (should_include): accumulated outputs from earlier
         steps, capped by ``_MAX_PRIOR_TOKENS`` chars and ``_MAX_PRIOR_ARTIFACTS``
         entries, then budget-pruned to fit ``_MISSION_BUDGET_TOKENS``.
      3. Handoff DC (should_include): latest structured handoff from previous role.

    The assembled prompt is designed to be self-sufficient — the agent should
    not need to ask clarifying questions.
    """
    tc = TensorContext()

    # Base DC: step instruction + spec context header (always included)
    base_text = (
        "Ejecutá esta tarea del plan de implementación:\n\n"
        f"{step}\n\n"
        "Contexto adicional del spec del issue:\n"
        f"{spec_context}\n\n"
        "Entregá el resultado directamente. No preguntes; ejecutá y reportá."
    )
    base_dc = ContextDirective(
        text=base_text,
        metadata={"source": "step", "type": "instruction"},
        deontic=DEONTIC_MUST,
    )

    # Prior artifact DCs (should_include — pruned to fit remaining budget)
    extra_dcs: list[ContextDirective] = []
    if prior_artifacts:
        relevant = _select_relevant_artifacts(
            prior_artifacts, _MAX_PRIOR_TOKENS, _MAX_PRIOR_ARTIFACTS
        )
        for name, content in relevant:
            extra_dcs.append(ContextDirective(
                text=(
                    f"Artefactos de pasos anteriores (contexto acumulativo):"
                    f"\n### {name}\n{content}"
                ),
                metadata={"source": "artifact", "name": name, "type": "prior_output"},
                deontic=DEONTIC_SHOULD,
            ))

    # Handoff DC: structured context from previous role
    if latest_handoff:
        handoff_role = latest_handoff.get("role", "unknown")
        handoff_work = latest_handoff.get("completedWork", [])
        handoff_risks = latest_handoff.get("openRisks", [])
        handoff_next = latest_handoff.get("recommendedNextAction", "")
        handoff_text = (
            f"Handoff del rol anterior ({handoff_role}):\n"
            f"Trabajo completado: {', '.join(handoff_work) if handoff_work else '(ninguno)'}\n"
        )
        if handoff_risks:
            handoff_text += f"Riesgos abiertos: {', '.join(handoff_risks)}\n"
        if handoff_next:
            handoff_text += f"Acción recomendada: {handoff_next}\n"
        extra_dcs.append(ContextDirective(
            text=handoff_text,
            metadata={"source": "handoff", "role": handoff_role, "type": "role_handoff"},
            deontic=DEONTIC_SHOULD,
        ))

    return tc.build_mission_prompt(base_dc, extra_dcs, budget=_MISSION_BUDGET_TOKENS)


# ─── Step dispatcher (the main injection point) ───────────────────────────────

def dispatch_plan_step(
    repo: str,
    issue_id: str,
    step_description: str,
    step_meta: dict[str, Any],
    timeout: int = STEP_TIMEOUT,
) -> str:
    """Execute one plan step by dispatching to the appropriate agent.

    Args:
        repo:            Repository/city name (maps to agent working directory).
        issue_id:        Issue identifier for context.
        step_description: What the step should accomplish.
        step_meta:       Dict with stepIndex, totalSteps, and optional 'agent' override.
        timeout:         Seconds before raising TimeoutError.

    Returns:
        run_id (str) — the command_id / mission_id registered with agent_runner.

    Raises:
        TimeoutError: if the step exceeds the timeout.
        WorkspaceSafetyError: if repo or issue_id violate safety invariants.
    """
    # ── Workspace safety gate (Symphony §9.5) — must run before any dispatch
    _validate_workspace_safety(repo, issue_id)

    run_id = f"step-{uuid.uuid4().hex[:8]}"

    # Build mission with issue context + prior step artifacts for context seeding
    try:
        spec = _wi.read_spec(repo, issue_id)
    except Exception:
        spec = step_description  # fallback: use step itself as context

    step_idx = int(step_meta.get("stepIndex", 0))
    prior_artifacts = _wi.read_output_artifacts(repo, issue_id, up_to_step=step_idx)
    latest_handoff = _wi.read_latest_handoff(repo, issue_id)
    mission = build_step_mission(step_description, spec, prior_artifacts, latest_handoff)

    # ── Security Layer 1: Pre-dispatch Gate (Fase 1.5) ────────────────────
    harness = _sec.get_harness()
    gate = harness.pre_dispatch_gate(mission)
    if gate.blocked:
        logger.warning(
            "SecurityHarness BLOCKED mission [%s] incident=%s reason=%s",
            run_id, gate.incident_level, gate.reason,
        )
        raise RuntimeError(
            f"Security gate blocked dispatch: {gate.reason}"
        )
    elif gate.findings:
        logger.info(
            "SecurityHarness: %d findings (not blocking) for %s",
            len(gate.findings), run_id,
        )

    # Select agent — explicit in meta overrides heuristic
    agent = str(step_meta.get("agent") or select_agent_for_step(step_description))

    # Model routing — determine which model to use for this agent/task.
    # task_type can be overridden in step_meta; default inferred from agent role.
    task_type = str(step_meta.get("task_type") or _infer_task_type(agent))
    routing = _mr.route_model(agent, task_type, context={"repo": repo, "issue_id": issue_id})

    # Build an enriched meta copy with routing info for the caller/orchestrator.
    step_meta = dict(step_meta)  # copy to avoid mutating caller's dict
    step_meta["model_routing"] = routing
    # Propagate enforced/recommended keys so downstream consumers know which
    # field to inject into their agent payload.
    if routing["enforced"]:
        step_meta["model"] = routing["model"]
    else:
        step_meta["recommended_model"] = routing["model"]

    # A3: warn when the provider is nebius but the unit is a harness bypass
    # (CLAUDE/CODEX/CURSOR/OPENCLAW) — those runners bypass the Nebius direct
    # path by design; the mission still runs via the selected harness.
    try:
        from server.signal_extractor import get_inference_provider
        if get_inference_provider() == "nebius" and agent.upper() in {"CLAUDE", "CODEX", "CURSOR", "OPENCLAW"}:
            logger.info(
                "provider=nebius but agent %s uses a harness bypass runner — "
                "Nebius direct path not applicable for this step",
                agent,
            )
    except Exception:
        pass

    # SCOUT and WORKER use retry_step for automatic model escalation on failure.
    # HERMES and OPENCLAW are not escalated (enforced=False — the user chooses).
    _should_retry = routing["enforced"] and agent.upper() in ("SCOUT", "WORKER")

    def _run_agent_once(
        _repo: str, _issue_id: str, _step: str, _meta: dict,
    ) -> str:
        _rid = f"step-{uuid.uuid4().hex[:8]}"
        # Fresh-telemetry invariant: forget any previous nebius result so
        # last_nebius_run() only ever reflects THIS step's dispatch.
        _agent_runner.clear_last_nebius_run()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as _executor:
            _future = _executor.submit(
                _agent_runner.run_agent,
                agent,    # unit_id
                _repo,    # city_id
                mission,  # mission text (built once, reused across retries)
                "hero",   # agent_type
                _rid,     # command_id
            )
            try:
                _future.result(timeout=timeout)
            except concurrent.futures.TimeoutError:
                raise TimeoutError(
                    f"Step '{_step[:80]}...' timed out after {timeout}s"
                )
        return _rid

    if _should_retry:
        run_id, _attempts = _sr.retry_step(
            _run_agent_once, repo, issue_id, step_description, step_meta,
        )
    else:
        # Direct dispatch (no retry) for HERMES, OPENCLAW, MAIN, etc.
        run_id = _run_agent_once(repo, issue_id, step_description, step_meta)

    # ── A5: surface routing telemetry on the step event ─────────────────────
    # Attach provider/model/latency/cost of the ACTIVE runtime for this step.
    # last_nebius_run() is only trusted because it was cleared just before
    # dispatch below — a stale nebius result from a previous step must never
    # be attributed to a step that ran on another provider.
    try:
        from server import agent_runner as _ar_a5
        from server import event_store as _es_a5
        from server import signal_extractor as _se_a5
        _neb = _ar_a5.last_nebius_run()
        _meta_telemetry: dict[str, Any]
        if _neb:
            _meta_telemetry = {
                "provider": "nebius",
                "model": str(_neb.get("model", "")),
                "latency_ms": int(_neb.get("latency_ms", 0) or 0),
                "cost_usd": float(_neb.get("cost_usd", 0.0) or 0.0),
                "fallback_from": _neb.get("fallback_from"),
                "unit_id": str(_neb.get("unit_id", "")),
                "base_url": str(_neb.get("base_url", "")),
            }
            _es_a5.record_event(
                "inference_telemetry",
                {
                    "run_id": run_id,
                    "provider": "nebius",
                    "model": _meta_telemetry["model"],
                    "latency_ms": _meta_telemetry["latency_ms"],
                    "cost_usd": _meta_telemetry["cost_usd"],
                    "fallback_from": _meta_telemetry["fallback_from"],
                },
            )
        else:
            _meta_telemetry = {
                "provider": _se_a5.get_inference_provider(),
                "model": routing["model"],
            }
        step_meta["inference_telemetry"] = _meta_telemetry
    except Exception as _telem_err:  # telemetry must never break a step
        logger.warning("telemetry attach failed for %s: %s", step_description[:60], _telem_err)

    # ── Write handoff artifact ──────────────────────────────────────────────
    try:
        handoff_payload = {
            "completed_work": [step_description],
            "commands_run": [f"agent:{agent}", f"run_id:{run_id}"],
            "files_changed": [],
            "tests_run": [],
            "open_risks": [],
            "known_failures": [],
            "recommended_next_role": _infer_next_role(agent),
            "recommended_next_action": f"Continue with step {step_idx + 1}" if step_idx < int(step_meta.get("totalSteps", 0)) - 1 else "Validate and complete",
        }
        _wi.write_handoff(repo, issue_id, f"step{step_idx}", agent, handoff_payload)
    except Exception as e:
        logger.warning("Failed to write handoff for %s/%s step %d: %s", repo, issue_id, step_idx, e)

    return run_id


def _infer_next_role(current_agent: str) -> str:
    """Infer the next role in the pipeline based on the current agent."""
    role_map = {
        "SCOUT": "WORKER",
        "WORKER": "VALIDATOR",
        "VALIDATOR": "MAIN",
    }
    return role_map.get(current_agent.upper(), "MAIN")
