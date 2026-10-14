"""RepoCiv — durable dispatch ledger (R01 recoverable approval delivery).

The old authorization path consumed an approval from ``approval_store`` and
only afterwards enqueued the command into the scheduler. A crash, restart,
retry or duplicated HTTP/WS response inside that window could lose an
authorized command or run it twice.

This module makes the boundary recoverable *without* moving enqueue before
consume (which would open a re-execution window after restart) and without
introducing a second scheduler:

  1. ``record_intent``   — durable, atomic, idempotent write of the dispatch
                           intent for a stable command id, BEFORE the
                           approval is consumed.
  2. ``claim_intent``    — atomically claim that intent for the current
                           dispatch (consumption of the approval happens under
                           the same approval-store lock).
  3. ``done_intent``     — durable release of the intent once the command is
                           queued in the scheduler.
  4. ``recover_intents`` — replay unconsumed intents after a restart. An
                           intent whose approval is still pending is
                           re-dispatched through the same single-use consume
                           path (so a duplicate HTTP/WS response cannot
                           authorize it twice); an intent whose approval is
                           already gone was consumed before the crash and is
                           re-enqueued directly from the durable intent,
                           deduplicated against the persisted scheduler queue.

Invariants (see docs/DURABLE_APPROVAL_DELIVERY.md):

  - Every approval resolution first makes its intent durable.
  - A command is enqueued at most once at dispatch level: repeated HTTP/WS
    responses, worker retries, and restarts cannot enqueue a second runnable
    copy (``scheduler.enqueue`` and ``_init_from_disk`` deduplicate by id,
    and disk is re-checked when replaying intents).
  - An intent that cannot be resolved stays durable and is reported as
    unresolved for operator review; nothing disappears silently.
  - Deduplicated dispatch does NOT guarantee exactly-once external side
    effects — that limit is documented, not papered over.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_CONFIG_DIR_ENV = "REPOCIV_CONFIG_DIR"
_LEDGER_DIRNAME = "dispatch_ledger"
_SUFFIX = ".json"


def _ledger_dir() -> Path:
    base = os.environ.get(_CONFIG_DIR_ENV) or os.path.join(
        os.path.expanduser("~"), ".repociv"
    )
    return Path(base) / _LEDGER_DIRNAME


def _intent_path(command_id: str) -> Path:
    return _ledger_dir() / f"{command_id}{_SUFFIX}"


# ── Atomic durable write ─────────────────────────────────────────────────────
# The temp file must live on the same filesystem as the final path so that
# os.replace is atomic (no half-written intent can survive a crash).

def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _read_intent(path: Path) -> dict[str, Any] | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


# ── Public API ───────────────────────────────────────────────────────────────

def record_intent(command_id: str, cmd_dict: dict[str, Any]) -> None:
    """Durably record the dispatch intent for ``command_id``.

    Idempotent: an existing intent for the id is left untouched, so a retry
    or a duplicated response cannot duplicate or overwrite the durable state.
    Raises on I/O failure — the caller must not consume the approval when the
    intent is not durable.
    """
    path = _intent_path(command_id)
    if path.exists():
        return
    _atomic_write(path, {
        "commandId": command_id,
        "command": cmd_dict,
        "recordedAt": time.time(),
        "state": "intent",
    })


def claim_intent(command_id: str) -> bool:
    """Atomically claim the durable intent for the current dispatch.

    Returns True when this caller now owns the dispatch (claim written
    durably), False when the intent is already claimed or missing. A claim is
    what allows a restart to distinguish "consumed before the crash" from
    "never consumed".
    """
    path = _intent_path(command_id)
    if not path.exists():
        return False
    intent = _read_intent(path)
    if intent is None or intent.get("state") != "intent":
        return False
    intent["state"] = "claimed"
    intent["claimedAt"] = time.time()
    _atomic_write(path, intent)
    return True


def done_intent(command_id: str) -> None:
    """Release the durable intent once the command is in the scheduler queue.

    Best-effort by contract: the scheduler queue is itself durable, so a
    crash between enqueue and this call leaves a claimed intent that recovery
    replays idempotently (deduplicated by id against the persisted queue).
    """
    try:
        _intent_path(command_id).unlink()
    except FileNotFoundError:
        return
    except OSError:
        logger.exception(
            "Could not release dispatch intent %s; recovery will replay it", command_id
        )


def release_intent_if_unclaimed(command_id: str) -> None:
    """Delete the intent only while it is still an unclaimed ``intent``.

    Used when a consume attempt finds no approval (duplicate/expired response):
    nothing was authorized in THIS attempt, but another in-flight dispatcher
    may already own a claimed intent — that marker must survive, otherwise a
    crash window reopens. Callers must hold the consume lock.
    """
    path = _intent_path(command_id)
    intent = _read_intent(path)
    if intent is not None and intent.get("state") != "intent":
        return
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError:
        logger.exception(
            "Could not release unclaimed dispatch intent %s", command_id
        )


def unresolved() -> list[str]:
    """Command ids with a durable intent that was never claimed.

    These approvals were authorized but never consumed (a crash before the
    approval was taken). They stay pending in the approval store, remain
    visible for operator review, and are never silently dropped.
    """
    directory = _ledger_dir()
    if not directory.is_dir():
        return []
    out: list[str] = []
    for path in sorted(directory.glob(f"*{_SUFFIX}")):
        intent = _read_intent(path)
        if intent is None:
            # A corrupt/unreadable intent is unresolved too — never hidden.
            out.append(path.stem)
            continue
        if intent.get("state") == "intent":
            out.append(str(intent.get("commandId") or path.stem))
    return out


def _iter_intents() -> list[tuple[str, dict[str, Any]]]:
    directory = _ledger_dir()
    if not directory.is_dir():
        return []
    out: list[tuple[str, dict[str, Any]]] = []
    for path in sorted(directory.glob(f"*{_SUFFIX}")):
        intent = _read_intent(path)
        if intent is None:
            out.append((path.stem, {}))
            continue
        out.append((str(intent.get("commandId") or path.stem), intent))
    return out


def recover_intents() -> dict[str, list[str]]:
    """Replay durable dispatch intents after a bridge restart.

    For each intent:

      * ``intent``  — the approval was never consumed. Re-dispatch through the
        single-use ``resolve_approval`` path so a duplicated response still
        cannot authorize twice, and the approval store stays the gate.
      * ``claimed`` — the approval was consumed before the crash but the
        command may not have reached the scheduler. Re-enqueue directly from
        the durable intent, deduplicated against the persisted queue.

    Unreadable/corrupt intents are reported as unresolved, never replayed.

    Returns ``{"redispatched": [...], "enqueued": [...], "unresolved": [...]}``.
    """
    from server import approval_store  # noqa: PLC0415 (import cycle at module load)
    from server import scheduler  # noqa: PLC0415

    redispatched: list[str] = []
    enqueued: list[str] = []
    unresolved_ids: list[str] = []

    for command_id, intent in _iter_intents():
        if not intent:
            logger.error(
                "Dispatch intent for %s is unreadable; left for operator review",
                command_id,
            )
            unresolved_ids.append(command_id)
            continue
        state = intent.get("state")
        if state == "intent":
            pending_copy, expired = approval_store._peek_pending(command_id)
            if pending_copy is not None:
                try:
                    result = approval_store.resolve_approval(
                        command_id, approved=True
                    )
                except Exception:
                    logger.exception(
                        "Could not re-dispatch intent %s; left unresolved",
                        command_id,
                    )
                    unresolved_ids.append(command_id)
                    continue
                if result.get("status") == "queued":
                    redispatched.append(command_id)
                else:
                    unresolved_ids.append(command_id)
                continue

            if expired:
                # Approval expired before consumption; release the intent so
                # it does not leak across restarts, and report unresolved once.
                release_intent_if_unclaimed(command_id)
                unresolved_ids.append(command_id)
                continue

            # The approval is no longer in approval_store and did not expire
            # there: it was already consumed by pop_approval before
            # claim_intent could complete (crash or I/O error in pop->claim).
            cmd_dict = intent.get("command")
            if not isinstance(cmd_dict, dict):
                release_intent_if_unclaimed(command_id)
                unresolved_ids.append(command_id)
                continue
            if (
                ("expires_at" in cmd_dict or "expiresAt" in cmd_dict)
                and approval_store._expiry_reason(cmd_dict, time.time()) is not None
            ):
                release_intent_if_unclaimed(command_id)
                unresolved_ids.append(command_id)
                continue
            queued_cmd = {
                **cmd_dict,
                "requires_approval": False,
                "status": "queued",
            }
            try:
                enqueued_ids = scheduler.enqueue_dict(queued_cmd)
            except Exception:
                logger.exception(
                    "Could not enqueue consumed intent %s; left unresolved",
                    command_id,
                )
                unresolved_ids.append(command_id)
                continue
            if enqueued_ids:
                enqueued.append(command_id)
            done_intent(command_id)
        elif state == "claimed":
            cmd_dict = intent.get("command")
            if not isinstance(cmd_dict, dict):
                unresolved_ids.append(command_id)
                continue
            queued_cmd = {
                **cmd_dict,
                "requires_approval": False,
                "status": "queued",
            }
            try:
                enqueued_ids = scheduler.enqueue_dict(queued_cmd)
            except Exception:
                logger.exception(
                    "Could not re-enqueue claimed intent %s; left unresolved",
                    command_id,
                )
                unresolved_ids.append(command_id)
                continue
            if enqueued_ids:
                enqueued.append(command_id)
                done_intent(command_id)
            else:
                # Already durable in the scheduler queue — release the intent.
                done_intent(command_id)
        else:
            unresolved_ids.append(command_id)

    return {
        "redispatched": redispatched,
        "enqueued": enqueued,
        "unresolved": unresolved_ids,
    }


def reset_for_tests() -> None:
    """Delete every durable intent (test isolation only)."""
    import shutil  # noqa: PLC0415

    directory = _ledger_dir()
    if directory.is_dir():
        shutil.rmtree(directory, ignore_errors=True)
