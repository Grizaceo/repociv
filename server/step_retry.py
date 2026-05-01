"""RepoCiv — Step Retry with FrugalGPT Cascade Escalation (Fase 2).

Automatic retry logic for agent steps with progressive model escalation.
Each retry uses the next model in the FrugalGPT cascade chain, which varies
based on signal extraction, system health, and budget pressure.

The cascade chain is now *dynamic* — computed by the router and passed in
step_meta["model_routing"]["fallback_chain"].

Public API:
  escalate_model(current_model, fallback_chain) -> str
  retry_step(executor_fn, repo, issue_id, step, step_meta, max_retries) -> (run_id, attempts)
"""
from __future__ import annotations

import time
from typing import Any, Callable

# Legacy escalation chain (fallback if routing info unavailable)
_FALLBACK_ESCALATION_CHAIN: list[str] = [
    "claude-haiku-3-5",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
]

# Maximum consecutive failures before the circuit breaker trips (from orchestrator)
MAX_CONSECUTIVE_FAILURES = 3


def escalate_model(current_model: str, fallback_chain: list[str] | None = None) -> str:
    """Return the next more capable model in the escalation chain (Fase 2).

    Args:
        current_model: The current model name (e.g. "claude-haiku-3-5").
        fallback_chain: The cascade chain from router (e.g. ["haiku", "sonnet", "opus"]).
                       If None, uses the legacy static chain.

    Returns:
        The next model in the chain. Returns the same model if already at the ceiling
        or if the model is not recognised.

    Examples:
        >>> escalate_model("claude-haiku-3-5", ["haiku", "sonnet", "opus"])
        'claude-sonnet-4-5'
        >>> escalate_model("claude-sonnet-4-5", ["sonnet", "opus"])
        'claude-opus-4-5'
        >>> escalate_model("claude-opus-4-5", ["opus"])
        'claude-opus-4-5'  # ceiling
    """
    chain = fallback_chain or _FALLBACK_ESCALATION_CHAIN
    
    try:
        # Try exact match first
        idx = chain.index(current_model)
    except ValueError:
        # Try substring match (e.g. "haiku" in "claude-haiku-3-5")
        for i, model_name in enumerate(chain):
            if model_name in current_model.lower():
                idx = i
                break
        else:
            # Unknown model — return unchanged
            return current_model

    # Clamp to ceiling
    next_idx = min(idx + 1, len(chain) - 1)
    return chain[next_idx]


def _backoff(attempt: int) -> float:
    """Return backoff seconds: min(2^attempt, 10)."""
    return min(2 ** attempt, 10)



def retry_step(
    executor_fn: Callable[..., str],
    repo: str,
    issue_id: str,
    step: str,
    step_meta: dict[str, Any],
    max_retries: int = 2,
) -> tuple[str, int]:
    """Execute a step with automatic retry and FrugalGPT cascade escalation (Fase 2).

    On each retry:
    - The model is escalated to the next in the cascade chain (from router).
    - step_meta["model"] is updated with the escalated model.
    - An escalation record is injected into step_meta["_escalations"] list.
    - A simple exponential backoff is applied.

    Args:
        executor_fn:  Callable(repo, issue_id, step, step_meta) -> run_id.
                      Raises on failure; returns a run_id string on success.
        repo:         Repository name.
        issue_id:     Issue identifier.
        step:         Step description text.
        step_meta:    Dict with step metadata (stepIndex, totalSteps, model, 
                      model_routing, ...).
                      Mutated in-place with escalation info on each retry.
        max_retries:  Maximum number of retry attempts (default 2).

    Returns:
        (run_id, attempts_used)
        - run_id: The run_id returned by executor_fn on success.
        - attempts_used: Total attempts made (1 = success on first try,
          2 = succeeded on first retry, etc.).

    Raises:
        The last exception raised by executor_fn if all retries are exhausted.
    """
    last_exc: Exception | None = None

    # Extract the cascade chain from the router's decision (Fase 2)
    cascade_chain = (
        step_meta.get("model_routing", {}).get("fallback_chain")
        or _FALLBACK_ESCALATION_CHAIN
    )

    for attempt in range(max_retries + 1):
        # On retries, escalate the model using the cascade chain
        if attempt > 0:
            current_model = str(step_meta.get("model", "claude-haiku-3-5"))
            new_model = escalate_model(current_model, cascade_chain)
            step_meta["model"] = new_model

            # Record the escalation in an audit trail
            escalations: list[dict[str, Any]] = step_meta.setdefault("_escalations", [])
            escalations.append({
                "attempt": attempt,
                "fromModel": current_model,
                "toModel": new_model,
                "reason": f"Step failed on attempt {attempt}; escalating model for retry (Fase 2 FrugalGPT cascade)",
                "cascade_chain": cascade_chain,
            })

            # Backoff before retry
            time.sleep(_backoff(attempt))

        try:
            run_id = executor_fn(repo, issue_id, step, step_meta)
            return run_id, attempt + 1
        except Exception as exc:
            last_exc = exc
            # Continue to next attempt if retries remain

    # All retries exhausted — propagate the last exception
    assert last_exc is not None
    raise last_exc
