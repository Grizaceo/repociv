"""RepoCiv — disk-backed approval queue (Module M8).

Pending commands that require human approval are persisted to
``$REPOCIV_CONFIG_DIR/approvals.json`` so they survive bridge restarts.

The in-memory cache is the source of truth within a process; disk is
written atomically on every mutation.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

_CONFIG_DIR_ENV = "REPOCIV_CONFIG_DIR"
_APPROVALS_FILENAME = "approvals.json"

_lock = threading.Lock()
_loaded = False
_approvals: dict[str, dict[str, Any]] = {}
_resolving: set[str] = set()


def _approvals_path() -> Path:
    base = (
        os.environ.get("REPOCIV_STATE_DIR")
        or os.environ.get("REPOCIV_DATA_DIR")
        or os.environ.get(_CONFIG_DIR_ENV)
        or os.path.join(os.path.expanduser("~"), ".repociv")
    )
    return Path(base) / _APPROVALS_FILENAME


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
    _loaded = True
    return _approvals


def _persist(data: dict[str, dict[str, Any]] | None = None) -> None:
    payload = _approvals if data is None else data
    path = _approvals_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def add_approval(cmd_dict: dict[str, Any]) -> None:
    with _lock:
        store = _ensure_loaded()
        candidate = dict(store)
        candidate[cmd_dict["id"]] = cmd_dict
        _persist(candidate)
        store.clear()
        store.update(candidate)


def get_approvals() -> list[dict[str, Any]]:
    with _lock:
        return list(_ensure_loaded().values())


def peek_approval(cmd_id: str) -> dict[str, Any] | None:
    with _lock:
        command = _ensure_loaded().get(cmd_id)
        return dict(command) if command is not None else None


def _claim_approval(cmd_id: str) -> dict[str, Any] | None:
    with _lock:
        if cmd_id in _resolving:
            return None
        command = _ensure_loaded().get(cmd_id)
        if command is None:
            return None
        _resolving.add(cmd_id)
        return dict(command)


def _release_claim(cmd_id: str) -> None:
    with _lock:
        _resolving.discard(cmd_id)


def pop_approval(cmd_id: str) -> dict[str, Any] | None:
    with _lock:
        store = _ensure_loaded()
        command = store.get(cmd_id)
        if command is None:
            return None
        candidate = dict(store)
        candidate.pop(cmd_id, None)
        _persist(candidate)
        store.clear()
        store.update(candidate)
        return dict(command)


def reset_for_tests() -> None:
    """Clear in-memory cache and delete the on-disk file."""
    global _loaded, _approvals
    with _lock:
        _approvals = {}
        _resolving.clear()
        _loaded = True
        path = _approvals_path()
        if path.exists():
            path.unlink()


def resolve_approval(
    cmd_id: str,
    *,
    approved: bool,
    reject_reason: str = "user rejected",
    log_approved: str | None = None,
    log_rejected: str | None = None,
) -> dict[str, Any]:
    """Resolve one approval claim exactly once per process."""
    cmd_dict = _claim_approval(cmd_id)
    if cmd_dict is None:
        return {"ok": False, "error": "approval not found"}
    try:
        return _resolve_claimed(
            cmd_dict,
            cmd_id,
            approved=approved,
            reject_reason=reject_reason,
            log_approved=log_approved,
            log_rejected=log_rejected,
        )
    finally:
        _release_claim(cmd_id)


def _resolve_claimed(
    cmd_dict: dict[str, Any],
    cmd_id: str,
    *,
    approved: bool,
    reject_reason: str,
    log_approved: str | None,
    log_rejected: str | None,
) -> dict[str, Any]:
    from server import event_store as es
    from server import scheduler as sched
    from server.command_schema import Command
    from server.sse_server import send_to_repociv

    if approved:
        cmd = Command(
            id=cmd_dict["id"],
            type=cmd_dict["type"],
            target=cmd_dict["target"],
            payload=cmd_dict.get("payload", {}),
            created_by=cmd_dict.get("created_by", "user"),
            risk=cmd_dict.get("risk", "medium"),
            requires_approval=False,
            status="queued",
        )
        try:
            sched.enqueue(cmd)
        except Exception as exc:
            return {
                "ok": False,
                "status": "waiting_approval",
                "commandId": cmd_id,
                "error": f"enqueue failed: {exc}",
            }
        es.record_approved(cmd_id)
        es.record_queued(cmd.id)
        warning = ""
        try:
            pop_approval(cmd_id)
        except Exception as exc:
            warning = f"approval cleanup pending: {exc}"
        msg = log_approved or f"Comando aprobado: {cmd.type}"
        send_to_repociv({"type": "log", "msg": msg, "level": "success"})
        result = {"ok": True, "status": "queued", "commandId": cmd_id}
        if warning:
            result["warning"] = warning
        return result

    es.record_rejected(cmd_id, reject_reason)
    warning = ""
    try:
        pop_approval(cmd_id)
    except Exception as exc:
        warning = f"approval cleanup pending: {exc}"
    msg = log_rejected or f"Comando rechazado: {cmd_dict.get('type')}"
    send_to_repociv({"type": "log", "msg": msg, "level": "warn"})
    result = {"ok": True, "status": "rejected", "commandId": cmd_id}
    if warning:
        result["warning"] = warning
    return result
