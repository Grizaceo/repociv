"""RepoCiv — P4: Production step executor — wires orchestrator to agent dispatch.

Connects task_orchestrator (P3) to agent_runner (SCOUT/WORKER/DAVI).
Provides dispatch_plan_step for injection via _to.set_step_executor().
"""

from __future__ import annotations

import concurrent.futures
import uuid
from typing import Any

from . import agent_runner as _agent_runner
from . import model_router as _mr
from . import workspace_issue as _wi
from . import step_retry as _sr

STEP_TIMEOUT = 300  # default per-step timeout in seconds


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


def select_agent_for_step(step_description: str) -> str:
    """Heuristic: SCOUT for analysis/inspection, WORKER for implementation, DAVI as fallback.

    Examples:
        "inspect the codebase"     → "SCOUT"
        "implement login handler"  → "WORKER"
        "discuss roadmap"          → "DAVI"
    """
    step_lower = step_description.lower()
    for kw in SCOUT_KEYWORDS:
        if kw in step_lower:
            return "SCOUT"
    for kw in WORKER_KEYWORDS:
        if kw in step_lower:
            return "WORKER"
    return "DAVI"


def _infer_task_type(agent: str) -> str:
    """Map agent type to a default task_type for model routing."""
    mapping = {
        "DAVI": "orchestrate",
        "WORKER": "edit",
        "SCOUT": "read",
        "HERMES": "orchestrate",
        "OPENCLAW": "edit",
        "LEXO": "read",
    }
    return mapping.get(agent.upper(), "edit")


# ─── Mission builder ──────────────────────────────────────────────────────────

_MAX_PRIOR_TOKENS = 3_000   # rough char cap for prior artifact context
_MAX_PRIOR_ARTIFACTS = 3    # max number of prior step outputs to include


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
) -> str:
    """Build a self-contained agent mission from a plan step + issue spec context.

    If ``prior_artifacts`` is provided, relevant outputs from previous steps are
    included so the agent doesn't start blind.
    The mission is designed to be self-sufficient — the agent should NOT need
    to ask clarifying questions.
    """
    base = (
        "Ejecutá esta tarea del plan de implementación:\n\n"
        f"{step}\n\n"
        "Contexto adicional del spec del issue:\n"
        f"{spec_context}\n\n"
    )

    if prior_artifacts:
        relevant = _select_relevant_artifacts(
            prior_artifacts, _MAX_PRIOR_TOKENS, _MAX_PRIOR_ARTIFACTS
        )
        if relevant:
            sections = "\n\n".join(
                f"### {name}\n{content}" for name, content in relevant
            )
            base += f"Artefactos de pasos anteriores (contexto acumulativo):\n{sections}\n\n"

    base += "Entregá el resultado directamente. No preguntes; ejecutá y reportá."
    return base


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
    """
    run_id = f"step-{uuid.uuid4().hex[:8]}"

    # Build mission with issue context + prior step artifacts for context seeding
    try:
        spec = _wi.read_spec(repo, issue_id)
    except Exception:
        spec = step_description  # fallback: use step itself as context

    step_idx = int(step_meta.get("stepIndex", 0))
    prior_artifacts = _wi.read_output_artifacts(repo, issue_id, up_to_step=step_idx)
    mission = build_step_mission(step_description, spec, prior_artifacts)

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

    # SCOUT and WORKER use retry_step for automatic model escalation on failure.
    # HERMES and OPENCLAW are not escalated (enforced=False — the user chooses).
    _should_retry = routing["enforced"] and agent.upper() in ("SCOUT", "WORKER")

    def _run_agent_once(
        _repo: str, _issue_id: str, _step: str, _meta: dict,
    ) -> str:
        _rid = f"step-{uuid.uuid4().hex[:8]}"
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
        # Direct dispatch (no retry) for HERMES, OPENCLAW, DAVI, etc.
        run_id = _run_agent_once(repo, issue_id, step_description, step_meta)

    return run_id
