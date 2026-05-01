"""RepoCiv — Context Pack builder (Fase 6).

Builds a minimal, structured context dict that accompanies every dispatched
command so the executing agent doesn't start blind.

The pack is attached to cmd.payload['_context'] before dispatch.
It is read-only signal — the agent may use it but nothing in RepoCiv depends on
the agent honoring it.

Fase 1 addition: ``build_context_directives()`` emits the same information as
a list of ``ContextDirective`` objects, enabling TensorContext consumers to
incorporate context-pack data into budget-pruned prompts.
"""
from __future__ import annotations

from typing import Any


def build_context_pack(
    agent_id: str,
    target: str,
    event_store: Any,          # event_store module with read_events()
    max_events: int = 10,
) -> dict[str, Any]:
    """
    Return a minimal context dict for a mission.

    Fields:
      agent_id      — who is executing
      target        — repo/city id
      recent_events — last N events for this target
      last_status   — 'ok' | 'failed' | 'unknown'
      last_error    — last failure message, if any
      test_status   — 'passed' | 'failed' | 'unknown'
    """
    all_events = event_store.read_events(since=0, limit=500)

    # Filter events relevant to this target
    target_events = [
        e for e in all_events
        if target.lower() in str(e.get("command_id", "")).lower()
        or target.lower() in str(e.get("target", "")).lower()
        or target.lower() in str(e.get("payload", {}).get("city", "")).lower()
    ]

    recent = target_events[-max_events:] if target_events else []

    # Determine last outcome
    last_status = "unknown"
    last_error = ""
    for ev in reversed(all_events[-200:]):
        etype = ev.get("type", "")
        if etype == "CommandCompleted":
            last_status = "ok"
            break
        if etype == "CommandFailed":
            last_status = "failed"
            last_error = ev.get("error", ev.get("result", ""))
            break

    # Infer test status from recent completed run_tests events
    test_status = "unknown"
    for ev in reversed(all_events[-200:]):
        if ev.get("type") == "CommandCompleted" and "run_tests" in str(ev.get("command_id", "")):
            result = ev.get("result", "")
            test_status = "failed" if ("fail" in result.lower() or "error" in result.lower()) else "passed"
            break

    return {
        "agent_id":    agent_id,
        "target":      target,
        "recent_events": [_slim(e) for e in recent],
        "last_status": last_status,
        "last_error":  last_error,
        "test_status": test_status,
    }


def _slim(ev: dict[str, Any]) -> dict[str, Any]:
    """Keep only the fields that matter for agent context."""
    return {k: ev[k] for k in ("type", "ts", "command_id", "result", "error")
            if k in ev}


def build_context_directives(
    agent_id: str,
    target: str,
    event_store: Any,
    max_events: int = 10,
) -> "list[Any]":
    """Return context-pack data as a list of ContextDirective objects.

    Each distinct piece of context (recent events, last status, test status)
    is emitted as a separate ``ContextDirective`` with ``deontic='should_include'``
    so TensorContext consumers can budget-prune them independently.

    Returns an empty list if ``tensor_context`` is not importable.
    """
    try:
        from .tensor_context import ContextDirective, DEONTIC_SHOULD
    except ImportError:  # pragma: no cover
        return []

    pack = build_context_pack(agent_id, target, event_store, max_events)
    directives: list[ContextDirective] = []

    # Last status DC
    if pack["last_status"] != "unknown" or pack["last_error"]:
        status_text = f"Last command status: {pack['last_status']}"
        if pack["last_error"]:
            status_text += f"\nLast error: {pack['last_error']}"
        directives.append(ContextDirective(
            text=status_text,
            metadata={"source": "context_pack", "type": "last_status", "agent": agent_id},
            deontic=DEONTIC_SHOULD,
        ))

    # Test status DC
    if pack["test_status"] != "unknown":
        directives.append(ContextDirective(
            text=f"Test suite status: {pack['test_status']}",
            metadata={"source": "context_pack", "type": "test_status", "agent": agent_id},
            deontic=DEONTIC_SHOULD,
        ))

    # Recent events DC (combined into one to preserve temporal ordering)
    if pack["recent_events"]:
        import json as _json
        events_text = "Recent events for {}:\n{}".format(
            target,
            _json.dumps(pack["recent_events"], indent=2, ensure_ascii=False),
        )
        directives.append(ContextDirective(
            text=events_text,
            metadata={"source": "context_pack", "type": "recent_events", "agent": agent_id},
            deontic=DEONTIC_SHOULD,
        ))

    return directives
