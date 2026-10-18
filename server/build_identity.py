"""RepoCiv — privacy-safe loaded-build diagnostic (R05).

The health surface used to report only a hard-coded ``version`` string, which
says nothing about the code actually loaded by the running process. This
module captures an immutable, privacy-safe identity **once, at process
startup**, so an operator can tell a stale process from a fresh checkout
without exposing any secret material.

Privacy contract (hard rule, enforced by tests):

  * Never returns tokens, keys, environment values, prompts, or argv.
  * Paths are reported as coarse status values, not filesystem locations.
  * A missing or unknown field is reported as ``"unknown"``, never as a
    healthy default and never as "feature absent".
"""

from __future__ import annotations

import json
import logging
import subprocess
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_VERSION = "0.1.0"
_UNKNOWN = "unknown"

# ── Immutable startup identity ───────────────────────────────────────────────
# Captured exactly once per process. A later checkout change cannot alter it:
# that mismatch is precisely what the diagnostic is for.

_REPO_ROOT = Path(__file__).resolve().parent.parent
_BUILD_INFO_FILE = _REPO_ROOT / "shared" / "build-info.json"

_PROCESS_STARTED_AT = time.time()


def _read_static_build_info() -> dict[str, Any]:
    """Read the generated build descriptor if present (survives editable dev)."""
    try:
        raw = json.loads(_BUILD_INFO_FILE.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, json.JSONDecodeError, ValueError):
        return {}


def _git_commit_short() -> str:
    try:
        top = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=str(_REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        if top.returncode != 0 or not top.stdout.strip():
            return _UNKNOWN
        if Path(top.stdout.strip()).resolve() != _REPO_ROOT.resolve():
            return _UNKNOWN
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(_REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
        commit = out.stdout.strip()
        return commit if out.returncode == 0 and commit else _UNKNOWN
    except (OSError, subprocess.SubprocessError):
        return _UNKNOWN


_STATIC = _read_static_build_info()


def _capture_build() -> dict[str, Any]:
    """Build the immutable loaded-code identity for THIS process."""
    commit = _STATIC.get("commit") or _UNKNOWN
    if commit == _UNKNOWN:
        commit = _git_commit_short()
    return {
        "version": _STATIC.get("version") or _VERSION,
        "commit": commit,
        "buildId": str(_STATIC.get("buildId") or _UNKNOWN),
        "builtAt": _STATIC.get("builtAt") or _UNKNOWN,
        # Attestation mode: "generated" when a build descriptor file backs the
        # identity, "git-fallback" when it was read from the checkout at
        # startup, "unknown" when neither source was available.
        "source": (
            "generated" if _STATIC else ("git-fallback" if commit != _UNKNOWN else _UNKNOWN)
        ),
    }


# Frozen at import: changing the checkout later cannot change what this
# process reports, which is the whole point of R05.
_LOADED_BUILD: dict[str, Any] = _capture_build()


def loaded_build() -> dict[str, Any]:
    """Immutable identity of the code loaded by the running process."""
    return dict(_LOADED_BUILD)


def started_at() -> float:
    """Process start time (unix seconds), captured at import."""
    return _PROCESS_STARTED_AT


# ── Audit key mode ───────────────────────────────────────────────────────────

def audit_key_mode() -> str:
    """Audit-signing key mode: ``"persistent"`` or ``"ephemeral"``.

    Persistent means signatures can be verified across restarts (an operator
    key is configured). Ephemeral means a per-process key was generated, so
    tamper-evidence is NOT verifiable across restarts. Never exposes the key.
    """
    from server import security_harness  # noqa: PLC0415

    return getattr(security_harness, "audit_key_mode", lambda: _UNKNOWN)()


# ── Store status ─────────────────────────────────────────────────────────────

def _store_status(store_dir: str | None) -> str:
    """Coarse, privacy-safe store status. Never reports a filesystem path."""
    if not store_dir:
        return _UNKNOWN
    try:
        path = Path(store_dir)
        if not path.is_dir():
            return "missing"
        probe = path / ".repociv-write-probe"
        probe.write_text("", encoding="utf-8")
        probe.unlink()
        return "writable"
    except OSError:
        return "not-writable"


def event_store_status() -> str:
    from server import event_store  # noqa: PLC0415

    path = getattr(event_store, "_store_path", None)
    if path is None:
        return _UNKNOWN
    return _store_status(str(Path(path).parent))


def approval_store_status() -> str:
    from server import approval_store  # noqa: PLC0415

    return _store_status(str(approval_store._approvals_path().parent))


def scheduler_store_status() -> str:
    from server import scheduler  # noqa: PLC0415

    return _store_status(str(scheduler._QUEUE_FILE.parent))


# ── Recovery visibility (R01 surface for R12 to build on) ────────────────────

def unresolved_dispatch_count() -> int:
    """Durable dispatch intents never claimed — visible for operator review."""
    try:
        from server import dispatch_ledger  # noqa: PLC0415

        return len(dispatch_ledger.unresolved())
    except Exception:
        return -1  # -1 = the recovery surface itself is unavailable/unknown


def interrupted_task_count() -> int:
    """Orchestrator tasks R12 reconciled as interrupted, awaiting an operator."""
    try:
        from server import task_orchestrator  # noqa: PLC0415

        return len(task_orchestrator.interrupted_tasks())
    except Exception:
        return -1


# ── Full snapshot ────────────────────────────────────────────────────────────

def snapshot() -> dict[str, Any]:
    """Privacy-safe loaded-build + capability diagnostic.

    Safe to serve on an existing authenticated surface (e.g. ``/health``).
    Contains booleans / capability states / coarse statuses only — never
    secret material, environment dumps, prompts, or argv.
    """
    return {
        "loadedBuild": loaded_build(),
        "startedAt": started_at(),
        "uptimeS": round(time.time() - _PROCESS_STARTED_AT, 3),
        "auditKeyMode": audit_key_mode(),
        "stores": {
            "eventStore": event_store_status(),
            "approvalStore": approval_store_status(),
            "schedulerQueue": scheduler_store_status(),
        },
        "recovery": {
            "unresolvedDispatches": unresolved_dispatch_count(),
            "interruptedTasks": interrupted_task_count(),
        },
    }
