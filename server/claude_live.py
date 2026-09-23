"""Process-owned Claude Code channel — the Fase 5 live-session chat surface.

The other transports ride on a harness's own queue (``codex queue``) or refuse
outright; this module gives RepoCiv a channel it fully controls. It spawns
``claude -p`` with ``--input-format stream-json --output-format stream-json``
(argv verified in ``docs/evidence/2026-09-21-claude-code-channel-research.md``),
keeps the process, and writes one JSON line per user turn to its stdin. The
stdout is read back line by line and each ``result`` event becomes the
assistant turn the panel shows.

Why a manager and not a one-shot call: the point is a *live* channel — the
conversation stays warm (context, tools, cwd) between turns, and a session is
addressable only while this process holds it. A session Suvadu merely saw (the
user's own terminal run) has no stdin to write to: it stays observable and
*not* addressable — the adapter fails closed instead of degrading to
``--resume`` (Fase 5 of docs/plans/2026-09-21-live-session-chat-multiharness.md).

Ownership: every spawned id is recorded through ``claude_sessions`` so the
Suvadu source skips it (this channel's row is its unit), and
``ClaudeLiveSource`` declares ``live`` itself — it owns the pid, so the
tracker's approximate /proc probe must not overrule it
(server/session_liveness.py).

Env: the child gets ``redact_env_for_spawn`` (no inherited API keys leak); the
claude CLI authenticates from its on-disk config via HOME, which is kept.

Lifecycle: ``spawn`` starts the process plus one reader thread per session;
``send`` serializes writers per session; ``stop`` closes stdin, terminates the
process and marks the row dead (the unit despawns on the next poll; the panel
row ages out on its last activity like every other session).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from server import claude_sessions
from server._env_filter import redact_env_for_spawn
from server.suvadu_tracker import Observation, SourceError

SESSION_PREFIX = "claude-live-"
_MAX_MESSAGE_BYTES = 120 * 1024
_MAX_MESSAGES = 400
_MAX_SESSIONS = 64


class ClaudeLiveError(Exception):
    """A channel operation failed; ``(status, code)`` map onto the HTTP layer."""

    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def _now_ms() -> int:
    return int(time.time() * 1000)


def _strip_prefix(key: str) -> str:
    return key[len(SESSION_PREFIX):] if key.startswith(SESSION_PREFIX) else key


class _Session:
    """One claude process and the turns exchanged with it."""

    __slots__ = (
        "native_id",
        "session_id",
        "cwd",
        "proc",
        "started_ms",
        "last_activity_ms",
        "write_lock",
        "messages",
        "ended",
    )

    def __init__(self, native_id: str, cwd: str, proc: Any) -> None:
        self.native_id = native_id
        self.session_id = SESSION_PREFIX + native_id
        self.cwd = cwd
        self.proc = proc
        self.started_ms = _now_ms()
        self.last_activity_ms = self.started_ms
        self.write_lock = threading.Lock()
        self.messages: list[dict[str, Any]] = []
        self.ended = False


def _find_claude() -> str:
    """Same candidates as agent_runner._find_claude_code (kept local: no cycle)."""
    candidates = [
        shutil.which("claude"),
        str(Path.home() / ".npm-global" / "bin" / "claude"),
        str(Path.home() / ".local" / "bin" / "claude"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists() and os.access(candidate, os.X_OK):
            return candidate
    return ""


class ClaudeLiveManager:
    """Spawn / write to / stop one claude process per live session."""

    def __init__(self, *, claude_bin: str, spawn: Callable[..., Any] = subprocess.Popen) -> None:
        self.claude_bin = claude_bin
        self._spawn = spawn
        self._lock = threading.Lock()
        self._sessions: dict[str, _Session] = {}

    # -- lifecycle -----------------------------------------------------------
    def spawn(self, cwd: str) -> dict[str, Any]:
        """Start one session in ``cwd``; returns its row (nativeId, sessionId, cwd)."""
        directory = os.path.abspath(os.path.expanduser(str(cwd or "")))
        if not directory or not os.path.isdir(directory):
            raise ClaudeLiveError(400, "invalid_cwd")
        if not self.claude_bin:
            raise ClaudeLiveError(503, "claude_unavailable")
        native_id = str(uuid.uuid4())
        argv = [
            self.claude_bin,
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--dangerously-skip-permissions",
            "--session-id",
            native_id,
        ]
        try:
            proc = self._spawn(
                argv,
                cwd=directory,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                env=redact_env_for_spawn(),
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise ClaudeLiveError(500, "spawn_failed") from exc
        session = _Session(native_id, directory, proc)
        with self._lock:
            self._sessions[native_id] = session
            self._prune_locked()
        claude_sessions.record_owned(native_id)
        threading.Thread(
            target=self._read_loop,
            args=(session,),
            name=f"claude-live-{native_id[:8]}",
            daemon=True,
        ).start()
        return {"nativeId": native_id, "sessionId": session.session_id, "cwd": directory}

    def stop(self, session_key: str) -> str:
        """End the session's process; returns its canonical session id."""
        session = self._get(session_key)
        self._terminate(session)
        with self._lock:
            session.ended = True
        return session.session_id

    # -- conversation --------------------------------------------------------
    def send(self, session_key: str, text: str) -> None:
        """Write one user turn as a stream-json line; writers are serialized."""
        session = self._get(session_key)
        if not isinstance(text, str) or not text.strip():
            raise ClaudeLiveError(422, "empty_message")
        if len(text.encode("utf-8")) > _MAX_MESSAGE_BYTES:
            raise ClaudeLiveError(413, "message_too_large")
        line = json.dumps(
            {"type": "user", "message": {"role": "user", "content": text}},
            ensure_ascii=False,
        )
        with session.write_lock:
            if session.ended or session.proc.poll() is not None:
                raise ClaudeLiveError(409, "session_not_live")
            try:
                session.proc.stdin.write(line + "\n")
                session.proc.stdin.flush()
            except (OSError, ValueError) as exc:
                raise ClaudeLiveError(502, "transport_failed") from exc
            with self._lock:
                self._append_locked(session, {"role": "user", "text": text, "at": _now_ms()})

    def messages(self, session_key: str) -> list[dict[str, Any]]:
        """The turns exchanged so far, oldest first."""
        session = self._get(session_key)
        with self._lock:
            return [dict(message) for message in session.messages]

    def sessions(self) -> list[dict[str, Any]]:
        """Every session this manager holds, newest first (dead ones included)."""
        with self._lock:
            rows = [
                {
                    "sessionId": session.session_id,
                    "nativeId": session.native_id,
                    "cwd": session.cwd,
                    "startedAt": session.started_ms,
                    "lastActivityAt": session.last_activity_ms,
                    "messageCount": len(session.messages),
                    "alive": not session.ended and session.proc.poll() is None,
                }
                for session in self._sessions.values()
            ]
        return sorted(rows, key=lambda row: row["startedAt"], reverse=True)

    # -- internals -----------------------------------------------------------
    def _get(self, session_key: str) -> _Session:
        native_id = _strip_prefix(str(session_key or ""))
        with self._lock:
            session = self._sessions.get(native_id)
        if session is None:
            raise ClaudeLiveError(404, "session_not_found")
        return session

    def _append_locked(self, session: _Session, message: dict[str, Any]) -> None:
        session.messages.append(message)
        if len(session.messages) > _MAX_MESSAGES:
            del session.messages[: len(session.messages) - _MAX_MESSAGES]
        session.last_activity_ms = _now_ms()

    def _consume(self, session: _Session, line: str) -> None:
        """One stdout line → one assistant turn, when it is a ``result`` event."""
        try:
            payload = json.loads(line)
        except ValueError:
            return
        if not isinstance(payload, dict) or payload.get("type") != "result":
            return
        text = payload.get("result")
        if not isinstance(text, str) or not text:
            return
        with self._lock:
            self._append_locked(session, {"role": "assistant", "text": text, "at": _now_ms()})

    def _read_loop(self, session: _Session) -> None:
        try:
            for line in session.proc.stdout:
                line = line.strip()
                if line:
                    self._consume(session, line)
        except Exception:
            pass  # a broken pipe ends the session; the next poll sees it dead
        finally:
            with self._lock:
                session.ended = True

    @staticmethod
    def _terminate(session: _Session) -> None:
        proc = session.proc
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except Exception:
            pass
        terminate = getattr(proc, "terminate", None)
        try:
            if callable(terminate):
                terminate()
            else:
                proc.kill()
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    def _prune_locked(self) -> None:
        overflow = len(self._sessions) - _MAX_SESSIONS
        if overflow <= 0:
            return
        for key in [k for k, s in self._sessions.items() if s.ended][:overflow]:
            self._sessions.pop(key, None)


class ClaudeLiveSource:
    """Sessions whose process RepoCiv holds itself (``claude-live-<uuid>``).

    Unlike the Suvadu / Hermes rows, this source answers the liveness question
    exactly: it owns the pid, so it declares ``live`` itself and the tracker's
    approximate /proc probe must not overrule it (server/session_liveness.py).
    """

    name = "claude-live"

    def __init__(self, manager: ClaudeLiveManager) -> None:
        self._manager = manager

    def poll(self) -> list[Observation]:
        out: list[Observation] = []
        for row in self._manager.sessions():
            alive = bool(row.get("alive"))
            started = int(row.get("startedAt") or 0)
            out.append(
                Observation(
                    session_id=str(row.get("sessionId") or ""),
                    agent="claude-code",
                    native_id=str(row.get("nativeId") or ""),
                    cwd=str(row.get("cwd") or ""),
                    model="",
                    first_activity_ms=started,
                    last_activity_ms=int(row.get("lastActivityAt") or started),
                    command_count=0,
                    event_count=0,
                    total_tokens=None,
                    source=self.name,
                    live=alive,
                    ended=not alive,
                )
            )
        return out

    def status(self) -> dict[str, Any]:
        return {"sessions": len(self._manager.sessions())}

    def refresh(self, obs: Observation) -> str:
        """Nothing to re-import: the manager reads the process stream directly."""
        return "ok"

    def chat(self, obs: Observation, *, limit: int) -> dict[str, Any]:
        try:
            messages = self._manager.messages(obs.native_id)
        except ClaudeLiveError as exc:
            raise SourceError(exc.code) from exc
        return {
            "messages": messages[-limit:],
            "hasMore": len(messages) > limit,
            "available": True,
        }


# ─── Module singleton (spawn endpoint + tracker source share it) ─────────────
_manager: ClaudeLiveManager | None = None
_manager_lock = threading.Lock()


def get_manager() -> ClaudeLiveManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = ClaudeLiveManager(claude_bin=_find_claude())
        return _manager
