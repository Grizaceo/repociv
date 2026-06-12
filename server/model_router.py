"""RepoCiv — Model Router (Fase 2).

Dynamic model routing with FrugalGPT cascade, signal extraction, and believability weighting.

Public API (Fase 2):
  route_model(agent_type, task_type, context) -> {
    "model": str,              — Starting model for this dispatch
    "cascade": bool,           — If True, use fallback chain on failure
    "fallback_chain": list,    — [haiku, sonnet, opus] in escalation order
    "enforced": bool,          — True if model is forced; False if recommended
    "reason": str,             — Human-readable routing rationale
    "tier": str,               — "ECONOMICO", "EQUILIBRIO", or "PREMIUM"
  }

Cascade logic (FrugalGPT pattern):
  1. Extract signals from mission_text (keywords, urgency, complexity, etc.)
  2. Check budget pressure and system health
  3. Apply believability weighting for unreliable agents
  4. Recommend starting tier → convert to model + cascade chain
  5. If first model fails, retry with next in chain (with configurable backoff)

Integration points:
  - SignalExtractor: keyword-based signal analysis
  - TokenLedger: budget pressure (tokens used % of limit)
  - ResearchLedger: agent believability scores
  - System health checks: reserved for future CPU/memory integration
"""
from __future__ import annotations

import logging
from typing import Any

from . import signal_extractor as _se

logger = logging.getLogger(__name__)

# ─── Base agent→tier affinity (overridable by signals) ──────────────────────

_BASE_TIERS: dict[str, str] = {
    "hermes":   "PREMIUM",
    "WORKER":   "EQUILIBRIO",
    "SCOUT":    "ECONOMICO",
    "HERMES":   "PREMIUM",
    "OPENCLAW": "EQUILIBRIO",
}

_BASE_ENFORCED: dict[str, bool] = {
    "hermes":   False,
    "WORKER":   True,
    "SCOUT":    True,
    "HERMES":   False,
    "OPENCLAW": False,
}

_DEFAULT_BASE_TIER = "EQUILIBRIO"
_DEFAULT_ENFORCED = True

_TASK_TIER: dict[str, str] = {
    "orchestrate": "PREMIUM",
    "edit": "EQUILIBRIO",
    "read": "ECONOMICO",
}



def _get_ledgers() -> tuple[Any, Any]:
    """Lazy-import ledgers to avoid circular dependencies.

    Returns:
        (token_ledger, research_ledger) or (None, None) if not available.
    """
    try:
        from . import token_ledger as _tl
        from . import research_ledger as _rl
        return (_tl.get_instance(), _rl.get_instance())
    except (ImportError, AttributeError):
        return (None, None)


def _check_system_health() -> bool:
    """Check if system is overloaded. Currently a stub; reserved for CPU/memory checks.

    Returns:
        False if system healthy, True if overloaded.
    """
    # TODO Fase 2+: integrate with psutil to check CPU/memory
    return False


def route_model(
    agent_type: str,
    task_type: str,
    context: dict[str, Any] | None = None,
    override_tier: str | None = None,
) -> dict[str, Any]:
    """Route to an optimal model using FrugalGPT cascade logic.

    Args:
        agent_type:    e.g. "MAIN", "WORKER", "SCOUT", "HERMES", "CLAUDE", "CODEX", "CURSOR", "OPENCLAW"
        task_type:     e.g. "orchestrate", "edit", "read"
        context:       Optional dict with:
          - "mission_text": str, for signal extraction
          - "budget_limit": int, for budget-based routing
        override_tier: Optional tier override for testing ("ECONOMICO", "EQUILIBRIO", "PREMIUM")

    Returns:
        {
          "model": str,                  — Starting Claude model
          "cascade": bool,               — Whether to use fallback chain
          "fallback_chain": list[str],   — Models in escalation order
          "enforced": bool,              — Whether model is forced
          "reason": str,                 — Routing rationale
          "tier": str,                   — Selected tier
        }
    """
    context = context or {}
    agent_upper = agent_type.upper() if agent_type else ""
    mission_text = context.get("mission_text", "")

    # ─── Step 1: Extract signals from mission text ────────────────────────────
    extractor = _se.SignalExtractor()
    signals = extractor.extract(mission_text)

    # ─── Step 2: Check budget pressure ────────────────────────────────────────
    token_ledger, research_ledger = _get_ledgers()
    budget_pct = 0.0
    budget_limit = context.get("budget_limit", 1_000_000)
    if token_ledger:
        budget_pct = token_ledger.get_budget_used_pct(budget_limit)

    # ─── Step 3: Check system health ──────────────────────────────────────────
    system_overloaded = _check_system_health()

    # ─── Step 4: Get base tier from agent affinity ────────────────────────────
    if override_tier:
        base_tier = override_tier
    else:
        if agent_upper in _BASE_TIERS:
            base_tier = _BASE_TIERS[agent_upper]
        else:
            # Unknown agent: use task_type as tier signal
            base_tier = _TASK_TIER.get(task_type, _DEFAULT_BASE_TIER)

    # ─── Step 5: Apply signal-driven adjustments ─────────────────────────────
    if not override_tier:  # Only adjust if not overridden
        adjusted_tier = extractor.recommend_tier(signals, budget_pct, system_overloaded)
        # Only override base_tier if actual signals drove the tier change.
        # "No signals" case returns "EQUILIBRIO" by default; we only escalate
        # if the mission had active signals (urgency, complexity, quality, cost).
        has_active_signals = (
            signals.urgency > 0
            or signals.complexity > 0
            or signals.is_quality_critical
            or signals.is_cost_critical
            or signals.is_debug_task
            or signals.is_creative_task
        )
        # Budget pressure (>80%) always wins even without textual signals
        is_budget_forced = budget_pct > 80.0 or system_overloaded
        if has_active_signals or is_budget_forced:
            tier_order = ["ECONOMICO", "EQUILIBRIO", "PREMIUM"]
            if tier_order.index(adjusted_tier) > tier_order.index(base_tier):
                base_tier = adjusted_tier

    # ─── Step 6: Apply believability weighting ───────────────────────────────
    final_tier = base_tier
    believability_penalty = ""
    if research_ledger:
        believability = research_ledger.get_agent_believability().get(agent_upper, 1.0)
        # If agent has < 50% believability, escalate to next tier
        if believability < 0.5:
            tier_order = ["ECONOMICO", "EQUILIBRIO", "PREMIUM"]
            if final_tier != "PREMIUM":
                idx = tier_order.index(final_tier)
                final_tier = tier_order[idx + 1]
                believability_penalty = f" (escalated due to agent believability {believability:.1%})"

    # ─── Step 7: Build routing response ───────────────────────────────────────
    model = _se.tier_to_model(final_tier)
    cascade_chain = _se.tier_to_cascade_chain(final_tier)
    enforced = _BASE_ENFORCED.get(agent_upper, _DEFAULT_ENFORCED)

    reason_parts = [
        f"agent={agent_upper}",
        f"task={task_type}",
        f"tier={final_tier}",
        f"budget_pct={budget_pct:.1f}%",
    ]
    if signals.is_quality_critical:
        reason_parts.append("quality_critical")
    if signals.is_cost_critical:
        reason_parts.append("cost_critical")
    if signals.complexity > 0.7:
        reason_parts.append(f"high_complexity={signals.complexity:.1f}")
    if believability_penalty:
        reason_parts.append(believability_penalty.strip())
    if not enforced:
        reason_parts.append("recommended")

    return {
        "model": model,
        "cascade": True,  # FrugalGPT always enables cascade
        "fallback_chain": cascade_chain,
        "enforced": enforced,
        "reason": " | ".join(reason_parts),
        "tier": final_tier,
    }


def get_agent_cards_path() -> str:
    """Return the path to the agent_cards directory (built-in agents only).

    Returns:
        Absolute path to server/agent_cards/ (WORKER, SCOUT)
    """
    from pathlib import Path
    return str(Path(__file__).parent / "agent_cards")


def get_harness_cards_path() -> str:
    """Return the path to the harness_cards directory.

    Returns:
        Absolute path to server/harness_cards/ (hermes, openclaw, codex, claude, cursor)
    """
    from pathlib import Path
    return str(Path(__file__).parent / "harness_cards")
