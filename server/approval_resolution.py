"""RepoCiv — approval resolution (R01 recoverable durable delivery).

Shared by the HTTP and WebSocket approval paths (``bridge.py`` and
``websocket_handler.py`` both call ``approval_store.resolve_approval``).

This module is the single place where an approval becomes a queued command.
The delivery boundary is made recoverable by the durable dispatch ledger
(``server/dispatch_ledger.py``) with this fixed order:

  1. ``record_intent``  — the intent becomes durable BEFORE the approval is
     consumed. A crash here leaves the approval pending: nothing is lost and
     nothing is authorized. An I/O failure raises before any authorization
     state moves.
  2. consume the approval (single-use pop, unchanged semantics).
  3. ``claim_intent``   — the durable intent records that consumption
     happened, so a restart can tell "consumed before the crash" apart from
     "never consumed".
  4. audit + enqueue in the existing scheduler (no second scheduler).
  5. ``done_intent``    — release the durable intent.

After a restart, ``dispatch_ledger.recover_intents()`` replays what is left:
unclaimed intents go back through the same single-use consume path (a
duplicated response still cannot authorize twice), and claimed intents are
re-enqueued directly, deduplicated by id against the persisted scheduler
queue. The documented limit stands: deduplicated dispatch does not guarantee
exactly-once external side effects.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

logger = logging.getLogger(__name__)

__all__ = ["dispatch_approved", "unresolved_dispatch_ids"]

_STATUS_QUEUED = "queued"

# Serializes "record durable intent → consume approval" so two concurrent
# responses for the same command cannot both reach the consume step. Held
# only for that short sequence; never held while enqueueing or auditing.
_consume_lock = threading.Lock()


def dispatch_approved(
    cmd_dict: dict[str, Any],
    *,
    log_approved: str | None = None,
) -> dict[str, Any]:
    """Consume, audit, and enqueue an approved command durably.

    ``cmd_dict`` is the pending command as it sits in the approval store. It
    is consumed here through the store's own single-use path. Returns the
    same response envelope ``resolve_approval`` has always returned.

    The intake order is deliberate:

      * the durable intent is recorded BEFORE the approval is consumed, so an
        I/O failure raises while the approval is still pending;
      * ``claim_intent`` runs before the audit/enqueue writes, so a crash
        between claim and enqueue leaves a durable "consumed" marker that
        restart recovery can replay without re-authorizing;
      * ``done_intent`` is best-effort — the scheduler queue is itself
        durable, and its idempotent enqueue makes a replay a no-op.
    """
    from server import dispatch_ledger  # noqa: PLC0415 (import cycle at module load)
    from server import event_store as es  # noqa: PLC0415
    from server import scheduler as sched  # noqa: PLC0415
    from server import sse_server  # noqa: PLC0415
    from server.command_schema import Command  # noqa: PLC0415

    command_id = str(cmd_dict.get("id", ""))

    # 1 — durable intent BEFORE consumption. Raises on I/O failure: the
    #     approval is still pending, so nothing is lost and nothing ran.
    # 2 — consume the approval (single-use). Serialized with the intent write
    #     so a duplicate response cannot slip a second consume through.
    with _consume_lock:
        dispatch_ledger.record_intent(command_id, cmd_dict)
        consumed = _pop_for_dispatch(command_id)
        if consumed is None:
            dispatch_ledger.release_intent_if_unclaimed(command_id)
            return {
                "ok": False,
                "error": "approval not found",
                "commandId": command_id,
            }
        cmd = Command(
            id=consumed["id"],
            type=consumed["type"],
            target=consumed["target"],
            payload=consumed.get("payload", {}),
            created_by=consumed.get("created_by", "user"),
            risk=consumed.get("risk", "medium"),
            requires_approval=False,
            status="queued",
            harness_id=consumed.get("harness_id"),
        )
        # 3 — durable marker: the approval was consumed before this point.
        dispatch_ledger.claim_intent(command_id)

    # 4 — audit + enqueue through the existing command path.
    es.record_approved(command_id)
    es.record_queued(cmd.id)
    try:
        sched.enqueue(cmd)
    except Exception:
        logger.exception(
            "Enqueue failed after claim for %s; intent stays durable for recovery",
            command_id,
        )
        raise
    if cmd.type == "execute_agent":
        # The operator approved a sandbox-bypassing launch on this city:
        # later launches of the same harness there stay one-step.
        from server import launch_trust  # noqa: PLC0415

        bypass = launch_trust.bypass_harness_for(cmd.payload or {}, cmd.harness_id)
        if bypass:
            try:
                launch_trust.remember(
                    bypass, str((cmd.payload or {}).get("city") or cmd.target or "main"), cmd.id,
                )
            except OSError:
                logger.warning("launch trust not persisted for %s", cmd.id)
    try:
        sse_server.send_to_repociv({
            "type": "log",
            "msg": log_approved or f"Comando aprobado: {cmd.type}",
            "level": "success",
        })
    except Exception:
        pass

    # 5 — release the durable intent. Best-effort: if it survives a crash,
    #     recovery replays it and the scheduler dedup makes that a no-op.
    dispatch_ledger.done_intent(command_id)
    return {"ok": True, "status": _STATUS_QUEUED, "commandId": command_id}


def _pop_for_dispatch(command_id: str) -> dict[str, Any] | None:
    """Consume the approval through the store's own single-use path.

    Kept as a thin seam so tests can inject failures at exactly this step
    (the "inject a failure after each durable write" criterion).
    """
    from server import approval_store  # noqa: PLC0415

    return approval_store.pop_approval(command_id)


def unresolved_dispatch_ids() -> list[str]:
    """Command ids whose durable intent was never claimed (operator review)."""
    from server import dispatch_ledger  # noqa: PLC0415

    return dispatch_ledger.unresolved()
