"""MiniMax Code (mcode) -> RepoCiv: MCode sessions as a read-only external-agent source.

Reads ``~/.minimax/v2/sqlite/runtime-state.sqlite`` in read-only URI mode
(``file:...?mode=ro`` + ``PRAGMA query_only=1``) and checks active process
records in ``~/.minimax-code/.mcode-active/<pid>.json``.
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

from server import session_liveness, subagent_tracker
from server.suvadu_tracker import Observation, SourceError

AGENT = "mcode"
SOURCE_NAME = "mcode"

_SESSIONS_LIMIT = 200
_TEXT_MAX = 4000
_BUSY_TIMEOUT_S = 0.5
_POLL_DEADLINE_S = 2.0
_CHAT_DEADLINE_S = 3.0
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SUBAGENT_NAMES = frozenset({"explore", "verifier", "worker"})


def default_minimax_home() -> str:
    env = os.environ.get("REPOCIV_MCODE_HOME", "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    return os.path.abspath(os.path.expanduser("~/.minimax"))


def default_active_dir() -> str:
    env = os.environ.get("REPOCIV_MCODE_ACTIVE_DIR", "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    return os.path.abspath(os.path.expanduser("~/.minimax-code/.mcode-active"))


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


def _live_mcode_processes(
    active_dir: str,
    proc_root: str = session_liveness.PROC_ROOT,
) -> tuple[set[int], set[str]]:
    """Return ``(live_pids, live_cwds)`` from ``.mcode-active/<pid>.json``."""
    if not os.path.isdir(active_dir):
        return set(), set()
    pids: set[int] = set()
    cwds: set[str] = set()
    for path in glob.glob(os.path.join(active_dir, "*.json")):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        pid = data.get("pid")
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
            continue
        cmd = session_liveness._cmdline(proc_root, str(pid))
        if not cmd:
            continue
        low = cmd.lower()
        if "mcode" not in low and "minimax" not in low and "node" not in low:
            continue
        pids.add(pid)
        cwd = session_liveness._cwd(proc_root, str(pid))
        if cwd:
            cwds.add(os.path.abspath(cwd))
    return pids, cwds


def _model_from_extra(extra_raw: str | None) -> str:
    if not isinstance(extra_raw, str) or not extra_raw.strip():
        return ""
    try:
        data = json.loads(extra_raw)
    except ValueError:
        return ""
    if not isinstance(data, dict):
        return ""
    model = data.get("effectiveModel") or data.get("model")
    return str(model).strip() if isinstance(model, str) else ""


def _extract_message_text(item: dict[str, Any]) -> str:
    for key in ("text", "content"):
        val = item.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
        if isinstance(val, list):
            parts = []
            for entry in val:
                if isinstance(entry, str):
                    parts.append(entry)
                elif isinstance(entry, dict):
                    t = entry.get("text") or entry.get("content")
                    if isinstance(t, str):
                        parts.append(t)
            joined = "\n".join(p.strip() for p in parts if p.strip()).strip()
            if joined:
                return joined
    return ""


class MCodeSource:
    """Read-only source over MiniMax Code's ``runtime-state.sqlite`` + ``.mcode-active/``."""

    name = SOURCE_NAME

    def __init__(
        self,
        minimax_home: str | None = None,
        *,
        active_dir: str | None = None,
        recent_s: float = 86400.0,
        proc_root: str = session_liveness.PROC_ROOT,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.minimax_home = os.path.abspath(os.path.expanduser(minimax_home or default_minimax_home()))
        self.active_dir = os.path.abspath(os.path.expanduser(active_dir or default_active_dir()))
        self.recent_s = recent_s
        self.proc_root = proc_root
        self._clock = clock

    @property
    def db_path(self) -> str:
        return os.path.join(self.minimax_home, "v2", "sqlite", "runtime-state.sqlite")

    def poll(self) -> list[Observation]:
        if not os.path.isfile(self.db_path):
            return []
        now_ms = int(self._clock() * 1000)
        cutoff_ms = int(now_ms - self.recent_s * 1000)
        live_pids, live_cwds = _live_mcode_processes(self.active_dir, self.proc_root)
        conn = connect_ro(self.db_path, _POLL_DEADLINE_S)
        try:
            rows = conn.execute(
                "SELECT session_id, agent_name, status, parent_session_id, "
                "workspace_dir, project_workspace_dir, title, created_at_ms, "
                "updated_at_ms, extra_data_json, session_kind "
                "FROM local_runtime_sessions "
                "WHERE COALESCE(updated_at_ms, created_at_ms) >= ? "
                "ORDER BY COALESCE(updated_at_ms, created_at_ms) DESC "
                "LIMIT ?",
                (cutoff_ms, _SESSIONS_LIMIT),
            ).fetchall()

            token_stats: dict[str, tuple[int, int, str]] = {}
            try:
                for sid_t, turns_t, total_t, model_t in conn.execute(
                    "SELECT session_id, COUNT(*), "
                    "SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + "
                    "COALESCE(reasoning_tokens, 0) + COALESCE(cache_read_tokens, 0) + "
                    "COALESCE(cache_write_tokens, 0)), "
                    "MAX(COALESCE(model, '')) "
                    "FROM local_runtime_token_usage "
                    "GROUP BY session_id"
                ):
                    if isinstance(sid_t, str):
                        token_stats[sid_t] = (
                            int(turns_t or 0),
                            int(total_t or 0),
                            str(model_t or ""),
                        )
            except sqlite3.Error:
                pass

            out: list[Observation] = []
            seen: set[str] = set()
            for row in rows:
                (
                    sid,
                    agent_name,
                    status_val,
                    parent_sid,
                    workspace_dir,
                    project_ws_dir,
                    _title,
                    created_ms,
                    updated_ms,
                    extra_json,
                    session_kind,
                ) = row
                if not isinstance(sid, str) or not _ID_RE.match(sid) or sid in seen:
                    continue
                seen.add(sid)
                cwd = str(workspace_dir or project_ws_dir or "").strip()
                first_ms = int(created_ms or updated_ms or 0)
                last_ms = int(updated_ms or first_ms)
                turns, total_tokens, usage_model = token_stats.get(sid, (0, 0, ""))
                model = _model_from_extra(extra_json) or usage_model

                agent_norm = str(agent_name or "").strip().lower()
                parent_str = str(parent_sid or "").strip()
                is_subagent = bool(parent_str) or agent_norm in _SUBAGENT_NAMES or str(session_kind or "") == "task"
                if is_subagent:
                    unit_type = subagent_tracker.map_kind_to_unit_type(agent_norm or "explore")
                    parent_id = f"mcode-{parent_str}" if parent_str else f"mcode-root-{sid}"
                    label_parts = ["mcode", agent_norm or "subagent", model]
                else:
                    unit_type = "worker"
                    parent_id = None
                    label_parts = ["mcode", model]

                status_norm = str(status_val or "").strip().lower()
                cwd_abs = os.path.abspath(cwd) if cwd else ""
                is_live = bool(
                    live_pids
                    and (
                        status_norm in ("running", "working", "streaming", "active")
                        or (cwd_abs and cwd_abs in live_cwds)
                    )
                )
                ended = status_norm in ("aborted", "completed", "closed") and not is_live
                short_id = sid[4:12] if sid.startswith("mvs_") and len(sid) > 4 else sid[:8]

                out.append(
                    Observation(
                        session_id=f"mcode-{sid}",
                        agent=AGENT,
                        native_id=sid,
                        cwd=cwd,
                        model=model,
                        first_activity_ms=first_ms,
                        last_activity_ms=last_ms,
                        command_count=turns,
                        event_count=turns,
                        total_tokens=total_tokens if total_tokens > 0 else None,
                        parent_id=parent_id,
                        source=self.name,
                        unit_id=f"ext-mcode-{short_id}",
                        unit_type=unit_type,
                        label=" · ".join(p for p in label_parts if p),
                        ended=ended,
                        live=is_live,
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
            s_row = conn.execute(
                "SELECT title FROM local_runtime_sessions WHERE session_id = ?",
                (obs.native_id,),
            ).fetchone()
            if s_row is None:
                raise SourceError("session_not_found")
            title = s_row[0] if isinstance(s_row[0], str) else None
            m_row = conn.execute(
                "SELECT display_messages_json FROM local_runtime_messages WHERE session_id = ?",
                (obs.native_id,),
            ).fetchone()
        except sqlite3.Error as exc:
            raise SourceError("db_read_failed") from exc
        finally:
            conn.close()

        messages: list[dict[str, Any]] = []
        if m_row and isinstance(m_row[0], str) and m_row[0].strip():
            try:
                raw_list = json.loads(m_row[0])
            except ValueError:
                raw_list = []
            if isinstance(raw_list, list):
                for item in raw_list:
                    if not isinstance(item, dict):
                        continue
                    role = str(item.get("role") or "").strip().lower()
                    if role not in ("user", "assistant"):
                        continue
                    text = _extract_message_text(item)
                    if not text:
                        continue
                    truncated = len(text) > _TEXT_MAX
                    at = item.get("createdAtMs") or item.get("timestamp")
                    messages.append(
                        {
                            "role": role,
                            "text": text[:_TEXT_MAX] if truncated else text,
                            "at": int(at) if isinstance(at, (int, float)) else None,
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


def source_from_env(*, recent_s: float = 86400.0) -> MCodeSource | None:
    if os.environ.get("REPOCIV_MCODE_SESSIONS", "1").lower() in ("0", "false", "no"):
        return None
    return MCodeSource(recent_s=recent_s)
