"""RepoCiv — owned-process lifecycle and identity-verified stop (R03).

Observation and termination are separate contracts (R01). This module only
implements the *termination* half for processes RepoCiv itself spawned, and it
never claims a stop it cannot prove.

Contract
--------
1. **Ownership is explicit.** A process becomes stoppable only through
   :func:`register_owned_process`, which captures a stable process identity
   (boot id + pid + kernel start ticks, via ``agent_processes.process_identity``).
   A bare PID is never historical identity.
2. **A recycled PID is never signalled.** Every stop re-reads the live identity
   and refuses to signal when it differs from the recorded one, so a stop
   request meant for an older process identity cannot hit an unrelated process
   that now owns the number.
3. **Stop is bounded.** SIGTERM to the owned *process group*, then a bounded
   grace window, then SIGKILL, then a bounded confirmation window. No step of
   this waits for normal completion.
4. **Truthful outcome.** :class:`StopReport` always separates
   ``requested`` from ``confirmed``. Anything that cannot be proven —
   permission denied, a surviving group member, a remote HTTP execution with no
   local process — is reported ``unconfirmed`` with a machine-readable reason.
   Unconfirmed is never silently upgraded to success.
5. **Unrelated processes are untouched.** Only the recorded process group is
   signalled, and a group that would include the bridge itself is refused.

Public API:
  register_owned_process(pid, command_id, agent_id, pgid=None) -> OwnedProcess
  get_owned_process(command_id) -> OwnedProcess | None
  release_owned_process(command_id) -> None
  stop_owned_processes(command_id, ...) -> StopReport
"""

from __future__ import annotations

import logging
import os
import signal
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from server.agent_processes import process_identity  # read-only reuse (R01)

logger = logging.getLogger(__name__)

# Bounded budgets. Overridable per environment; every value is a hard ceiling,
# never a hint that the caller should wait for normal completion.
TERM_GRACE_SECONDS = float(os.environ.get("REPOCIV_STOP_TERM_GRACE", "3"))
KILL_GRACE_SECONDS = float(os.environ.get("REPOCIV_STOP_KILL_GRACE", "3"))
# How long a step may spend in post-deadline cleanup before returning control
# to the caller. Cleanup must never become a second, unbounded deadline.
CLEANUP_BUDGET_SECONDS = float(os.environ.get("REPOCIV_STOP_CLEANUP_BUDGET", "5"))
_POLL_INTERVAL = 0.05


@dataclass(frozen=True)
class OwnedProcess:
    """A process RepoCiv spawned and is therefore allowed to stop."""

    command_id: str
    agent_id: str
    pid: int
    identity: str
    pgid: int
    registered_at: float


@dataclass
class StopReport:
    """Truthful outcome of a stop request.

    ``requested``   — a stop was asked for.
    ``confirmed``   — the owned process group is provably gone.
    ``unconfirmed`` — the stop could not be proven; ``reason`` says why.
    """

    command_id: str
    requested: bool = False
    confirmed: bool = False
    unconfirmed: bool = False
    reason: str = ""
    identity_mismatch: bool = False
    pid: int = 0
    pgid: int = 0
    signals: list[str] = field(default_factory=list)
    survivors: list[int] = field(default_factory=list)
    elapsed_seconds: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        """camelCase payload for events/UI; ``requested`` and ``confirmed``
        stay separate so a UI can never imply a proven stop from a request."""
        return {
            "commandId": self.command_id,
            "stopRequested": self.requested,
            "stopConfirmed": self.confirmed,
            "stopUnconfirmed": self.unconfirmed,
            "stopReason": self.reason,
            "identityMismatch": self.identity_mismatch,
            "pid": self.pid,
            "pgid": self.pgid,
            "signals": list(self.signals),
            "survivors": list(self.survivors),
            "elapsedSeconds": round(self.elapsed_seconds, 3),
        }


_lock = threading.RLock()
_owned: dict[str, OwnedProcess] = {}


# ─── Registration ────────────────────────────────────────────────────────────


def register_owned_process(
    pid: int,
    command_id: str,
    agent_id: str = "",
    pgid: int | None = None,
    *,
    proc_root: Path = Path("/proc"),
) -> OwnedProcess | None:
    """Record ``pid`` as owned by ``command_id``.

    Returns the :class:`OwnedProcess` record, or ``None`` when no stable
    identity could be read (an unreadable process is not owned, and is
    therefore never signalled).
    """
    if not isinstance(pid, int) or pid <= 0:
        return None
    identity = process_identity(pid, proc_root)
    if identity is None:
        return None
    record = OwnedProcess(
        command_id=command_id,
        agent_id=agent_id,
        pid=pid,
        identity=identity,
        pgid=pgid if isinstance(pgid, int) and pgid > 0 else pid,
        registered_at=time.time(),
    )
    with _lock:
        _owned[command_id] = record
    return record


def get_owned_process(command_id: str) -> OwnedProcess | None:
    with _lock:
        return _owned.get(command_id)


def release_owned_process(command_id: str) -> None:
    """Forget ownership after a proven terminal outcome."""
    with _lock:
        _owned.pop(command_id, None)


def _reset() -> None:
    """Test helper: drop all ownership records."""
    with _lock:
        _owned.clear()


# ─── /proc helpers ───────────────────────────────────────────────────────────


def _group_members(pgid: int, proc_root: Path) -> list[int]:
    """PIDs whose process group is ``pgid``. Best-effort; never a full census."""
    members: list[int] = []
    try:
        entries = list(proc_root.iterdir())
    except OSError:
        return members
    for entry in entries:
        if not entry.name.isdigit():
            continue
        fields = _stat_fields(int(entry.name), proc_root)
        if not fields or fields[0] == "Z":
            continue
        try:
            if int(fields[2]) == pgid:
                members.append(int(entry.name))
        except (ValueError, IndexError):
            continue
    return members


def _stat_fields(pid: int, proc_root: Path) -> list[str] | None:
    try:
        stat = (proc_root / str(pid) / "stat").read_text()
    except OSError:
        return None
    try:
        return stat[stat.rindex(")") + 2:].split()
    except (ValueError, IndexError):
        return None


def _identity_of(pid: int, proc_root: Path) -> str | None:
    """Live identity of ``pid``, or ``None`` when it is gone or a zombie.

    A reaped-but-not-yet-waited process keeps its ``/proc`` entry with state
    ``Z``. Treating that as still-running would make every confirmed stop look
    unconfirmed, so zombies count as gone.
    """
    fields = _stat_fields(pid, proc_root)
    if not fields or fields[0] == "Z":
        return None
    try:
        from server.agent_processes import process_identity
        return process_identity(pid, proc_root)
    except Exception:  # pragma: no cover - defensive
        return None


def _wait_gone(pid: int, identity: str, deadline: float, proc_root: Path) -> bool:
    """True when ``pid`` no longer holds ``identity`` (exited, or recycled)."""
    while True:
        current = _identity_of(pid, proc_root)
        if current is None or current != identity:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(_POLL_INTERVAL)


# ─── Stop ────────────────────────────────────────────────────────────────────


def _signal_identity(pid: int, identity: str, sig: int, proc_root: Path) -> None:
    """Pin the kernel object before rechecking identity; never signal a bare PID.

    Unsupported pidfd hosts report unconfirmed; there is no unsafe fallback.
    """
    fd = os.pidfd_open(pid)
    try:
        if _identity_of(pid, proc_root) != identity:
            raise ProcessLookupError("identity changed")
        signal.pidfd_send_signal(fd, sig)
    finally:
        os.close(fd)


def stop_owned_processes(
    command_id: str, *, term_grace: float = TERM_GRACE_SECONDS,
    kill_grace: float = KILL_GRACE_SECONDS, proc_root: Path = Path("/proc"),
) -> StopReport:
    """Bounded identity-pinned stop of a dedicated owned session.

    Enumerate descendants before stopping their parent; verify every pidfd.
    Descendants escaping the session between observations cannot be attested;
    this is not hostile-process containment. No group-wide bare-PID signals.
    """
    started = time.monotonic()
    owned = get_owned_process(command_id)
    report = StopReport(command_id, requested=True, unconfirmed=True,
                        reason="no-owned-local-process")
    if owned is None:
        return report
    report.pid, report.pgid = owned.pid, owned.pgid
    if owned.pgid <= 1 or owned.pgid == os.getpgid(0):
        report.reason = "refusing-unsafe-process-group"
        return report
    current = _identity_of(owned.pid, proc_root)
    if current is not None and current != owned.identity:
        report.identity_mismatch = True
        report.reason = "pid-recycled-refusing-to-signal"
        return report
    # A leader that already exited does not prove its children exited.
    members = _group_members(owned.pgid, proc_root)
    if current is None:
        report.confirmed = not members
        report.unconfirmed = bool(members)
        report.survivors = members
        report.reason = "orphan-members-unconfirmed" if members else "already-exited"
        if report.confirmed:
            release_owned_process(command_id)
        return report
    fields = _stat_fields(owned.pid, proc_root)
    if not fields or int(fields[3]) != owned.pid or int(fields[2]) != owned.pgid:
        report.reason = "not-owned-dedicated-session"
        return report
    targets: dict[int, str] = {}
    def census():
        # Only members of the still-identified original dedicated session.
        for pid in _group_members(owned.pgid, proc_root):
            fields = _stat_fields(pid, proc_root)
            ident = _identity_of(pid, proc_root)
            if fields and ident and int(fields[3]) == owned.pid:
                targets.setdefault(pid, ident)
    census()
    def survivors():
        return [pid for pid, ident in targets.items() if _identity_of(pid, proc_root) == ident]
    def send(sig):
        for pid in sorted(survivors(), key=lambda pid: pid == owned.pid):
            try:
                _signal_identity(pid, targets[pid], sig, proc_root)
            except ProcessLookupError:
                continue
        report.signals.append(signal.Signals(sig).name)
    budget = max(0, CLEANUP_BUDGET_SECONDS)
    end = started + budget
    try:
        for sig, grace in [(signal.SIGTERM, term_grace), (signal.SIGKILL, kill_grace)]:
            census()
            send(sig)
            deadline = min(end, time.monotonic() + max(0, grace))
            while survivors() and time.monotonic() < deadline:
                census()
                time.sleep(min(_POLL_INTERVAL, max(0, deadline-time.monotonic())))
            census()
            if not survivors():
                report.confirmed, report.unconfirmed = True, False
                report.reason = "sigterm-accepted" if sig == signal.SIGTERM else "sigkill-accepted"
                release_owned_process(command_id)
                break
        if not report.confirmed:
            report.survivors = survivors()
            report.reason = "survivors-after-sigkill"
    except (OSError, AttributeError) as exc:
        report.reason = "sigterm-denied" if isinstance(exc, PermissionError) else "identity-pinned-signal-unavailable"
        report.survivors = survivors()
    report.elapsed_seconds = time.monotonic() - started
    return report
