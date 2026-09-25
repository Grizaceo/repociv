"""Hermes → RepoCiv: Hermes Agent sessions as a source of external agents.

Suvadu has no Hermes integration and Hermes runs its tools without shell
hooks, so Hermes sessions never reach Suvadu. Hermes keeps them itself, in
SQLite: ``~/.hermes/state.db`` (profile ``default``) and
``~/.hermes/profiles/<name>/state.db`` (one per profile). This module reads
those files and hands the tracker (``server/suvadu_tracker.py``) the same
``Observation`` records Suvadu produces.

Read-only by construction — the root file is ~7 GB and Hermes is writing to it:

  * every connection is ``file:<db>?mode=ro`` with a short busy timeout,
    ``PRAGMA query_only`` and a progress-handler deadline; nothing here writes,
    vacuums, checkpoints or rebuilds FTS;
  * each poll opens, runs bounded queries and closes, so no read transaction
    lingers and pins the WAL;
  * the session query rides ``idx_sessions_effective_activity`` (the WHERE
    expression must match ``COALESCE(last_activity_at, started_at)``
    verbatim for the planner to use it) with a LIMIT; parents and message
    heads are primary-key / ``idx_messages_session`` lookups.

What goes where (decided by the user, 2026-09-19):

  * map + "Activos": cli, desktop, tui, hermes_browser, kanban, subagent;
  * panel only, "Cron" section: cron;
  * panel only, "Gateway" section: telegram, discord, api_server… — every
    other origin;
  * never: sessions RepoCiv launched itself (``--source tool`` and the ids in
    ``~/.repociv/hermes-sessions.json``), their subagents, and hidden sessions.

Liveness is ``last_activity_at`` (refreshed about once a minute) or the newest
message, never ``ended_at IS NULL``: hundreds of sessions were never closed.
A session Hermes did close (``ended_at`` after its last activity) leaves the
map at once. When Hermes compresses a long conversation it closes the session
(``end_reason='compression'``) and continues in a child; the chain keeps one
unit, keyed by its first session.

Where a unit stands comes from the session's own recent tool calls: the
``path``/``workdir`` of its file tools and the ``cd`` of its commands
(``Observation.work_dirs``), which the tracker counts per repo — one unit, in
the repo most of the latest mentions name. ``git_repo_root``/``cwd`` decide only
when the activity names no repo often enough: desktop rows carry no cwd, and a
CLI launched from ~ keeps ~ for its whole life.

Privacy is the tracker's: metadata only in polls; chat text (user and
assistant turns, plus the *names* of the tools used — never tool output or
arguments) only through the token-protected chat endpoint.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Sequence
from urllib.parse import quote

from server.suvadu_tracker import Observation, SourceError
from server.transcript_work import dirs_from_hints

AGENT = "hermes"
MAP_ORIGINS = frozenset({"cli", "desktop", "tui", "hermes_browser", "kanban", "subagent"})
CRON_ORIGINS = frozenset({"cron"})
REPOCIV_ORIGINS = frozenset({"tool"})  # agent_runner launches `hermes chat --source tool`

_ACTIVITY = "COALESCE(last_activity_at, started_at)"  # = idx_sessions_effective_activity
_SESSIONS_LIMIT = 200  # per database, newest activity first
_CHAIN_MAX = 25  # parent hops followed per session
_TEXT_MAX = 4000  # chars per chat message, like Suvadu
_TOOLS_MAX = 40  # tool names kept per tool group
_BUSY_TIMEOUT_S = 0.5
_POLL_DEADLINE_S = 2.0  # per database
_CHAT_DEADLINE_S = 3.0
_ENDED_SLACK_MS = 5_000
_LIVE_SLACK_MS = 120_000  # last_activity_at trails the newest message by ≤ ~60 s
_WORK_ROWS = 60  # newest tool-call messages read per session for its work folders
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_PATH_HINT_RE = re.compile(r'"(?:path|workdir)"\s*:\s*"([^"]+)"')
_CD_HINT_RE = re.compile(r"(?:^|&&|;|\|\|)\s*cd\s+(['\"]?)(~/[^'\"\s;&|]*|/[^'\"\s;&|]*)")
_CMD_TOOLS = frozenset({"terminal", "execute_code", "process_manage"})


# ─── Config ──────────────────────────────────────────────────────────────────
def _csv_env(name: str) -> frozenset[str]:
    return frozenset(p.strip() for p in os.environ.get(name, "").split(",") if p.strip())


def repociv_sessions_file() -> str:
    """agent_runner's (profile|unit|city) → Hermes session id map."""
    config_dir = os.environ.get("REPOCIV_CONFIG_DIR", "") or os.path.join(os.path.expanduser("~"), ".repociv")
    return os.path.join(os.path.expanduser(config_dir), "hermes-sessions.json")


def repociv_session_ids(path: str | None = None) -> frozenset[str]:
    """Session ids of the Hermes missions RepoCiv launched (they have their own unit)."""
    try:
        with open(path or repociv_sessions_file(), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return frozenset()
    if not isinstance(data, dict):
        return frozenset()
    return frozenset(v for v in data.values() if isinstance(v, str) and v)


def unit_id_for(profile: str, chain_root: str) -> str:
    """Hermes ids start with the date (20260919_061733_615e9a): a prefix would
    collide, so the unit id is a short hash of profile + first session id."""
    digest = hashlib.sha1(f"{profile}\0{chain_root}".encode()).hexdigest()
    return f"ext-hermes-{digest[:8]}"


def unit_type_for(profile: str) -> str:
    return "lexo" if profile.lower().startswith("lexo") else "hero"


def section_for(origin: str) -> str:
    if origin in MAP_ORIGINS:
        return ""
    if origin in CRON_ORIGINS:
        return "cron"
    return "gateway"


def _short_model(model: str) -> str:
    return model.rsplit("/", 1)[-1]


# ─── SQLite, read-only ───────────────────────────────────────────────────────
def _error_code(exc: sqlite3.Error) -> str:
    msg = str(exc).lower()
    if "locked" in msg or "busy" in msg:
        return "locked"
    if "interrupted" in msg:
        return "timeout"
    if "unable to open" in msg:
        return "cannot_open"
    if "no such table" in msg or "no such column" in msg:
        return "schema"
    if "not a database" in msg or "malformed" in msg:
        return "corrupt"
    return "sqlite_error"


def connect_ro(path: str, deadline_s: float) -> sqlite3.Connection:
    """Read-only connection that gives up after ``deadline_s`` of work."""
    if not os.path.isfile(path):
        raise SourceError("db_not_found")
    try:
        conn = sqlite3.connect(f"file:{quote(path)}?mode=ro", uri=True, timeout=_BUSY_TIMEOUT_S)
        conn.execute("PRAGMA query_only = 1")
    except sqlite3.Error as exc:
        raise SourceError(_error_code(exc)) from exc
    stop_at = time.monotonic() + deadline_s
    conn.set_progress_handler(lambda: 1 if time.monotonic() > stop_at else 0, 5_000)
    return conn


@dataclass
class _Schema:
    session_cols: frozenset[str]
    message_cols: frozenset[str]

    @property
    def activity(self) -> str:
        return _ACTIVITY if "last_activity_at" in self.session_cols else "started_at"


def _schema(conn: sqlite3.Connection) -> _Schema:
    def cols(table: str) -> frozenset[str]:
        return frozenset(r[1] for r in conn.execute(f"PRAGMA table_info({table})"))

    session_cols, message_cols = cols("sessions"), cols("messages")
    if not session_cols:
        raise SourceError("schema")
    return _Schema(session_cols, message_cols)


def _col(schema: _Schema, name: str, table: str = "sessions") -> str:
    cols = schema.session_cols if table == "sessions" else schema.message_cols
    return name if name in cols else f"NULL AS {name}"


# ─── Sessions → observations ─────────────────────────────────────────────────
@dataclass
class _Row:
    id: str
    origin: str
    model: str
    parent: str | None
    started_s: float
    ended_s: float | None
    end_reason: str
    messages: int
    tools: int
    tokens: int | None
    cwd: str
    activity_s: float
    hidden: bool


_ROW_COLS = (
    "id, source, model, parent_session_id, started_at, ended_at, {end_reason}, message_count, "
    "tool_call_count, input_tokens, output_tokens, {repo_root}, {cwd}, {activity}, {hidden}"
)


def _row_sql(schema: _Schema) -> str:
    return _ROW_COLS.format(
        end_reason=_col(schema, "end_reason"),
        repo_root=_col(schema, "git_repo_root"),
        cwd=_col(schema, "cwd"),
        activity=f"{schema.activity} AS activity",
        hidden=_col(schema, "hidden"),
    )


def _as_row(r: tuple[Any, ...]) -> _Row | None:
    (sid, origin, model, parent, started, ended, end_reason, n_msg, n_tool,
     tok_in, tok_out, repo_root, cwd, activity, hidden) = r
    if not isinstance(sid, str) or not isinstance(started, (int, float)):
        return None
    tokens = None if tok_in is None and tok_out is None else int(tok_in or 0) + int(tok_out or 0)
    return _Row(
        id=sid,
        origin=origin if isinstance(origin, str) and origin else "unknown",
        model=model if isinstance(model, str) else "",
        parent=parent if isinstance(parent, str) and parent else None,
        started_s=float(started),
        ended_s=float(ended) if isinstance(ended, (int, float)) else None,
        end_reason=end_reason if isinstance(end_reason, str) else "",
        messages=int(n_msg or 0),
        tools=int(n_tool or 0),
        tokens=tokens,
        cwd=(repo_root if isinstance(repo_root, str) and repo_root else cwd if isinstance(cwd, str) else ""),
        activity_s=float(activity) if isinstance(activity, (int, float)) else float(started),
        hidden=bool(hidden),
    )


def _work_dirs(conn: sqlite3.Connection, sids: Sequence[str]) -> tuple[str, ...]:
    """Folders a session's recent tool calls touched, newest first, one per mention.

    Read over the whole compression chain (``sids``): a child fresh from
    compression has barely any calls of its own. Which repo those folders make
    the unit's city is the tracker's call (``suvadu_tracker.work_place``), since
    only it knows the map. Best effort: any sqlite error (old schema, poll
    deadline) returns nothing and the row's cwd decides, as it always did.
    """
    marks = ",".join("?" * len(sids))
    try:
        raw = conn.execute(
            f"SELECT tool_calls FROM messages WHERE session_id IN ({marks}) AND tool_calls IS NOT NULL "
            f"ORDER BY id DESC LIMIT {_WORK_ROWS}",
            tuple(sids),
        ).fetchall()
    except sqlite3.Error:
        return ()
    hints: list[str] = []
    for (tc,) in raw:
        try:
            calls = json.loads(tc or "[]")
        except (ValueError, TypeError):
            continue
        for call in reversed(calls) if isinstance(calls, list) else []:  # newest first
            fn = call.get("function") if isinstance(call, dict) else None
            if not isinstance(fn, dict):
                continue
            args = fn.get("arguments")
            if not isinstance(args, str):
                continue
            try:
                data = json.loads(args) if args else None
            except (ValueError, TypeError):
                data = None
            if isinstance(data, dict):
                for key in ("path", "workdir"):
                    value = data.get(key)
                    if isinstance(value, str):
                        hints.append(value)
                if fn.get("name") in _CMD_TOOLS:
                    cmd = data.get("command")
                    if isinstance(cmd, str):
                        hints.extend(m.group(2) for m in _CD_HINT_RE.finditer(cmd))
            else:  # truncated or non-JSON arguments: the raw string is all we have
                hints.extend(m.group(1) for m in _PATH_HINT_RE.finditer(args))
                if fn.get("name") in _CMD_TOOLS:
                    hints.extend(m.group(2) for m in _CD_HINT_RE.finditer(args))
    return dirs_from_hints(hints)


def _continues(child: _Row, parent: _Row) -> bool:
    """A compression child is the same conversation; a subagent is not."""
    return child.origin != "subagent" and parent.end_reason == "compression"


@dataclass
class _Lineage:
    chain_root: _Row  # first session of the compression chain
    chain: list[str]  # this session and its compression ancestors, newest first
    delegator: str | None  # parent session when this one is a subagent
    root_origin: str  # origin of the topmost ancestor (cron → cron section…)
    ids: set[str] = field(default_factory=set)  # every ancestor id seen


_WorkMemo = tuple[tuple[int, int, float], tuple[str, ...]]  # (messages, tools, activity), work dirs


class _Rows:
    """Per-poll PK cache over one database, plus the work folders carried over
    from its previous poll."""

    def __init__(self, conn: sqlite3.Connection, schema: _Schema, rows: list[_Row],
                 prior_work: dict[str, _WorkMemo] | None = None) -> None:
        self._conn = conn
        self._sql = f"SELECT {_row_sql(schema)} FROM sessions WHERE id = ?"
        self._by_id: dict[str, _Row | None] = {row.id: row for row in rows}
        self._prior_work = prior_work or {}
        self.work: dict[str, _WorkMemo] = {}

    def work_dirs(self, row: _Row, chain: Sequence[str]) -> tuple[str, ...]:
        """:func:`_work_dirs`, reused while the session gains no activity: most
        of the 24 h list never does, and reading tool calls is the bulk of a poll."""
        stamp = (row.messages, row.tools, row.activity_s)
        memo = self._prior_work.get(row.id)
        dirs = memo[1] if memo is not None and memo[0] == stamp else _work_dirs(self._conn, chain)
        self.work[row.id] = (stamp, dirs)
        return dirs

    def get(self, sid: str) -> _Row | None:
        if sid not in self._by_id:
            found = self._conn.execute(self._sql, (sid,)).fetchone()
            self._by_id[sid] = _as_row(found) if found else None
        return self._by_id[sid]

    def lineage(self, row: _Row) -> _Lineage:
        lin = _Lineage(chain_root=row, chain=[row.id], delegator=None, root_origin=row.origin, ids={row.id})
        in_chain = True
        current = row
        for _ in range(_CHAIN_MAX):
            if current.parent is None or current.parent in lin.ids:
                break
            parent = self.get(current.parent)
            if parent is None:
                break
            if in_chain and _continues(current, parent):
                lin.chain_root = parent
                lin.chain.append(parent.id)
            elif in_chain:
                in_chain = False
                lin.delegator = parent.id
            lin.ids.add(parent.id)
            lin.root_origin = parent.origin
            current = parent
        return lin


@dataclass
class _Db:
    profile: str
    path: str


class HermesSource:
    """Every readable Hermes state.db → Observation list (see module doc)."""

    name = "hermes"

    def __init__(
        self,
        home: str,
        *,
        recent_s: float = 86400.0,
        window_s: float = 600.0,
        exclude: frozenset[str] = frozenset(),
        owned_ids: Callable[[], frozenset[str]] = repociv_session_ids,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.home = os.path.abspath(os.path.expanduser(home))
        self.recent_s = recent_s
        self.window_s = window_s
        self.exclude = exclude
        self._owned_ids = owned_ids
        self._clock = clock
        self._last: dict[str, list[Observation]] = {}  # per profile, for failing dbs
        self._work: dict[str, dict[str, _WorkMemo]] = {}  # per profile, see _Rows.work_dirs
        self._errors: dict[str, str] = {}
        self._dbs = 0

    # -- discovery -----------------------------------------------------------
    def databases(self) -> list[_Db]:
        dbs = [_Db("default", os.path.join(self.home, "state.db"))]
        for path in sorted(glob.glob(os.path.join(self.home, "profiles", "*", "state.db"))):
            profile = os.path.basename(os.path.dirname(path))
            if _NAME_RE.match(profile) and profile != "default":
                dbs.append(_Db(profile, path))
        return [db for db in dbs if db.profile not in self.exclude]

    def reads_profile(self, profile: str) -> bool:
        return any(db.profile == profile and os.path.isfile(db.path) for db in self.databases())

    def _db_path(self, profile: str) -> str | None:
        return next((db.path for db in self.databases() if db.profile == profile), None)

    # -- AgentSource ---------------------------------------------------------
    def poll(self) -> list[Observation]:
        if not os.path.isdir(self.home):
            raise SourceError("hermes_not_found")
        now_s = self._clock()
        owned = self._owned_ids()
        out: list[Observation] = []
        errors: dict[str, str] = {}
        read = 0
        dbs = self.databases()
        for db in dbs:
            if not os.path.isfile(db.path):
                if db.profile == "default":
                    errors[db.profile] = "db_not_found"
                continue
            try:
                seen = self._poll_db(db, now_s, owned)
            except SourceError as exc:
                errors[db.profile] = str(exc)
                seen = self._last.get(db.profile, [])
            except sqlite3.Error as exc:
                errors[db.profile] = _error_code(exc)
                seen = self._last.get(db.profile, [])
            else:
                read += 1
                self._last[db.profile] = seen
            out.extend(seen)
        self._errors, self._dbs = errors, read
        if read == 0 and errors:
            raise SourceError(next(iter(errors.values())))
        return out

    def _poll_db(self, db: _Db, now_s: float, owned: frozenset[str]) -> list[Observation]:
        conn = connect_ro(db.path, _POLL_DEADLINE_S)
        try:
            schema = _schema(conn)
            since = now_s - self.recent_s
            raw = conn.execute(
                f"SELECT {_row_sql(schema)} FROM sessions WHERE {schema.activity} >= ? "
                f"ORDER BY {schema.activity} DESC LIMIT {_SESSIONS_LIMIT}",
                (since,),
            ).fetchall()
            rows = [row for row in map(_as_row, raw) if row is not None]
            cache = _Rows(conn, schema, rows, self._work.get(db.profile))
            out: list[Observation] = []
            for row in rows:
                obs = self._observe(conn, db.profile, row, cache, now_s, owned)
                if obs is not None:
                    out.append(obs)
            self._work[db.profile] = cache.work  # sessions gone from the list drop out
            return out
        finally:
            conn.close()

    def _observe(
        self,
        conn: sqlite3.Connection,
        profile: str,
        row: _Row,
        cache: _Rows,
        now_s: float,
        owned: frozenset[str],
    ) -> Observation | None:
        if row.hidden or not _ID_RE.match(row.id):
            return None
        lin = cache.lineage(row)
        if lin.ids & owned or any(
            (anc := cache.get(i)) is not None and anc.origin in REPOCIV_ORIGINS for i in lin.ids
        ):
            return None  # RepoCiv's own mission (or its subagent): it already has a unit
        last_s = row.activity_s
        if now_s - last_s <= self.window_s + _LIVE_SLACK_MS / 1000:
            newest = conn.execute("SELECT max(timestamp) FROM messages WHERE session_id = ?", (row.id,)).fetchone()
            if newest and isinstance(newest[0], (int, float)):
                last_s = max(last_s, float(newest[0]))
        last_ms = int(last_s * 1000)
        ended = row.ended_s is not None and int(row.ended_s * 1000) >= last_ms - _ENDED_SLACK_MS
        origin = row.origin
        section = section_for(lin.root_origin if origin == "subagent" else origin)
        root = lin.chain_root
        model = row.model
        return Observation(
            session_id=f"hermes-{profile}-{root.id}",
            agent=AGENT,
            native_id=row.id,
            cwd=row.cwd,
            model=model,
            first_activity_ms=int(root.started_s * 1000),
            last_activity_ms=last_ms,
            command_count=row.tools,
            event_count=row.messages,
            total_tokens=row.tokens,
            parent_id=lin.delegator,
            source=self.name,
            unit_id=unit_id_for(profile, root.id),
            unit_type=unit_type_for(profile),
            label=" · ".join(p for p in (profile, _short_model(model), origin) if p),
            section=section,
            ended=ended,
            profile=profile,
            origin=origin,
            work_dirs=cache.work_dirs(row, lin.chain),
        )

    def status(self) -> dict[str, Any]:
        return {"databases": self._dbs, "dbErrors": dict(self._errors)}

    def refresh(self, obs: Observation) -> str:
        return "ok"  # the database is live; there is nothing to import

    # -- chat ------------------------------------------------------------------
    def chat(self, obs: Observation, *, limit: int) -> dict[str, Any]:
        """User and assistant turns of the session (and of the sessions it
        continues after compression), plus the names of the tools used."""
        path = self._db_path(obs.profile)
        if path is None:
            raise SourceError("db_not_found")
        conn = connect_ro(path, _CHAT_DEADLINE_S)
        try:
            schema = _schema(conn)
            cache = _Rows(conn, schema, [])
            row = cache.get(obs.native_id)
            if row is None:
                raise SourceError("session_not_found")
            title = None
            if "title" in schema.session_cols:
                found = conn.execute("SELECT title FROM sessions WHERE id = ?", (row.id,)).fetchone()
                title = found[0] if found and isinstance(found[0], str) else None
            cap = min(limit * 6, 2400)
            raw, more = self._messages(conn, schema, cache, row, cap)
        except sqlite3.Error as exc:
            raise SourceError(_error_code(exc)) from exc
        finally:
            conn.close()
        messages = collapse(reversed(raw))
        return {
            "available": True,
            "hasMore": more or len(messages) > limit,
            "messages": messages[-limit:],
            "title": title,
        }

    @staticmethod
    def _messages(
        conn: sqlite3.Connection, schema: _Schema, cache: _Rows, row: _Row, cap: int
    ) -> tuple[list[tuple[Any, ...]], bool]:
        """Newest-first message rows across the compression chain, ≤ cap."""
        filters = ["role IN ('user', 'assistant', 'tool')"]
        if "display_kind" in schema.message_cols:
            filters.append("display_kind IS NULL")  # hidden notes, process_complete…
        if {"active", "compacted"} <= schema.message_cols:
            filters.append("(active = 1 OR compacted = 1)")  # what Hermes itself displays
        if "_compressed_summary" in schema.message_cols:
            filters.append("_compressed_summary = 0")  # the compaction digest
        sql = (
            "SELECT role, CASE WHEN role IN ('user', 'assistant') "
            f"THEN substr(content, 1, {_TEXT_MAX + 1}) END, tool_name, timestamp "
            f"FROM messages WHERE session_id = ? AND {' AND '.join(filters)} "
            "ORDER BY timestamp DESC, id DESC LIMIT ?"
        )
        out: list[tuple[Any, ...]] = []
        current: _Row | None = row
        for _ in range(_CHAIN_MAX):
            if current is None:
                return out, False
            out.extend(conn.execute(sql, (current.id, cap - len(out) + 1)).fetchall())
            if len(out) > cap:
                return out[:cap], True
            parent = cache.get(current.parent) if current.parent else None
            current = parent if parent is not None and _continues(current, parent) else None
        return out, current is not None


def collapse(rows: Iterable[tuple[Any, ...]]) -> list[dict[str, Any]]:
    """Chronological (role, text, tool_name, ts) rows → chat messages.

    Consecutive tool results fold into one ``tool`` entry holding only the tool
    names; assistant turns without text (pure tool calls) are dropped."""
    out: list[dict[str, Any]] = []
    for role, text, tool_name, ts in rows:
        at = int(ts * 1000) if isinstance(ts, (int, float)) else None
        if role == "tool":
            name = tool_name if isinstance(tool_name, str) and tool_name else "tool"
            last = out[-1] if out else None
            if last is not None and last["role"] == "tool":
                if len(last["tools"]) < _TOOLS_MAX:
                    last["tools"].append(name)
                continue
            out.append({"role": "tool", "text": "", "tools": [name], "at": at, "truncated": False, "turn": None})
            continue
        if not isinstance(text, str) or not text.strip():
            continue
        out.append({
            "role": "user" if role == "user" else "assistant",
            "text": text[:_TEXT_MAX],
            "at": at,
            "truncated": len(text) > _TEXT_MAX,
            "turn": None,
        })
    return out


# ─── Wiring ──────────────────────────────────────────────────────────────────
def source_from_env(*, recent_s: float = 86400.0, window_s: float = 600.0) -> HermesSource | None:
    """The Hermes source, or None when REPOCIV_HERMES_SESSIONS=0."""
    if os.environ.get("REPOCIV_HERMES_SESSIONS", "1").lower() in ("0", "false", "no"):
        return None
    return HermesSource(
        os.environ.get("REPOCIV_HERMES_HOME", "") or "~/.hermes",
        recent_s=recent_s,
        window_s=window_s,
        exclude=_csv_env("REPOCIV_HERMES_PROFILES_EXCLUDE"),
    )
