"""Devin CLI -> RepoCiv: Devin sessions as a read-only external-agent source.

Reads ``~/.local/share/devin/cli/sessions.db`` in read-only URI mode
(``file:...?mode=ro`` + ``PRAGMA query_only=1``) and checks active session locks
in ``~/.local/share/devin/cli/session_locks/<id>.lock`` (each lock file holds
the owning Devin PID).
"""
from __future__ import annotations

import glob
import json
import os
import re
import sqlite3
import time
from typing import Any, Callable
from urllib.parse import quote

from server import session_liveness
from server.suvadu_tracker import Observation, SourceError
from server.transcript_work import dirs_from_hints

AGENT = "devin"
SOURCE_NAME = "devin"

_SESSIONS_LIMIT = 200
_TEXT_MAX = 4000
_BUSY_TIMEOUT_S = 0.5
_POLL_DEADLINE_S = 2.0
_CHAT_DEADLINE_S = 3.0
_WORK_ROWS = 60
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_PATH_HINT_RE = re.compile(
    r'"(?:file_path|notebook_path|workdir|working_directory|path|cwd)"\s*:\s*"([^"]+)"'
)
_CD_HINT_RE = re.compile(r"(?:^|&&|;|\|\|)\s*cd\s+(['\"]?)(~/[^'\"\s;&|]*|/[^'\"\s;&|]*)")


def default_data_dir() -> str:
    env = os.environ.get("REPOCIV_DEVIN_DATA_DIR", "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    xdg = os.environ.get("XDG_DATA_HOME", "").strip() or os.path.expanduser("~/.local/share")
    return os.path.join(os.path.abspath(os.path.expanduser(xdg)), "devin", "cli")


def connect_ro(path: str, deadline_s: float = _POLL_DEADLINE_S) -> sqlite3.Connection:
    uri = "file:" + quote(os.path.abspath(path), safe="/:") + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=_BUSY_TIMEOUT_S)
    except sqlite3.Error as exc:
        raise SourceError("db_open_failed") from exc
    deadline = time.monotonic() + deadline_s

    def _check_deadline() -> int:
        return 1 if time.monotonic() > deadline else 0

    try:
        conn.execute(f"PRAGMA busy_timeout = {int(_BUSY_TIMEOUT_S * 1000)}")
        conn.execute("PRAGMA query_only = ON")
        conn.execute("PRAGMA temp_store = MEMORY")
        conn.set_progress_handler(_check_deadline, 2000)
    except sqlite3.Error:
        conn.close()
        raise SourceError("db_pragma_failed") from None
    return conn


def _live_locked_sessions(locks_dir: str, proc_root: str = session_liveness.PROC_ROOT) -> frozenset[str]:
    if not os.path.isdir(locks_dir):
        return frozenset()
    out: set[str] = set()
    for lock_path in glob.glob(os.path.join(locks_dir, "*.lock")):
        sid = os.path.basename(lock_path)[: -len(".lock")]
        if not _ID_RE.match(sid):
            continue
        try:
            with open(lock_path, "r", encoding="utf-8") as fh:
                raw_pid = fh.read(64).strip()
            pid = int(raw_pid)
        except (OSError, ValueError):
            continue
        if pid <= 0:
            continue
        cmd = session_liveness._cmdline(proc_root, str(pid))
        if cmd and "devin" in cmd.lower():
            out.add(sid)
    return frozenset(out)


def _extract_work_dirs(conn: sqlite3.Connection, session_id: str, workspace_dirs_raw: str | None) -> tuple[str, ...]:
    hints: list[str] = []
    try:
        rows = conn.execute(
            "SELECT tool_call_json FROM tool_call_state "
            "WHERE session_id = ? AND tool_call_json IS NOT NULL "
            "ORDER BY rowid DESC LIMIT ?",
            (session_id, _WORK_ROWS),
        ).fetchall()
    except sqlite3.Error:
        rows = []
    for (raw_json,) in rows:
        if not isinstance(raw_json, str) or not raw_json:
            continue
        for match in _PATH_HINT_RE.finditer(raw_json):
            hints.append(match.group(1))
        for match in _CD_HINT_RE.finditer(raw_json):
            hints.append(match.group(2))
    if isinstance(workspace_dirs_raw, str) and workspace_dirs_raw.strip():
        try:
            parsed = json.loads(workspace_dirs_raw)
            if isinstance(parsed, list):
                hints.extend(p for p in parsed if isinstance(p, str))
        except ValueError:
            pass
    return dirs_from_hints(hints)


def _extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(p.strip() for p in parts if p.strip()).strip()
    return ""


class DevinSource:
    """Read-only source over Devin CLI's ``sessions.db`` + ``session_locks/``."""

    name = SOURCE_NAME

    def __init__(
        self,
        data_dir: str | None = None,
        *,
        recent_s: float = 86400.0,
        proc_root: str = session_liveness.PROC_ROOT,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.data_dir = os.path.abspath(os.path.expanduser(data_dir or default_data_dir()))
        self.recent_s = recent_s
        self.proc_root = proc_root
        self._clock = clock

    @property
    def db_path(self) -> str:
        return os.path.join(self.data_dir, "sessions.db")

    @property
    def locks_dir(self) -> str:
        return os.path.join(self.data_dir, "session_locks")

    def poll(self) -> list[Observation]:
        if not os.path.isfile(self.db_path):
            return []
        now_s = self._clock()
        cutoff_s = int(now_s - self.recent_s)
        live_ids = _live_locked_sessions(self.locks_dir, self.proc_root)
        conn = connect_ro(self.db_path, _POLL_DEADLINE_S)
        try:
            rows = conn.execute(
                "SELECT id, working_directory, model, created_at, last_activity_at, "
                "title, workspace_dirs, COALESCE(hidden, 0) "
                "FROM sessions "
                "WHERE COALESCE(last_activity_at, created_at) >= ? "
                "ORDER BY COALESCE(last_activity_at, created_at) DESC "
                "LIMIT ?",
                (cutoff_s, _SESSIONS_LIMIT),
            ).fetchall()
            out: list[Observation] = []
            for row in rows:
                sid, cwd, model, created_at, last_activity_at, _title, ws_dirs, hidden = row
                if hidden or not isinstance(sid, str) or not _ID_RE.match(sid):
                    continue
                first_s = int(created_at or 0)
                last_s = int(last_activity_at or first_s)
                cmd_count = 0
                evt_count = 0
                try:
                    c_row = conn.execute(
                        "SELECT COUNT(*) FROM tool_call_state WHERE session_id = ?",
                        (sid,),
                    ).fetchone()
                    if c_row and isinstance(c_row[0], int):
                        cmd_count = c_row[0]
                except sqlite3.Error:
                    pass
                try:
                    m_row = conn.execute(
                        "SELECT COUNT(*) FROM message_nodes WHERE session_id = ?",
                        (sid,),
                    ).fetchone()
                    if m_row and isinstance(m_row[0], int):
                        evt_count = m_row[0]
                except sqlite3.Error:
                    pass
                work_dirs = _extract_work_dirs(conn, sid, ws_dirs)
                out.append(
                    Observation(
                        session_id=f"devin-{sid}",
                        agent=AGENT,
                        native_id=sid,
                        cwd=str(cwd or ""),
                        model=str(model or ""),
                        first_activity_ms=first_s * 1000,
                        last_activity_ms=last_s * 1000,
                        command_count=cmd_count,
                        event_count=evt_count,
                        total_tokens=None,
                        source=self.name,
                        unit_id=f"ext-devin-{sid[:8]}",
                        unit_type="scout",
                        label=f"devin · {model}" if model else "devin",
                        live=sid in live_ids,
                        work_dirs=work_dirs,
                    )
                )
            return out
        except sqlite3.Error as exc:
            raise SourceError(f"sqlite_{type(exc).__name__.lower()}") from exc
        finally:
            conn.close()

    def status(self) -> dict[str, Any]:
        return {"dbExists": os.path.isfile(self.db_path)}

    def refresh(self, obs: Observation) -> str:
        return "ok"

    def chat(self, obs: Observation, *, limit: int) -> dict[str, Any]:
        if not os.path.isfile(self.db_path):
            raise SourceError("db_not_found")
        conn = connect_ro(self.db_path, _CHAT_DEADLINE_S)
        try:
            t_row = conn.execute(
                "SELECT title FROM sessions WHERE id = ?",
                (obs.native_id,),
            ).fetchone()
            if t_row is None:
                raise SourceError("session_not_found")
            title = t_row[0] if isinstance(t_row[0], str) else None
            rows = conn.execute(
                "SELECT chat_message, created_at FROM message_nodes "
                "WHERE session_id = ? ORDER BY node_id DESC LIMIT ?",
                (obs.native_id, min(limit * 4, 1600)),
            ).fetchall()
        except sqlite3.Error as exc:
            raise SourceError("db_read_failed") from exc
        finally:
            conn.close()

        messages: list[dict[str, Any]] = []
        for raw_msg, created_at in reversed(rows):
            if not isinstance(raw_msg, str):
                continue
            try:
                data = json.loads(raw_msg)
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            role = data.get("role")
            if role not in ("user", "assistant"):
                continue
            text = _extract_text(data.get("content"))
            if not text:
                continue
            truncated = len(text) > _TEXT_MAX
            messages.append(
                {
                    "role": role,
                    "text": text[:_TEXT_MAX] if truncated else text,
                    "at": int(created_at) * 1000 if isinstance(created_at, (int, float)) else None,
                    "truncated": truncated,
                    "turn": None,
                }
            )
        has_more = len(messages) > limit
        return {
            "available": True,
            "hasMore": has_more,
            "messages": messages[-limit:],
            "title": title,
        }


def source_from_env(*, recent_s: float = 86400.0) -> DevinSource | None:
    if os.environ.get("REPOCIV_DEVIN_SESSIONS", "1").lower() in ("0", "false", "no"):
        return None
    return DevinSource(recent_s=recent_s)
