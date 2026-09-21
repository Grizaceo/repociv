"""RepoCiv — own-session snapshot for map re-materialization.

The client holds its own-session units only in memory: reload the page and the
unit vanishes from the map while the session (canonical.json + transcript) and
the Hermes conversation keep living server-side. Fases B/C of the HUD plan
(docs/plans/2026-09-19-hud-agentes-y-sesiones.md) made the session primary, so
the map must be able to re-materialize them after a reload.

This module answers one narrow question: which own sessions exist on disk, and
is the conversation behind each still live? Liveness reuses the exact Hermes
probe from ``session_liveness`` (lease registry + /proc), never ``ended_at`` —
Hermes closes the ``--source tool`` session at the end of every turn, so an
``ended_at``-based rule would despawn the unit after each completed mission
and break the resumable-chat model.

Fail-open everywhere: an unreadable store or probe degrades to fewer rows /
unknown liveness, never to a wrong despawn (the despawn decision is left to
explicit user action, out of scope here).
"""
from __future__ import annotations

import glob
import json
import os
from typing import Any

from . import session_liveness as _liveness

_STORE_DIR: str | None = None

_UNIT_TYPE_BY_RUNTIME = {
    "claude": "claude",
    "codex": "codex",
    "cursor": "cursor",
    "praetorian": "praetorian",
}


def init(store_dir: str | os.PathLike[str]) -> None:
    """Point the snapshot at the bridge's session store (store_dir/sessions)."""
    global _STORE_DIR
    _STORE_DIR = str(store_dir) + "/sessions"


def store_dir() -> str:
    if _STORE_DIR:
        return _STORE_DIR
    return os.path.join(
        os.environ.get("REPOCIV_CONFIG_DIR", os.path.expanduser("~/.repociv")),
        "sessions",
    )


def _canonical_paths() -> list[str]:
    try:
        return sorted(glob.glob(os.path.join(store_dir(), "*", "canonical.json")))
    except Exception:
        return []


def _unit_type(runtime_id: str) -> str:
    base = (runtime_id or "").split(":")[0].strip().lower()
    return _UNIT_TYPE_BY_RUNTIME.get(base, "hero")


def snapshot() -> dict[str, Any]:
    """Payload of GET /api/own-sessions.

    Rows carry what the client sync needs to rebuild a unit: id, civ, unit
    type, cityId (the repo id the bridge encodes for cities), mission summary
    and liveness state. Liveness values: ``working`` (the lease registry says
    the Hermes conversation is running), ``idle`` (it is not), or ``unknown``
    (probe degraded or no native session id recorded — the client keeps the
    previous state instead of guessing).
    """
    try:
        probe = _liveness.probe()
    except Exception:
        probe = _liveness.Liveness()  # degraded: every lookup answers None
    rows: list[dict[str, Any]] = []
    for path in _canonical_paths():
        dir_unit = os.path.basename(os.path.dirname(path))
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        unit = str(data.get("unitId") or dir_unit or "")
        if not unit:
            continue
        native = str(data.get("nativeSessionId") or "")
        live: bool | None = None
        if native:
            live = probe.live_for(source="hermes", native_id=native, cwd="")
        if not probe.ok or live is None:
            state = "unknown"
        elif live:
            state = "working"
        else:
            state = "idle"
        rows.append({
            "unit": unit,
            "civ": "capital",
            "unitType": _unit_type(str(data.get("runtimeId") or "")),
            "cityId": str(data.get("repo") or ""),
            "cityRepoPath": str(data.get("workingDirectory") or ""),
            "mission": str(data.get("summary") or ""),
            "lastActivityAt": str(data.get("updatedAt") or ""),
            "state": state,
        })
    return {"agents": rows, "livenessOk": bool(probe.ok)}