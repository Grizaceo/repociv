"""OpenCode (opencode) -> RepoCiv: sessions from the local opencode service.

Reads ``~/.local/share/opencode/opencode.db`` (``session_v2`` +
``session_message``) in read-only URI mode (``file:...?mode=ro`` +
``PRAGMA query_only=1``) and asks the running opencode service which sessions
are working right now (``opencode api get /api/session/active``), with an
``opencode`` /proc scan as fallback.

Sessions RepoCiv launches itself (``agent_runner._run_opencode_streaming``) use
ids under the reserved ``ses_repociv-`` prefix, so they are skipped here: their
mission unit already stands on the map.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
from typing import Any, Callable
from urllib.parse import quote

from server import session_liveness, subagent_tracker
from server.suvadu_tracker import Observation, SourceError

AGENT = "opencode"
SOURCE_NAME = "opencode"

_SESSIONS_LIMIT = 200
_TEXT_MAX = 4000
_BUSY_TIMEOUT_S = 0.5
_POLL_DEADLINE_S = 2.0
_CHAT_DEADLINE_S = 3.0
_ACTIVE_TIMEOUT_S = 1.5
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_OWNED_PREFIX = "ses_repociv-"
_OPENCODE_RE = re.compile(r"(?:^|[/\s])opencode(?:\.(?:exe|js))?(?:\s|$)")
# session_v2.agent for subagent sessions; opencode's built-in kinds.
_SUBAGENT_NAMES = frozenset({"explore", "general", "verifier", "worker", "scout"})


def default_data_dir() -> str:
    env = os.environ.get("REPOCIV_OPENCODE_DATA_DIR", "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    xdg = os.environ.get("XDG_DATA_HOME", "").strip()
    base = os.path.expanduser(xdg) if xdg else os.path.expanduser("~/.local/share")
    return os.path.abspath(os.path.join(base, "opencode"))


def default_bin() -> str:
    env = os.environ.get("REPOCIV_OPENCODE_BIN", "").strip()
    if env:
        return env
    return shutil.which("opencode") or ""


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


def _running_session_ids(bin_path: str, *, timeout_s: float = _ACTIVE_TIMEOUT_S) -> frozenset[str] | None:
    """Exact liveness: ids the service reports as ``running``, or None (unknown).

    ``opencode api`` exits 0 even for HTTP errors, so the body is the contract;
    anything unparseable degrades to None instead of a wrong answer.
    """
    if not bin_path:
        return None
    try:
        proc = subprocess.run(
            [bin_path, "api", "get", "/api/session/active"],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env=dict(os.environ, OPENCODE_NO_UPDATE="1"),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    try:
        payload = json.loads((proc.stdout or "").strip() or "{}")
    except ValueError:
        return None
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    return frozenset(
        sid
        for sid, entry in data.items()
        if isinstance(sid, str) and isinstance(entry, dict) and entry.get("type") == "running"
    )


def _live_opencode_cwds(proc_root: str = session_liveness.PROC_ROOT) -> frozenset[str]:
    """Fallback when the service cannot be asked: cwds of live ``opencode`` processes."""
    try:
        names = [name for name in os.listdir(proc_root) if name.isdigit()]
    except OSError:
        return frozenset()
    cwds: set[str] = set()
    for name in names:
        cmd = session_liveness._cmdline(proc_root, name)
        if cmd and _OPENCODE_RE.search(cmd):
            cwd = session_liveness._cwd(proc_root, name)
            if cwd:
                cwds.add(os.path.abspath(cwd))
    return frozenset(cwds)


def _model_label(raw: Any) -> str:
    """``session_v2.model`` JSON ({"id","providerID","variant"}) → display label."""
    if not isinstance(raw, str) or not raw.strip():
        return ""
    try:
        data = json.loads(raw)
    except ValueError:
        return ""
    if not isinstance(data, dict):
        return ""
    model_id = data.get("id")
    if not isinstance(model_id, str) or not model_id.strip():
        return ""
    provider = data.get("providerID")
    label = f"{provider}/{model_id}" if isinstance(provider, str) and provider else model_id
    variant = data.get("variant")
    if isinstance(variant, str) and variant not in ("", "default"):
        label = f"{label}#{variant}"
    return label


def _strip_json_string(text: str) -> str:
    """The CLI stores the prompt argument JSON-encoded (``"text":"\\"...\\""``)."""
    if len(text) >= 2 and text.startswith('"') and text.endswith('"'):
        try:
            unwrapped = json.loads(text)
        except ValueError:
            return text
        if isinstance(unwrapped, str):
            return unwrapped
    return text


def _extract_user_text(item: dict[str, Any]) -> str:
    text = item.get("text")
    return _strip_json_string(text).strip() if isinstance(text, str) else ""


def _extract_assistant_text(item: dict[str, Any]) -> str:
    content = item.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for entry in content:
        if not isinstance(entry, dict) or entry.get("type") != "text":
            continue
        text = entry.get("text")
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
    return "\n".join(parts).strip()


class OpenCodeSource:
    """Read-only source over the local opencode database and service."""

    name = SOURCE_NAME

    def __init__(
        self,
        data_dir: str | None = None,
        *,
        bin_path: str | None = None,
        recent_s: float = 86400.0,
        proc_root: str = session_liveness.PROC_ROOT,
        clock: Callable[[], float] = time.time,
        active_ids: Callable[[], frozenset[str] | None] | None = None,
    ) -> None:
        self.data_dir = os.path.abspath(os.path.expanduser(data_dir or default_data_dir()))
        self.bin_path = default_bin() if bin_path is None else bin_path
        self.recent_s = recent_s
        self.proc_root = proc_root
        self._clock = clock
        self._active_ids = active_ids

    @property
    def db_path(self) -> str:
        return os.path.join(self.data_dir, "opencode.db")

    def _liveness(self) -> tuple[frozenset[str], frozenset[str] | None]:
        """Return ``(live_cwds, live_ids)``; ids is None when the service did not answer."""
        ids = self._active_ids() if self._active_ids is not None else _running_session_ids(self.bin_path)
        if ids is not None:
            return frozenset(), ids
        return _live_opencode_cwds(self.proc_root), None

    def poll(self) -> list[Observation]:
        if not os.path.isfile(self.db_path):
            return []
        now_ms = int(self._clock() * 1000)
        cutoff_ms = int(now_ms - self.recent_s * 1000)
        conn = connect_ro(self.db_path, _POLL_DEADLINE_S)
        try:
            rows = conn.execute(
                "SELECT id, parent_id, directory, title, agent, model, "
                "time_created, time_updated, time_archived, "
                "tokens_input, tokens_output, tokens_reasoning, "
                "tokens_cache_read, tokens_cache_write "
                "FROM session_v2 "
                "WHERE COALESCE(time_updated, time_created) >= ? "
                "ORDER BY COALESCE(time_updated, time_created) DESC "
                "LIMIT ?",
                (cutoff_ms, _SESSIONS_LIMIT),
            ).fetchall()
            ids = [str(row[0]) for row in rows if isinstance(row[0], str) and row[0] not in ("",)]
            message_counts: dict[str, int] = {}
            if ids:
                placeholders = ",".join("?" for _ in ids)
                try:
                    for sid, count in conn.execute(
                        "SELECT session_id, COUNT(*) FROM session_message "
                        f"WHERE session_id IN ({placeholders}) GROUP BY session_id",
                        ids,
                    ):
                        if isinstance(sid, str):
                            message_counts[sid] = int(count or 0)
                except sqlite3.Error:
                    pass
        except sqlite3.Error as exc:
            raise SourceError(f"sqlite_{type(exc).__name__.lower()}") from exc
        finally:
            conn.close()

        live_cwds, live_ids = self._liveness()

        out: list[Observation] = []
        seen: set[str] = set()
        for row in rows:
            (
                sid,
                parent_sid,
                directory,
                _title,
                agent,
                model_raw,
                created_ms,
                updated_ms,
                archived_ms,
                tok_in,
                tok_out,
                tok_reasoning,
                tok_cache_read,
                tok_cache_write,
            ) = row
            if not isinstance(sid, str) or not _ID_RE.match(sid) or sid in seen:
                continue
            seen.add(sid)
            if sid.startswith(_OWNED_PREFIX):
                continue  # a RepoCiv mission's own thread: its unit already exists
            cwd = str(directory or "").strip()
            cwd_abs = os.path.abspath(cwd) if cwd else ""
            first_ms = int(created_ms or updated_ms or 0)
            last_ms = int(updated_ms or first_ms)
            model = _model_label(model_raw)
            turns = message_counts.get(sid, 0)
            total = sum(
                int(value or 0)
                for value in (tok_in, tok_out, tok_reasoning, tok_cache_read, tok_cache_write)
            )

            agent_norm = str(agent or "").strip().lower()
            parent_str = str(parent_sid or "").strip()
            is_subagent = bool(parent_str) or agent_norm in _SUBAGENT_NAMES
            if is_subagent:
                unit_type = subagent_tracker.map_kind_to_unit_type(agent_norm or "explore")
                parent_id = f"opencode-{parent_str}" if parent_str else f"opencode-root-{sid}"
                label_parts = ["opencode", agent_norm or "subagent", model]
            else:
                unit_type = "worker"
                parent_id = None
                label_parts = ["opencode", model]

            if live_ids is not None:
                is_live = sid in live_ids
            else:
                is_live = bool(cwd_abs and cwd_abs in live_cwds)
            ended = bool(archived_ms) and not is_live
            short_id = sid[4:12] if sid.startswith("ses_") and len(sid) > 4 else sid[:8]

            out.append(
                Observation(
                    session_id=f"opencode-{sid}",
                    agent=AGENT,
                    native_id=sid,
                    cwd=cwd,
                    model=model,
                    first_activity_ms=first_ms,
                    last_activity_ms=last_ms,
                    command_count=turns,
                    event_count=turns,
                    total_tokens=total if total > 0 else None,
                    parent_id=parent_id,
                    source=self.name,
                    unit_id=f"ext-opencode-{short_id}",
                    unit_type=unit_type,
                    label=" · ".join(part for part in label_parts if part),
                    ended=ended,
                    live=is_live,
                )
            )
        return out

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
                "SELECT title FROM session_v2 WHERE id = ?",
                (obs.native_id,),
            ).fetchone()
            if s_row is None:
                raise SourceError("session_not_found")
            title = s_row[0] if isinstance(s_row[0], str) else None
            rows = conn.execute(
                "SELECT type, data FROM session_message WHERE session_id = ? "
                "ORDER BY seq DESC LIMIT ?",
                (obs.native_id, limit * 4),
            ).fetchall()
        except sqlite3.Error as exc:
            raise SourceError("db_read_failed") from exc
        finally:
            conn.close()

        messages: list[dict[str, Any]] = []
        for msg_type, data_raw in reversed(rows):
            kind = str(msg_type or "").strip().lower()
            if kind not in ("user", "assistant") or not isinstance(data_raw, str):
                continue
            try:
                data = json.loads(data_raw)
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            text = _extract_user_text(data) if kind == "user" else _extract_assistant_text(data)
            if not text:
                continue
            at_ms = None
            time_obj = data.get("time")
            if isinstance(time_obj, dict) and isinstance(time_obj.get("created"), (int, float)):
                at_ms = int(time_obj["created"])
            truncated = len(text) > _TEXT_MAX
            messages.append(
                {
                    "role": kind,
                    "text": text[:_TEXT_MAX] if truncated else text,
                    "at": at_ms,
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


def source_from_env(*, recent_s: float = 86400.0) -> OpenCodeSource | None:
    if os.environ.get("REPOCIV_OPENCODE_SESSIONS", "1").lower() in ("0", "false", "no"):
        return None
    return OpenCodeSource(recent_s=recent_s)
