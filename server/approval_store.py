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


def _approvals_path() -> Path:
    base = os.environ.get(_CONFIG_DIR_ENV) or os.path.join(
        os.path.expanduser("~"), ".repociv"
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


def _persist() -> None:
    path = _approvals_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(_approvals, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def add_approval(cmd_dict: dict[str, Any]) -> None:
    with _lock:
        store = _ensure_loaded()
        store[cmd_dict["id"]] = cmd_dict
        _persist()


def get_approvals() -> list[dict[str, Any]]:
    with _lock:
        return list(_ensure_loaded().values())


def pop_approval(cmd_id: str) -> dict[str, Any] | None:
    with _lock:
        store = _ensure_loaded()
        cmd = store.pop(cmd_id, None)
        if cmd is not None:
            _persist()
        return cmd


def reset_for_tests() -> None:
    """Clear in-memory cache and delete the on-disk file."""
    global _loaded, _approvals
    with _lock:
        _approvals = {}
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
    """Approve or reject a pending command. Shared by HTTP and WebSocket paths."""
    cmd_dict = pop_approval(cmd_id)
    if not cmd_dict:
        return {"ok": False, "error": "approval not found"}

    from server import event_store as es
    from server import scheduler as sched
    from server.command_schema import Command
    from server.sse_server import send_to_repociv

    if approved:
        es.record_approved(cmd_id)
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
        es.record_queued(cmd.id)
        sched.enqueue(cmd)
        msg = log_approved or f"Comando aprobado: {cmd.type}"
        send_to_repociv({"type": "log", "msg": msg, "level": "success"})
        return {"ok": True, "status": "queued", "commandId": cmd_id}

    es.record_rejected(cmd_id, reject_reason)
    msg = log_rejected or f"Comando rechazado: {cmd_dict.get('type')}"
    send_to_repociv({"type": "log", "msg": msg, "level": "warn"})
    return {"ok": True, "status": "rejected", "commandId": cmd_id}
