"""Is there still a live process behind an external agent session?

The tracker's only liveness signal is an activity timestamp, and both sources
freeze it mid-turn: Suvadu's heartbeat is a ``PostToolUse`` hook, so an agent
that reasons for minutes without calling a tool stops emitting, and Hermes
refreshes ``last_activity_at`` about once a minute. A session then reads
``idle`` while the agent is very much working — precisely the moment the user
must *not* interrupt it (``docs/EXTERNAL_AGENTS.md``).

This module answers a narrower question that can actually be checked: does a
live process hold this session? Two probes, both read-only and local:

  * Hermes — exact. ``~/.hermes/runtime/active_sessions.json`` is the lease
    registry Hermes keeps so two processes never write one session; each entry
    carries the session id and the pid, so a match is proof, not a guess.
  * Suvadu (Claude Code, Codex, Cursor…) — approximate. ``/proc`` is scanned
    for agent binaries and their cwd; a session whose cwd has a live agent
    process counts as live. It cannot tell two Claude sessions in the same
    directory apart, so it errs towards "live" — the safe side here: a false
    "busy" costs a needless wait, a false "idle" interrupts a working agent.

Nothing here reads a prompt, a command or a transcript: pids, binary names and
working directories only, and the working directory never leaves the process
(the tracker already maps it to a city).

Linux-only: without ``/proc`` every lookup returns ``None`` and the tracker
keeps its timestamp-only behaviour.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

PROC_ROOT = "/proc"
LEASE_PATH = os.path.expanduser("~/.hermes/runtime/active_sessions.json")
_MAX_CMDLINE = 4096
_MAX_LEASE_BYTES = 1 << 20

# argv[0] of the agent CLIs Suvadu records. Matched on the whole command line so
# a wrapper (``node …/claude``, ``python …/hermes``) is caught too.
_AGENT_RE = re.compile(r"(?:^|[/\s])(claude|codex|cursor-agent|opencode)(?:\s|$)")
_HERMES_RE = re.compile(r"(?:^|[/\s])hermes(?:\s|$)")


@dataclass(frozen=True)
class Liveness:
    """One /proc + lease-registry reading. ``ok`` is False when nothing could
    be read, and every lookup then answers ``None`` (unknown, not "dead")."""

    hermes_sessions: frozenset[str] = frozenset()
    agent_cwds: frozenset[str] = frozenset()
    ok: bool = False

    def live_for(self, *, source: str, native_id: str, cwd: str) -> bool | None:
        """True / False / None (could not tell) for one observed session."""
        if not self.ok:
            return None
        if source == "hermes":
            return native_id in self.hermes_sessions
        return bool(cwd) and cwd in self.agent_cwds


def _read_bytes(path: str, limit: int) -> bytes:
    try:
        with open(path, "rb") as fh:
            return fh.read(limit)
    except OSError:
        return b""


def _cmdline(proc_root: str, pid: str) -> str:
    raw = _read_bytes(f"{proc_root}/{pid}/cmdline", _MAX_CMDLINE)
    return raw.decode("utf-8", "replace").replace("\0", " ").strip()


def _cwd(proc_root: str, pid: str) -> str:
    try:
        return os.readlink(f"{proc_root}/{pid}/cwd")
    except OSError:
        return ""  # exited, or another user's process


def probe(proc_root: str = PROC_ROOT, lease_path: str = LEASE_PATH) -> Liveness:
    """Scan once. Never raises: an unreadable /proc or lease file degrades to
    ``ok=False`` (unknown) rather than to a wrong answer."""
    try:
        pids = [name for name in os.listdir(proc_root) if name.isdigit()]
    except OSError:
        return Liveness()
    if not pids:
        return Liveness()
    try:
        cwds: set[str] = set()
        hermes_pids: set[int] = set()
        for pid in pids:
            cmd = _cmdline(proc_root, pid)
            if not cmd:
                continue
            if _HERMES_RE.search(cmd):
                hermes_pids.add(int(pid))
            if not _AGENT_RE.search(cmd):
                continue
            cwd = _cwd(proc_root, pid)
            if cwd:
                cwds.add(cwd)
        return Liveness(
            hermes_sessions=live_hermes_sessions(lease_path, hermes_pids),
            agent_cwds=frozenset(cwds),
            ok=True,
        )
    except Exception:
        return Liveness()


def live_hermes_sessions(path: str, hermes_pids: set[int]) -> frozenset[str]:
    """Session ids in Hermes' lease registry whose pid is a live hermes process.

    The pid check is what makes a stale lease (a crashed CLI that never released
    it) read as dead; re-checking the command line is what stops a recycled pid
    from resurrecting one.
    """
    raw = _read_bytes(path, _MAX_LEASE_BYTES)
    if not raw:
        return frozenset()
    try:
        data = json.loads(raw)
    except ValueError:
        return frozenset()
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return frozenset()
    out: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        pid = entry.get("pid")
        if isinstance(pid, bool) or not isinstance(pid, int) or pid not in hermes_pids:
            continue
        metadata = entry.get("metadata")
        live_id = metadata.get("live_session_id") if isinstance(metadata, dict) else None
        for key in (entry.get("session_id"), live_id):
            if isinstance(key, str) and key:
                out.add(key)
    return frozenset(out)
