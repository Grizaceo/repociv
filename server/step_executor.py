"""RepoCiv — P4: Production step executor — wires orchestrator to agent dispatch.

Connects task_orchestrator (P3) to agent_runner (SCOUT/WORKER/DAVI).
Provides dispatch_plan_step for injection via _to.set_step_executor().
"""

from __future__ import annotations

import concurrent.futures
import uuid
from typing import Any

from . import agent_runner as _agent_runner
from . import workspace_issue as _wi

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


# ─── Mission builder ──────────────────────────────────────────────────────────

def build_step_mission(step: str, spec_context: str) -> str:
    """Build a self-contained agent mission from a plan step + issue spec context.

    The mission is designed to be self-sufficient — the agent should NOT need
    to ask clarifying questions.
    """
    return (
        "Ejecutá esta tarea del plan de implementación:\n\n"
        f"{step}\n\n"
        "Contexto adicional del spec del issue:\n"
        f"{spec_context}\n\n"
        "Entregá el resultado directamente. No preguntes; ejecutá y reportá."
    )


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

    # Build mission with issue context
    try:
        spec = _wi.read_spec(repo, issue_id)
    except Exception:
        spec = step_description  # fallback: use step itself as context
    mission = build_step_mission(step_description, spec)

    # Select agent — explicit in meta overrides heuristic
    agent = str(step_meta.get("agent") or select_agent_for_step(step_description))

    # Dispatch in thread so we can enforce a hard timeout.
    # run_agent() is synchronous and manages its own run_state/session lifecycle.
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            _agent_runner.run_agent,
            agent,               # unit_id
            repo,                # city_id
            mission,             # mission text
            "hero",              # agent_type
            run_id,              # command_id
        )
        try:
            future.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            raise TimeoutError(
                f"Step '{step_description[:80]}...' timed out after {timeout}s"
            )

    return run_id
