"""RepoCiv — Sprint B1: Model Router.

Routes AI model selection per agent type and task type.

Semántica:
  - Anthropic direct (claude-*): enforced=True — RepoCiv may force the model
  - Hermes/OpenClaw: enforced=False — only recommended_model in payload metadata
    (those agents have user memory and the user chooses the final model)

Public API:
  route_model(agent_type, task_type, context) -> {"model": str, "enforced": bool, "reason": str}
"""
from __future__ import annotations

from typing import Any

# ─── Routing table ────────────────────────────────────────────────────────────
# (agent_type, task_type) → (model, enforced, reason)
# Sentinel "*" means "any task_type".

_ROUTES: list[tuple[str, str, str, bool, str]] = [
    # agent_type    task_type       model                   enforced  reason
    ("DAVI",        "orchestrate",  "claude-opus-4-5",      True,  "DAVI orchestration requires highest capability"),
    ("WORKER",      "edit",         "claude-sonnet-4-5",    True,  "WORKER edits use balanced speed/quality"),
    ("SCOUT",       "read",         "claude-haiku-3-5",     True,  "SCOUT read tasks use fast/cheap model"),
    ("HERMES",      "*",            "claude-opus-4-5",      False, "HERMES has user memory; model is recommended only"),
    ("OPENCLAW",    "*",            "claude-sonnet-4-5",    False, "OPENCLAW has user memory; model is recommended only"),
]

# Fallback for unknown agent types with known task types
_TASK_FALLBACKS: dict[str, tuple[str, bool, str]] = {
    "orchestrate": ("claude-opus-4-5",   True,  "Unknown agent orchestration defaults to opus"),
    "edit":        ("claude-sonnet-4-5", True,  "Unknown agent edit defaults to sonnet"),
    "read":        ("claude-haiku-3-5",  True,  "Unknown agent read defaults to haiku"),
}

_DEFAULT = ("claude-sonnet-4-5", True, "Default routing: sonnet for unrecognised agent/task")


def route_model(agent_type: str, task_type: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return model routing decision for a given agent and task.

    Args:
        agent_type: e.g. "DAVI", "WORKER", "SCOUT", "HERMES", "OPENCLAW"
        task_type:  e.g. "orchestrate", "edit", "read"
        context:    Optional dict with additional context (currently unused,
                    reserved for future dynamic routing).

    Returns:
        {
          "model":    str,   — Anthropic model name
          "enforced": bool,  — True → set "model" in payload; False → "recommended_model" only
          "reason":   str,   — Human-readable routing rationale
        }
    """
    agent_upper = agent_type.upper() if agent_type else ""
    task_lower = task_type.lower() if task_type else ""

    for a, t, model, enforced, reason in _ROUTES:
        if a == agent_upper and (t == "*" or t == task_lower):
            return {"model": model, "enforced": enforced, "reason": reason}

    # Task-level fallback for unrecognised agents
    if task_lower in _TASK_FALLBACKS:
        model, enforced, reason = _TASK_FALLBACKS[task_lower]
        return {"model": model, "enforced": enforced, "reason": reason}

    model, enforced, reason = _DEFAULT
    return {"model": model, "enforced": enforced, "reason": reason}
