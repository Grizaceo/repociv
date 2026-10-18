"""RepoCiv — disk-backed approval queue (Module M8).

Pending commands that require human approval are persisted to
``$REPOCIV_CONFIG_DIR/approvals.json`` so they survive bridge restarts.

The in-memory cache is the source of truth within a process; disk is
written atomically on every mutation.
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from pathlib import Path
from typing import Any, TypeGuard
from server.state_paths import repociv_home

_CONFIG_DIR_ENV = "REPOCIV_CONFIG_DIR"
_APPROVALS_FILENAME = "approvals.json"
_TTL_ENV = "REPOCIV_APPROVAL_TTL_S"
_DEFAULT_TTL_S = 86400  # 24h

logger = logging.getLogger(__name__)


def _approval_ttl(raw: str) -> int:
    try:
        ttl = int(raw)
        if ttl > 0:
            return ttl
    except ValueError:
        pass
    logger.warning("Invalid %s; using default %ss", _TTL_ENV, _DEFAULT_TTL_S)
    return _DEFAULT_TTL_S


_APPROVAL_TTL_S = _approval_ttl(os.environ.get(_TTL_ENV, str(_DEFAULT_TTL_S)))

_lock = threading.Lock()
_loaded = False
_approvals: dict[str, dict[str, Any]] = {}
# Avoid duplicate audit on persistence retries within this process.
_expiry_audited: set[str] = set()


def _approvals_path() -> Path:
    return repociv_home() / _APPROVALS_FILENAME


def _ensure_loaded() -> dict[str, dict[str, Any]]:
    global _loaded, _approvals
    if _loaded:
        return _approvals
    path = _approvals_path()
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            _approvals = raw if isinstance(raw, dict) else {}
        except (OSError, json.JSONDecodeError, ValueError):
            _approvals = {}
    else:
        _approvals = {}
    # Migrate legacy deadlines once, persistently; never grant an infinite TTL.
    now = time.time()
    migrated = False
    for cmd in _approvals.values():
        if isinstance(cmd, dict) and "expires_at" not in cmd:
            created = cmd.get("created_at", now)
            cmd["expires_at"] = (
                min(created, now) + _APPROVAL_TTL_S if _valid_timestamp(created) else now
            )
            migrated = True
    if migrated:
        _persist()
    _loaded = True
    return _approvals


def _persist() -> None:
    path = _approvals_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(_approvals, indent=2, sort_keys=True))
    os.replace(tmp, path)
    os.chmod(path, 0o600)


def add_approval(cmd_dict: dict[str, Any]) -> None:
    with _lock:
        store = _ensure_loaded()
        cmd = dict(cmd_dict)
        if "expires_at" not in cmd and "expiresAt" in cmd:
            cmd["expires_at"] = cmd["expiresAt"]
        cmd.setdefault("expires_at", time.time() + _APPROVAL_TTL_S)
        store[cmd["id"]] = cmd
        _persist()


def _valid_timestamp(value: Any) -> TypeGuard[float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _expiry_reason(cmd: Any, now: float) -> str | None:
    if not isinstance(cmd, dict):
        return "invalid approval deadline"
    deadline = cmd.get("expires_at") if "expires_at" in cmd else cmd.get("expiresAt")
    if not _valid_timestamp(deadline):
        return "invalid approval deadline"
    return "approval expired" if deadline <= now else None


def _expire_locked(store: dict[str, dict[str, Any]], now: float) -> list[str]:
    """Audit and consume expired entries under the same lock as approval.

    Audit failure leaves the entry pending but unusable (all consumers recheck
    its deadline). Notifications are best-effort; disk + event log are truth.
    """
    from server import event_store as es
    from server.sse_server import send_to_repociv

    expired = []
    for cid, cmd in list(store.items()):
        reason = _expiry_reason(cmd, now)
        if reason is None:
            continue
        try:
            if cid not in _expiry_audited:
                es.record_rejected(cid, reason)
                _expiry_audited.add(cid)
            del store[cid]
            try:
                _persist()
            except Exception:
                store[cid] = cmd
                raise
        except Exception:
            logger.exception("Approval expiry cleanup failed for %s; remains unusable", cid)
            continue
        _expiry_audited.discard(cid)
        expired.append(cid)
        try:
            send_to_repociv({"type": "approval_expired", "commandId": cid, "reason": reason})
            send_to_repociv({"type": "log", "msg": f"Aprobación vencida: {cid}", "level": "warn"})
        except Exception:
            pass
    return expired


def expire_approvals() -> list[str]:
    """Run the expiry sweep even when no browser is connected."""
    with _lock:
        return _expire_locked(_ensure_loaded(), time.time())


def get_approvals() -> list[dict[str, Any]]:
    with _lock:
        store = _ensure_loaded()
        _expire_locked(store, time.time())
        now = time.time()
        return [dict(cmd) for cmd in store.values() if _expiry_reason(cmd, now) is None]


def pop_approval(cmd_id: str) -> dict[str, Any] | None:
    return _take_approval(cmd_id)[0]


def _take_approval(cmd_id: str) -> tuple[dict[str, Any] | None, bool]:
    with _lock:
        store = _ensure_loaded()
        expired = _expire_locked(store, time.time())
        if cmd_id in store and _expiry_reason(store[cmd_id], time.time()) is not None:
            return None, True
        cmd = store.pop(cmd_id, None)
        if cmd is not None:
            try:
                _persist()
            except Exception:
                store[cmd_id] = cmd
                raise
        return cmd, cmd_id in expired


def reset_for_tests() -> None:
    """Clear in-memory cache and delete the on-disk file."""
    global _loaded, _approvals
    with _lock:
        _approvals = {}
        _expiry_audited.clear()
        _loaded = True
        path = _approvals_path()
        if path.exists():
            path.unlink()


def cancel_mission(mission_id: str) -> list[dict[str, Any]]:
    """Cascade-cancel: reject every pending whose parent mission matches.

    Returns the list of removed pendings (empty if none matched). Matching
    is by ``payload.parentMissionId`` — the id already persisted by both
    approval paths (bridge ``_handle_command`` and subagent ``on_task_spawn``
    carry it inside the command payload). An empty mission_id matches
    nothing, so legacy pendings without a parent mission are never swept.
    Removal reuses the single-use atomic pop semantics of ``pop_approval``;
    persistence happens once for the whole cascade.
    """
    if not mission_id:
        return []
    with _lock:
        store = _ensure_loaded()
        _expire_locked(store, time.time())
        matches = []
        for cmd_id, cmd in store.items():
            if _expiry_reason(cmd, time.time()) is not None:
                continue
            payload = cmd.get("payload") if isinstance(cmd, dict) else None
            if isinstance(payload, dict) and (
                payload.get("parentMissionId") == mission_id
            ):
                matches.append(cmd_id)
        removed = []
        for cmd_id in matches:
            if cmd_id in store:
                removed.append(store.pop(cmd_id))
        if removed:
            _persist()
        return removed


def _peek_pending(cmd_id: str) -> tuple[dict[str, Any] | None, bool]:
    """Read-only check + snapshot of a pending approval without consuming it.

    Returns ``(cmd_copy, expired)``. Expired entries are swept and audited
    under ``_lock`` just like ``_take_approval``, but a valid pending entry
    remains in the store until ``pop_approval`` consumes it.
    """
    with _lock:
        store = _ensure_loaded()
        now = time.time()
        expired = _expire_locked(store, now)
        if cmd_id in store and _expiry_reason(store[cmd_id], now) is not None:
            return None, True
        cmd = store.get(cmd_id)
        if cmd is not None:
            return dict(cmd), False
        return None, cmd_id in expired


def resolve_approval(
    cmd_id: str,
    *,
    approved: bool,
    reject_reason: str = "user rejected",
    log_approved: str | None = None,
    log_rejected: str | None = None,
) -> dict[str, Any]:
    """Approve or reject a pending command. Shared by HTTP and WebSocket paths."""
    from server import approval_resolution
    from server import dispatch_ledger
    from server import event_store as es
    from server.sse_server import send_to_repociv

    if not approved:
        cmd_dict, expired = _take_approval(cmd_id)
        dispatch_ledger.release_intent_if_unclaimed(cmd_id)
        if not cmd_dict:
            if expired:
                return {
                    "ok": False,
                    "error": "approval expired",
                    "status": "expired",
                    "commandId": cmd_id,
                }
            return {"ok": False, "error": "approval not found"}
        es.record_rejected(cmd_id, reject_reason)
        msg = log_rejected or f"Comando rechazado: {cmd_dict.get('type')}"
        send_to_repociv({"type": "log", "msg": msg, "level": "warn"})
        return {"ok": True, "status": "rejected", "commandId": cmd_id}

    cmd_dict, expired = _peek_pending(cmd_id)
    if not cmd_dict:
        dispatch_ledger.release_intent_if_unclaimed(cmd_id)
        if expired:
            return {
                "ok": False,
                "error": "approval expired",
                "status": "expired",
                "commandId": cmd_id,
            }
        return {"ok": False, "error": "approval not found"}

    try:
        return approval_resolution.dispatch_approved(
            cmd_dict, log_approved=log_approved
        )
    except Exception:
        logger.exception(
            "Durable approval delivery failed for %s; left unresolved for operator review",
            cmd_id,
        )
        return {
            "ok": False,
            "status": "unresolved",
            "error": "dispatch intent not durable; command left for operator review",
            "commandId": cmd_id,
        }
