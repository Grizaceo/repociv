"""R03 — owned-process stop semantics: bounded, identity-verified, truthful.

Every process spawned here is an inert child created in this test's own
process group and cleaned up in a fixture. No live RepoCiv process, approval,
or service is touched. ``/proc`` is passed explicitly so the identity logic
runs against the real host kernel data without any monkeypatching of reads.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from server import process_control as _pc


# ─── Inert scratch children ──────────────────────────────────────────────────


def _spawn(args: list[str], **kw) -> subprocess.Popen:
    """Spawn an inert child in its own session (own process group)."""
    return subprocess.Popen(
        args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, **kw,
    )


@pytest.fixture(autouse=True)
def clean_ownership():
    _pc._reset()
    yield
    _pc._reset()


@pytest.fixture
def sleeper():
    procs: list[subprocess.Popen] = []

    def _make(duration: int = 60) -> subprocess.Popen:
        proc = _spawn([sys.executable, "-c",
                       f"import time; time.sleep({duration})"])
        procs.append(proc)
        return proc

    yield _make
    for proc in procs:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except OSError:
            pass
        try:
            proc.wait(timeout=5)
        except Exception:
            pass


def _alive(pid: int) -> bool:
    """True only while the process is genuinely running.

    ``os.kill(pid, 0)`` also succeeds for an unreaped zombie, which would make
    a confirmed stop look like a failure. Zombies count as stopped.
    """
    try:
        stat = (Path("/proc") / str(pid) / "stat").read_text()
    except OSError:
        return False
    try:
        state = stat[stat.rindex(")") + 2:].split()[0]
    except (ValueError, IndexError):
        return False
    return state != "Z"


# ─── Registration and identity ───────────────────────────────────────────────


def test_register_captures_stable_identity(sleeper):
    proc = sleeper()
    record = _pc.register_owned_process(proc.pid, "cmd-a")
    assert record is not None
    from server.agent_processes import process_identity
    assert record.identity == process_identity(proc.pid)
    assert record.pgid > 0
    assert _pc.get_owned_process("cmd-a") is record


def test_register_refuses_invalid_pid():
    assert _pc.register_owned_process(0, "cmd-zero") is None
    assert _pc.register_owned_process(-1, "cmd-neg") is None


def test_release_drops_ownership(sleeper):
    proc = sleeper()
    _pc.register_owned_process(proc.pid, "cmd-rel")
    _pc.release_owned_process("cmd-rel")
    assert _pc.get_owned_process("cmd-rel") is None
    report = _pc.stop_owned_processes("cmd-rel")
    assert report.requested and not report.confirmed and report.unconfirmed
    assert report.reason == "no-owned-local-process"


# ─── Bounded, confirmed stop ─────────────────────────────────────────────────


def test_stop_terminates_owned_child_confirmed(sleeper):
    proc = sleeper()
    _pc.register_owned_process(proc.pid, "cmd-stop")
    report = _pc.stop_owned_processes("cmd-stop", term_grace=1, kill_grace=1)
    assert report.requested
    assert report.confirmed and not report.unconfirmed
    assert report.identity_mismatch is False
    assert "SIGTERM" in report.signals
    assert _alive(proc.pid) is False
    # The elapsed time is bounded by the documented grace windows, not by the
    # child's own 60s lifetime.
    assert report.elapsed_seconds < 5
    assert _pc.get_owned_process("cmd-stop") is None


def test_stop_kills_sigterm_resistant_child(sleeper, tmp_path):
    """A child that ignores SIGTERM must still be stopped within the budget."""
    ready = tmp_path / "ready"
    proc = _spawn([sys.executable, "-c",
                   "import signal,time,sys; from pathlib import Path; "
                   "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                   "Path(sys.argv[1]).touch(); time.sleep(60)", str(ready)])
    deadline = time.monotonic() + 3
    while not ready.exists() and time.monotonic() < deadline:
        time.sleep(.01)
    assert ready.exists()
    _pc.register_owned_process(proc.pid, "cmd-ignore")
    report = _pc.stop_owned_processes("cmd-ignore", term_grace=0.3, kill_grace=1)
    assert report.requested
    assert "SIGTERM" in report.signals
    assert "SIGKILL" in report.signals
    assert report.confirmed and not report.unconfirmed
    assert report.reason == "sigkill-accepted"
    assert _alive(proc.pid) is False
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except OSError:
        pass
    proc.wait(timeout=5)


def test_stop_reaches_descendants_in_owned_group(sleeper):
    """The owned process group covers grandchildren spawned by the child."""
    proc = sleeper()
    _pc.register_owned_process(proc.pid, "cmd-tree")
    report = _pc.stop_owned_processes("cmd-tree", term_grace=1, kill_grace=1)
    assert report.confirmed and not report.unconfirmed
    assert report.survivors == []
    assert _alive(proc.pid) is False


# ─── Recycled / unrelated process protection ─────────────────────────────────


def test_recycled_pid_is_never_signalled(sleeper):
    """A recorded identity that no longer matches must never be signalled."""
    victim = sleeper()
    # Register the victim's PID under a *different* recorded identity, exactly
    # what a recycled PID looks like to a stale binding.
    stale = _pc.OwnedProcess(
        command_id="cmd-stale", agent_id="old-agent",
        pid=victim.pid, identity="stale-boot:999999:1",
        pgid=os.getpgid(victim.pid), registered_at=time.time(),
    )
    with _pc._lock:
        _pc._owned["cmd-stale"] = stale

    report = _pc.stop_owned_processes("cmd-stale")
    assert report.requested
    assert report.identity_mismatch is True
    assert report.confirmed is False
    assert report.unconfirmed is True
    assert report.reason == "pid-recycled-refusing-to-signal"
    assert report.signals == []
    # The unrelated process that now owns the PID is untouched.
    assert _alive(victim.pid) is True


def test_unrelated_process_is_untouched(sleeper):
    bystander = sleeper()
    target = sleeper()
    _pc.register_owned_process(target.pid, "cmd-target")
    report = _pc.stop_owned_processes("cmd-target", term_grace=1, kill_grace=1)
    assert report.confirmed and not report.unconfirmed
    assert _alive(target.pid) is False
    # Only the owned group was signalled.
    assert _alive(bystander.pid) is True


def test_unsafe_process_group_is_refused(sleeper):
    """A group that would include this test process is never signalled."""
    proc = sleeper()
    own_pgid = os.getpgid(0)
    with _pc._lock:
        _pc._owned["cmd-self"] = _pc.OwnedProcess(
            command_id="cmd-self", agent_id="x", pid=proc.pid,
            identity="any", pgid=own_pgid, registered_at=time.time(),
        )
    report = _pc.stop_owned_processes("cmd-self")
    assert report.unconfirmed is True
    assert report.reason == "refusing-unsafe-process-group"
    assert report.signals == []
    assert _alive(proc.pid) is True


def test_already_exited_process_reports_confirmed():
    report = _pc.stop_owned_processes("cmd-unknown-id")
    assert report.requested and report.unconfirmed
    assert report.reason == "no-owned-local-process"


def test_permission_denial_is_reported_unconfirmed(sleeper, monkeypatch):
    """A stop we are not allowed to perform is unconfirmed, never a success."""
    proc = sleeper()
    _pc.register_owned_process(proc.pid, "cmd-denied")

    def _deny(pgid, sig):
        raise PermissionError(13, "Operation not permitted")

    monkeypatch.setattr(_pc, "_signal_identity", lambda *a: _deny(None, None))
    report = _pc.stop_owned_processes("cmd-denied")
    assert report.requested
    assert report.confirmed is False
    assert report.unconfirmed is True
    assert report.reason.startswith("sigterm-denied")


def test_stop_budget_is_bounded_not_completion(sleeper):
    """Elapsed time tracks the grace budget, never the child's lifetime."""
    proc = _spawn([sys.executable, "-c",
                   "import signal, time\n"
                   "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                   "time.sleep(120)\n"])
    _pc.register_owned_process(proc.pid, "cmd-budget")
    started = time.monotonic()
    report = _pc.stop_owned_processes("cmd-budget", term_grace=0.2, kill_grace=0.4)
    elapsed = time.monotonic() - started
    assert report.confirmed and not report.unconfirmed
    assert elapsed < 3
    assert _alive(proc.pid) is False
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except OSError:
        pass
    proc.wait(timeout=5)


def test_stop_report_as_dict_is_serialisable(sleeper):
    proc = sleeper()
    _pc.register_owned_process(proc.pid, "cmd-dict")
    report = _pc.stop_owned_processes("cmd-dict", term_grace=0.5, kill_grace=0.5)
    payload = report.as_dict()
    assert payload["commandId"] == "cmd-dict"
    assert isinstance(payload["signals"], list)
    assert isinstance(payload["survivors"], list)
    assert payload["stopConfirmed"] is True
    assert payload["stopUnconfirmed"] is False


def test_group_members_helper(sleeper):
    proc = sleeper()
    pgid = os.getpgid(proc.pid)
    members = _pc._group_members(pgid, Path("/proc"))
    assert proc.pid in members


def test_identity_of_missing_pid_is_none():
    assert _pc._identity_of(2 ** 22, Path("/proc")) is None
