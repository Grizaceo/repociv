"""RepoCiv — first-launch approval for harnesses that bypass their own sandbox.

``execute_agent`` is ``auto-safe`` (typing and sending a chat message *is* the
consent), but Claude Code, Codex and Cursor are launched with
``--dangerously-skip-permissions`` / ``--dangerously-bypass-approvals-and-sandbox``
/ ``--trust``: once running they can do anything the operator can. The first
launch of each such harness on each city therefore goes through the approval
queue; an approved ``(harness, city)`` pair is remembered and later launches
stay one-step.

Opt out (legacy behavior): ``REPOCIV_TRUST_BYPASS_HARNESSES=1``.
State: ``<state root>/launch_trust.json`` (atomic writes).
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

from .atomic_io import atomic_write_json
from .state_paths import repociv_home

__all__ = ["BYPASS_HARNESSES", "bypass_harness_for", "is_trusted", "remember", "revoke"]

BYPASS_HARNESSES = frozenset({"claude", "codex", "cursor"})
_UNIT_BYPASS = {"CLAUDE": "claude", "CODEX": "codex", "CURSOR": "cursor"}
_lock = threading.Lock()


def _path() -> Path:
    return repociv_home() / "launch_trust.json"


def _normalize(harness: str) -> str:
    value = (harness or "").strip().lower()
    return "claude" if value == "claude-code" else value


def _configured_harness(unit: str, base: str) -> str:
    """The harness agent_runner would pick when the payload names none."""
    try:
        from . import config_store as _cs  # noqa: PLC0415

        profile = _cs.get_profile(unit) or _cs.get_profile(base) or _cs.get_profile(base.lower())
        if profile and profile.get("harness"):
            return _cs.normalize_harness_id(profile["harness"])
        if base == "MAIN":
            return _cs.get_default_harness() or ""
    except Exception:
        return ""
    return ""


def bypass_harness_for(payload: dict[str, Any], harness_id: str | None = None) -> str | None:
    """Return the sandbox-bypassing harness an execute_agent would launch, if any.

    Mirrors agent_runner's resolution order: unit bypass (CLAUDE/CODEX/CURSOR
    units) → payload/command harness → registry profile → MAIN default.
    """
    unit = str(payload.get("unit") or "")
    base = unit.split("-")[0].upper()
    if base in _UNIT_BYPASS:
        return _UNIT_BYPASS[base]
    harness = _normalize(str(payload.get("harness") or harness_id or ""))
    if harness in ("", "auto"):
        harness = _normalize(_configured_harness(unit, base))
    return harness if harness in BYPASS_HARNESSES else None


def _key(harness: str, city: str) -> str:
    return f"{_normalize(harness)}::{city or 'main'}"


def _load() -> dict[str, Any]:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def opted_out() -> bool:
    return os.environ.get("REPOCIV_TRUST_BYPASS_HARNESSES", "").strip().lower() in ("1", "true", "yes")


def is_trusted(harness: str, city: str) -> bool:
    if opted_out():
        return True
    with _lock:
        return _key(harness, city) in _load()


def remember(harness: str, city: str, command_id: str = "") -> None:
    with _lock:
        data = _load()
        data[_key(harness, city)] = {"approvedAt": time.time(), "commandId": command_id}
        atomic_write_json(_path(), data, indent=2, sort_keys=True)


def revoke(harness: str, city: str) -> bool:
    with _lock:
        data = _load()
        removed = data.pop(_key(harness, city), None) is not None
        if removed:
            atomic_write_json(_path(), data, indent=2, sort_keys=True)
        return removed
