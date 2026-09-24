"""External AI-agent sessions → RepoCiv: ephemeral map units + Agents panel.

Two sources feed one tracker (``AgentSource``):

  * Suvadu (`suv`, github.com/AppachiTech/suvadu) records the Claude Code /
    Codex / Cursor / OpenCode sessions that run on this machine, whoever
    launched them (``SuvaduSource``, below).
  * Hermes keeps its own sessions in ``~/.hermes/state.db`` and one state.db
    per profile (``server/hermes_sessions.py``).

The tracker polls every ~30 s and mirrors the recently active sessions onto
the map:

  * spawn   — a session with activity in the last WINDOW minutes becomes an
              ephemeral unit ``ext-<agent>-<native_id[:8]>`` in the city it is
              working in: the repo most of its latest touched folders belong
              to (``Observation.work_dirs``, Hermes), else the city whose repo
              path is the longest prefix of the session cwd (else capital);
  * state   — ``working`` while the last activity is fresh, ``idle`` once it ages;
  * despawn — when the last activity falls out of the window.

Two read-only CLI calls (argv, no shell) feed each poll:

  - ``suv agent sessions`` — the session list (agent, cwd, model, counts).
    Suvadu only (re)imports a Claude Code session on UserPromptSubmit / Stop /
    SessionEnd, so ``last_activity_at`` freezes during a long agent turn and a
    brand-new session is missing until its first turn ends.
  - ``suv history --executor agent --json`` — agent commands recorded live by
    the PostToolUse hook, keyed by the same session id (``<prefix>-<native_id>``).
    Used only as a heartbeat: the command text is never read or kept.

Privacy: map events, /api/external-agents[/sessions] and /health carry only
metadata (agent, repo/city, model, counts, last activity) — no prompts, no
commands, no cwd. Chat text (Suvadu's prompt/response events) is read only on
demand through the token-protected GET /api/external-agents/<session>/chat,
for sessions this tracker listed; it is never broadcast.

Fail-open: a missing binary, a timeout, a non-zero exit or bad JSON never
raises out of the poll loop; the error code is kept in ``status()`` for /health
and the units already on the map age out on their last known activity.
"""

from __future__ import annotations

import base64
import glob
import json
import os
import re
import subprocess
import threading
import time
from collections import Counter
from dataclasses import dataclass, replace
from typing import Any, Callable, Iterable, Protocol, Sequence

from server import session_liveness, session_reply, session_resume

SendFn = Callable[[dict[str, Any]], None]
LivenessFn = Callable[[], session_liveness.Liveness]
RepoPathsFn = Callable[[], list[str]]
RunFn = Callable[[list[str]], str]

CAPITAL_ID = "capital"  # src/map.ts CAPITAL_ID
_REPOCIV_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SESSIONS_LIMIT = 50  # `agent sessions` is ordered by updated_at DESC
_HISTORY_LIMIT = 300
_EVENT_PAGE = 100  # `suv agent session --limit` max
_MAX_EVENT_PAGES = 30
_IMPORT_MIN_INTERVAL_S = 5.0
_CHAT_ROLES = {"prompt": "user", "response": "assistant"}
_NATIVE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{7,79}$")
_WORK_RECENT = 12  # latest in-repo folder mentions that vote for where a session works
_WORK_MIN_HITS = 3  # votes one repo needs before it outranks the session cwd

# Suvadu agent id → unitType from the bridgeSchema.ts picklist.
_UNIT_TYPES = {"claude-code": "claude", "claude": "claude", "codex": "codex"}
_DEFAULT_UNIT_TYPE = "scout"


class SourceError(Exception):
    """A source could not be read. ``str(err)`` is a short code safe for /health."""


class SuvaduError(SourceError):
    """A `suv` call failed."""


# ─── Config ──────────────────────────────────────────────────────────────────
def _env_float(name: str, default: float, minimum: float) -> float:
    try:
        value = float(os.environ.get(name, "") or default)
    except ValueError:
        value = default
    return max(minimum, value)


@dataclass(frozen=True)
class TrackerConfig:
    bin_path: str
    poll_s: float = 30.0
    window_s: float = 600.0  # last activity older than this → despawn
    working_s: float = 120.0  # last activity fresher than this → working, else idle
    recent_s: float = 86400.0  # sessions listed in the Agents panel (chat access)
    timeout_s: float = 5.0
    enabled: bool = True

    @classmethod
    def from_env(cls) -> TrackerConfig:
        window_s = _env_float("REPOCIV_EXT_AGENTS_WINDOW_MIN", 10.0, 1.0) * 60
        working_s = _env_float("REPOCIV_EXT_AGENTS_WORKING_MIN", 2.0, 0.5) * 60
        recent_s = _env_float("REPOCIV_EXT_AGENTS_RECENT_H", 24.0, 0.5) * 3600
        return cls(
            bin_path=os.path.expanduser(os.environ.get("SUVADU_BIN", "") or "~/.cargo/bin/suv"),
            poll_s=_env_float("REPOCIV_EXT_AGENTS_POLL_S", 30.0, 5.0),
            window_s=window_s,
            working_s=min(working_s, window_s),
            recent_s=max(recent_s, window_s),
            enabled=os.environ.get("REPOCIV_EXT_AGENTS", "1").lower() not in ("0", "false", "no"),
        )


# ─── CLI ─────────────────────────────────────────────────────────────────────
def run_suv(bin_path: str, args: list[str], timeout_s: float) -> str:
    """Run ``suv <args>`` without a shell; return stdout or raise SuvaduError."""
    try:
        proc = subprocess.run(
            [bin_path, *args],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except FileNotFoundError as exc:
        raise SuvaduError("binary_not_found") from exc
    except PermissionError as exc:
        raise SuvaduError("binary_not_executable") from exc
    except subprocess.TimeoutExpired as exc:
        raise SuvaduError("timeout") from exc
    except OSError as exc:
        raise SuvaduError("os_error") from exc
    if proc.returncode != 0:
        raise SuvaduError(f"exit_{proc.returncode}")
    return proc.stdout


# ─── Parsing ─────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Observation:
    """One agent session as seen in a poll. Metadata only."""

    session_id: str
    agent: str
    native_id: str
    cwd: str
    model: str
    first_activity_ms: int
    last_activity_ms: int
    command_count: int
    event_count: int
    total_tokens: int | None
    parent_id: str | None = None
    imported: bool = True  # False: seen only through the history heartbeat
    # Set by sources other than Suvadu; the defaults describe a Suvadu session.
    source: str = "suvadu"
    unit_id: str = ""  # "" → unit_id_for(agent, native_id)
    unit_type: str = ""  # "" → unit_type_for(agent)
    label: str = ""  # "" → "<agent> · <model>"
    section: str = ""  # "" → map + Activos; "cron" / "gateway" → panel only
    ended: bool = False  # the source knows the session is over → off the map
    profile: str = ""
    origin: str = ""  # how the session was started (Hermes: cli, desktop, cron…)
    # Folders the session's own recent activity touched, newest first, one per
    # mention (Hermes tool calls). Where it works now, which the launch cwd
    # (often ~, or nothing on desktop) does not tell.
    work_dirs: tuple[str, ...] = ()
    # Set by the tracker, not by the sources: is a process still holding this
    # session? None when it could not be told (see server/session_liveness.py).
    live: bool | None = None


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def parse_sessions(raw: str) -> list[Observation]:
    """Parse ``suv agent sessions`` JSON. Malformed rows are skipped."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SuvaduError("bad_json") from exc
    rows = data.get("sessions") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise SuvaduError("bad_json")
    out: list[Observation] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        session_id = row.get("id")
        agent = row.get("agent")
        last = _as_int(row.get("last_activity_at"))
        if not isinstance(session_id, str) or not isinstance(agent, str) or last is None:
            continue
        native = row.get("native_id")
        usage = row.get("usage")
        out.append(
            Observation(
                session_id=session_id,
                agent=agent,
                native_id=native if isinstance(native, str) and native else _native_of(session_id),
                cwd=_str(row.get("cwd")),
                model=_str(row.get("model")),
                first_activity_ms=_as_int(row.get("first_activity_at")) or last,
                last_activity_ms=last,
                command_count=_as_int(row.get("command_count")) or 0,
                event_count=_as_int(row.get("event_count")) or 0,
                total_tokens=_as_int(usage.get("total_tokens")) if isinstance(usage, dict) else None,
                parent_id=_str(row.get("parent_id")) or None,
            )
        )
    return out


@dataclass
class _Beat:
    agent: str
    cwd: str
    first_ms: int
    last_ms: int
    count: int


def parse_history(raw: str) -> dict[str, _Beat]:
    """Group ``suv history --json`` agent lines by session id.

    Reads only session_id / executor / cwd / started_at — never ``command``.
    """
    beats: dict[str, _Beat] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict) or entry.get("executor_type") != "agent":
            continue
        session_id = entry.get("session_id")
        agent = entry.get("executor")
        ts = _as_int(entry.get("started_at"))
        if not isinstance(session_id, str) or not session_id or not isinstance(agent, str) or ts is None:
            continue
        cwd = _str(entry.get("cwd"))
        beat = beats.get(session_id)
        if beat is None:
            beats[session_id] = _Beat(agent=agent, cwd=cwd, first_ms=ts, last_ms=ts, count=1)
            continue
        beat.count += 1
        beat.first_ms = min(beat.first_ms, ts)
        if ts > beat.last_ms:
            beat.last_ms = ts
            beat.cwd = cwd or beat.cwd
    return beats


def _native_of(session_id: str) -> str:
    """Suvadu ids are ``<prefix>-<native_id>`` (claude-…, codex-…, cursor-…)."""
    return session_id.split("-", 1)[1] if "-" in session_id else session_id


def merge(sessions: list[Observation], beats: dict[str, _Beat]) -> list[Observation]:
    """Refresh sessions with their live heartbeat; add sessions not imported yet."""
    out: list[Observation] = []
    seen: set[str] = set()
    for obs in sessions:
        seen.add(obs.session_id)
        beat = beats.get(obs.session_id)
        if beat is not None and beat.last_ms > obs.last_activity_ms:
            obs = replace(
                obs,
                last_activity_ms=beat.last_ms,
                command_count=max(obs.command_count, beat.count),
            )
        out.append(obs)
    for session_id, beat in beats.items():
        if session_id in seen:
            continue
        out.append(
            Observation(
                session_id=session_id,
                agent=beat.agent,
                native_id=_native_of(session_id),
                cwd=beat.cwd,
                model="",
                first_activity_ms=beat.first_ms,
                last_activity_ms=beat.last_ms,
                command_count=beat.count,
                event_count=0,
                total_tokens=None,
                imported=False,
            )
        )
    return out


# ─── Mapping ─────────────────────────────────────────────────────────────────
def encode_repo_id(repo_path: str) -> str:
    """Mirror of vite-plugins/repoRootsState.ts encodeRepoId (base64url, no pad)."""
    encoded = base64.urlsafe_b64encode(repo_path.encode("utf-8")).decode("ascii")
    return "repo:" + encoded.rstrip("=")


def _canonical(path: str) -> str:
    try:
        return os.path.realpath(os.path.expanduser(path))
    except (OSError, ValueError):
        return os.path.abspath(os.path.expanduser(path))


def _enclosing_git_repo(path: str) -> str | None:
    """Nearest ancestor of ``path`` (inclusive) holding a .git dir or file."""
    current = path
    while True:
        if os.path.exists(os.path.join(current, ".git")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


_Candidate = tuple[str, str, bool]  # (canonical path, path as given, is RepoCiv's own checkout)


def city_candidates(repo_paths: Iterable[str], *, home_repo: str = _REPOCIV_ROOT) -> list[_Candidate]:
    """Canonicalise the repo list once per poll (realpath is a syscall per path)."""
    out: list[_Candidate] = []
    for raw in repo_paths:
        if raw:
            repo_abs = os.path.abspath(os.path.expanduser(raw))
            out.append((_canonical(repo_abs), repo_abs, False))
    if home_repo:
        home_abs = os.path.abspath(home_repo)
        out.append((_canonical(home_abs), home_abs, True))
    return out


def _selected_city(path_c: str, candidates: list[_Candidate]) -> tuple[str, str] | None:
    """Rules 1–2 of :func:`city_for` for a canonical path, or None."""
    best: tuple[int, str, bool] | None = None
    for repo_c, repo_abs, is_home in candidates:
        try:
            inside = os.path.commonpath([path_c, repo_c]) == repo_c
        except ValueError:
            continue
        if inside and (best is None or len(repo_c) > best[0]):
            best = (len(repo_c), repo_abs, is_home)
    if best is None:
        return None
    city_id = CAPITAL_ID if best[2] else encode_repo_id(best[1])
    return city_id, os.path.basename(best[1])


def city_for(cwd: str, candidates: list[_Candidate]) -> tuple[str, str]:
    """(cityId, repo name) for a session cwd.

    1. The selected repo (a city) that is the longest prefix of ``cwd``, compared
       per path component on canonical paths: ``/w/repociv-old`` never matches
       the ``/w/repociv`` city.
    2. RepoCiv's own checkout is never a city (the workspace scan skips it): the
       capital stands for it.
    3. Otherwise the enclosing git repo even if it is not selected here — the
       browser may hold another selection, and it falls back to the capital when
       that city is not on its map.
    4. No repo at all → capital.
    """
    if not cwd:
        return CAPITAL_ID, ""
    cwd_c = _canonical(cwd)
    selected = _selected_city(cwd_c, candidates)
    if selected is not None:
        return selected
    enclosing = _enclosing_git_repo(cwd_c)
    if enclosing is not None:
        return encode_repo_id(enclosing), os.path.basename(enclosing)
    return CAPITAL_ID, ""


def work_place(path: str, candidates: list[_Candidate]) -> tuple[str, str] | None:
    """(cityId, repo name) of a folder a session touched; None outside any repo.

    Rules 1–3 of :func:`city_for`, but a folder in no repo (``~``, ``/tmp``)
    counts for nothing instead of for the capital, and a dotted repo
    (``~/.hermes``) claims only its own root: a stray file under a cache must
    not drag a whole home into one city.
    """
    path_c = _canonical(path)
    selected = _selected_city(path_c, candidates)
    if selected is not None:
        return selected
    root = _enclosing_git_repo(path_c)
    if root is None or (root != path_c and os.path.basename(root).startswith(".")):
        return None
    return encode_repo_id(root), os.path.basename(root)


def busiest(places: Sequence[tuple[str, str]]) -> tuple[str, str] | None:
    """The place most of ``places`` (newest first) name, from ``_WORK_MIN_HITS``;
    a tie goes to the one named most recently."""
    counts = Counter(places)  # insertion order = newest first; max keeps the first
    if not counts:
        return None
    best = max(counts, key=counts.__getitem__)
    return best if counts[best] >= _WORK_MIN_HITS else None


def city_for_cwd(
    cwd: str,
    repo_paths: Iterable[str],
    *,
    home_repo: str = _REPOCIV_ROOT,
) -> tuple[str, str]:
    """One-off form of :func:`city_for`."""
    return city_for(cwd, city_candidates(repo_paths, home_repo=home_repo))


def selected_repo_paths() -> list[str]:
    """Repos on the map: every root's selectedRepoPaths in the shared state file."""
    from server.repo_roots_state import load_state  # noqa: PLC0415

    roots = load_state().get("roots")
    if not isinstance(roots, dict):
        return []
    paths: list[str] = []
    for entry in roots.values():
        selected = entry.get("selectedRepoPaths") if isinstance(entry, dict) else None
        if isinstance(selected, list):
            paths.extend(p for p in selected if isinstance(p, str))
    return paths


def unit_id_for(agent: str, native_id: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", agent.lower()).strip("-") or "agent"
    return f"ext-{slug}-{native_id[:8]}"


def unit_type_for(agent: str) -> str:
    return _UNIT_TYPES.get(agent.lower(), _DEFAULT_UNIT_TYPE)


def _mission_for(obs: Observation) -> str:
    if obs.label:
        return obs.label
    return f"{obs.agent} · {obs.model}" if obs.model else obs.agent


def _unit_id(obs: Observation) -> str:
    return obs.unit_id or unit_id_for(obs.agent, obs.native_id)


def _unit_type(obs: Observation) -> str:
    return obs.unit_type or unit_type_for(obs.agent)


def transcript_path(agent: str, native_id: str, *, home: str | None = None) -> str | None:
    """Native transcript Suvadu can (re)import for this session, if any.

    Claude Code: ~/.claude/projects/<project>/<native_id>.jsonl
    Codex:       ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<native_id>.jsonl
    ``native_id`` is validated before it reaches a glob pattern.
    """
    if not _NATIVE_RE.match(native_id):
        return None
    base = home or os.path.expanduser("~")
    agent = agent.lower()
    if agent in ("claude-code", "claude"):
        pattern = os.path.join(base, ".claude", "projects", "*", f"{native_id}.jsonl")
    elif agent in ("codex", "openai-codex"):
        pattern = os.path.join(base, ".codex", "sessions", "*", "*", "*", f"*{native_id}*.jsonl")
    else:
        return None
    hits = [h for h in glob.glob(pattern) if os.path.isfile(h)]
    if not hits:
        return None
    try:
        return max(hits, key=os.path.getmtime)
    except OSError:
        return hits[0]


def _chat_message(event: Any) -> dict[str, Any] | None:
    """Suvadu prompt/response event → chat message; everything else → None."""
    if not isinstance(event, dict):
        return None
    role = _CHAT_ROLES.get(_str(event.get("kind")))
    data = event.get("data")
    if role is None or not isinstance(data, dict) or not isinstance(data.get("text"), str):
        return None
    return {
        "role": role,
        "text": data["text"],
        "at": _as_int(event.get("at")),
        "truncated": bool(data.get("truncated")),
        "turn": _str(event.get("turn_id")) or None,
    }


# ─── Sources ─────────────────────────────────────────────────────────────────
class AgentSource(Protocol):
    """Where external sessions come from. ``poll`` runs on the tracker thread;
    ``refresh`` / ``chat`` run on HTTP threads, only for sessions the tracker
    listed."""

    name: str

    def poll(self) -> list[Observation]:
        """Sessions seen now (metadata only). Raises SourceError when unreadable."""
        ...

    def status(self) -> dict[str, Any]:
        """Source-specific health fields for /health — no session data."""
        ...

    def refresh(self, obs: Observation) -> str:
        """Make the source's copy of the chat fresher, if it needs that."""
        ...

    def chat(self, obs: Observation, *, limit: int) -> dict[str, Any]:
        """``{"messages", "hasMore", "available"[, "error"]}``, oldest first.
        May raise SourceError."""
        ...


class SuvaduSource:
    """``suv agent sessions`` plus the live ``suv history`` heartbeat."""

    name = "suvadu"

    def __init__(
        self,
        run: RunFn,
        clock: Callable[[], float] = time.time,
        *,
        owned_ids: Callable[[], frozenset[str]] = frozenset,
    ) -> None:
        """``owned_ids``: native ids of the Claude sessions RepoCiv launched
        itself (server/claude_sessions.py) — their mission unit already shows them."""
        self._run = run
        self._clock = clock
        self._owned_ids = owned_ids
        self._heartbeat: bool | None = None
        self._imported_at: dict[str, float] = {}

    def poll(self) -> list[Observation]:
        self._heartbeat = None
        sessions = parse_sessions(self._run(["agent", "sessions", "--limit", str(_SESSIONS_LIMIT)]))
        try:
            beats = parse_history(
                self._run(["history", "--executor", "agent", "--json", "-n", str(_HISTORY_LIMIT)])
            )
        except Exception:
            beats, self._heartbeat = {}, False
        else:
            self._heartbeat = True
        observations = merge(sessions, beats)
        try:
            owned = self._owned_ids()
        except Exception:
            owned = frozenset()
        if not owned:
            return observations
        def mine(session: str | None) -> bool:
            return bool(session) and (session in owned or _native_of(session or "") in owned)

        # Skip RepoCiv's own missions and the subagents they spawned.
        return [obs for obs in observations if obs.native_id not in owned and not mine(obs.parent_id)]

    def status(self) -> dict[str, Any]:
        return {"heartbeat": self._heartbeat}

    def refresh(self, obs: Observation) -> str:
        """Ask Suvadu to re-import the native transcript (it only does so itself on
        prompt/stop, so a long turn would otherwise read stale)."""
        now = self._clock()
        if now - self._imported_at.get(obs.session_id, 0.0) < _IMPORT_MIN_INTERVAL_S:
            return "throttled"
        path = transcript_path(obs.agent, obs.native_id)
        if path is None:
            return "no_transcript"
        self._imported_at[obs.session_id] = now
        try:
            self._run(["agent", "import-session", path])
        except Exception:
            return "failed"
        return "ok"

    def chat(self, obs: Observation, *, limit: int) -> dict[str, Any]:
        """Last ``limit`` prompts/responses, paging back from the end."""
        session_id = obs.session_id
        try:
            head = json.loads(self._run(["agent", "session", session_id, "--limit", "1"]))
            total = _as_int((head.get("session") or {}).get("event_count")) or 0
        except (ValueError, AttributeError) as exc:
            raise SuvaduError("bad_json") from exc  # SuvaduError itself (e.g. not imported) propagates
        out: dict[str, Any] = {}
        messages: list[dict[str, Any]] = []
        offset = max(0, total - _EVENT_PAGE)
        try:
            for _ in range(_MAX_EVENT_PAGES):
                page = json.loads(self._run([
                    "agent", "session", session_id,
                    "--limit", str(_EVENT_PAGE), "--offset", str(offset),
                ]))
                batch = [m for m in map(_chat_message, page.get("events") or []) if m]
                messages = batch + messages
                if len(messages) >= limit or offset == 0:
                    break
                offset = max(0, offset - _EVENT_PAGE)
        except (SuvaduError, ValueError, AttributeError) as exc:
            out["error"] = str(exc) if isinstance(exc, SuvaduError) else "bad_json"
        out.update(
            available=True,
            hasMore=offset > 0 or len(messages) > limit,
            messages=messages[-limit:],
        )
        return out


# ─── Tracker ─────────────────────────────────────────────────────────────────
# ─── State ───────────────────────────────────────────────────────────────────
# The map unit vocabulary (src/types.ts UnitState) has no "thinking": on the map
# a thinking agent is simply a busy one. The distinction is for the panel, where
# it answers "can I write to it?".
_MAP_STATE = {"thinking": "working"}


def map_state(state: str) -> str:
    """The unit state the map understands, for a panel state."""
    return _MAP_STATE.get(state, state)


def derive_state(age_ms: float, working_ms: float, live: bool | None) -> str:
    """Panel state of a session that is still within the window.

    ``thinking`` is the honest answer when the activity clock went quiet but a
    process is still holding the session: it may be reasoning between tool
    calls, or waiting for its user — this tracker cannot tell the two apart,
    and both mean "do not fire a message at it blind". Without a liveness
    reading (``live is None``) the old timestamp-only answer stands.
    """
    if age_ms <= working_ms:
        return "working"
    return "thinking" if live else "idle"


class ExternalAgentTracker:
    """Owns the ext-* units. poll_once() is the only writer; snapshot() reads."""

    def __init__(
        self,
        config: TrackerConfig,
        *,
        send: SendFn,
        repo_paths: RepoPathsFn = selected_repo_paths,
        run: RunFn | None = None,
        clock: Callable[[], float] = time.time,
        sources: Sequence[AgentSource] | None = None,
        liveness: LivenessFn = session_liveness.probe,
        live_chat_router: Any | None = None,
    ) -> None:
        """``sources`` defaults to Suvadu alone, driven by ``run`` (or the real CLI)."""
        self.config = config
        self._send = send
        self._repo_paths = repo_paths
        self._clock = clock
        self._liveness = liveness
        self._live_chat_router = live_chat_router
        if sources is None:
            suv_run: RunFn = run or (lambda args: run_suv(config.bin_path, args, config.timeout_s))
            sources = [SuvaduSource(suv_run, clock)]
        self._sources: dict[str, AgentSource] = {src.name: src for src in sources}
        self._lock = threading.Lock()
        self._units: dict[str, dict[str, Any]] = {}  # session_id → unit record
        self._rows: list[dict[str, Any]] = []  # recent sessions, Agents panel
        self._listed: dict[str, Observation] = {}  # session_id → its row's observation
        self._last_obs: dict[str, list[Observation]] = {}  # per source
        self._status: dict[str, dict[str, Any]] = {
            name: {"ok": None, "error": None, "lastPollAt": None} for name in self._sources
        }

    # -- polling -------------------------------------------------------------
    def poll_once(self) -> None:
        """One poll cycle over every source. Never raises; a failing source keeps
        its last observations so its units age out instead of vanishing."""
        observations: list[Observation] = []
        for name, source in self._sources.items():
            try:
                seen = source.poll()
            except SourceError as exc:
                self._set_status(name, ok=False, error=str(exc))
                seen = self._last_obs.get(name, [])
            except Exception:
                self._set_status(name, ok=False, error="unexpected")
                seen = self._last_obs.get(name, [])
            else:
                self._last_obs[name] = seen
                self._set_status(name, ok=True, error=None)
            observations.extend(seen)
        observations = self._with_liveness(observations)
        try:
            repo_paths = self._repo_paths()
        except Exception:
            repo_paths = []
        for event in self.reconcile(observations, int(self._clock() * 1000), repo_paths):
            try:
                self._send(event)
            except Exception:
                pass

    def _with_liveness(self, observations: list[Observation]) -> list[Observation]:
        """Tag every observation with "is a process still holding this session?".

        One /proc scan per poll, shared by every observation. A probe that fails
        leaves ``live`` as None and the states fall back to timestamps alone. An
        observation whose source already declared ``live`` (it owns the process,
        e.g. claude-live) keeps that verdict: the probe is approximate, the
        source is not."""
        try:
            reading = self._liveness()
        except Exception:
            return observations
        tagged: list[Observation] = []
        for obs in observations:
            if obs.live is not None:
                tagged.append(obs)
                continue
            tagged.append(
                replace(
                    obs,
                    live=reading.live_for(source=obs.source, native_id=obs.native_id, cwd=obs.cwd),
                )
            )
        return tagged

    def reconcile(
        self,
        observations: list[Observation],
        now_ms: int,
        repo_paths: list[str],
    ) -> list[dict[str, Any]]:
        """Diff the desired unit set against what is on the map; return events."""
        window_ms = self.config.window_s * 1000
        working_ms = self.config.working_s * 1000
        desired: dict[str, Observation] = {}
        for obs in observations:
            if obs.section or obs.ended or now_ms - obs.last_activity_ms > window_ms:
                continue  # panel-only, finished, or quiet for too long
            prev = desired.get(obs.session_id)
            if prev is None or obs.last_activity_ms > prev.last_activity_ms:
                desired[obs.session_id] = obs

        candidates = city_candidates(repo_paths)
        cities: dict[str, tuple[str, str]] = {}
        places: dict[str, tuple[str, str] | None] = {}

        def city_of(obs: Observation) -> tuple[str, str]:
            """Where the session works now; its cwd when its activity does not say."""
            recent: list[tuple[str, str]] = []
            for path in obs.work_dirs:
                if path not in places:
                    places[path] = work_place(path, candidates)
                place = places[path]
                if place is not None:
                    recent.append(place)
                    if len(recent) == _WORK_RECENT:
                        break
            working_in = busiest(recent)
            if working_in is not None:
                return working_in
            if obs.cwd not in cities:
                cities[obs.cwd] = city_for(obs.cwd, candidates)
            return cities[obs.cwd]

        events: list[dict[str, Any]] = []
        with self._lock:
            for session_id in list(self._units):
                if session_id not in desired:
                    events.append({"type": "unit_despawn", "unit": self._units.pop(session_id)["unit"]})

            for session_id, obs in desired.items():
                city_id, repo = city_of(obs)
                age_ms = max(0, now_ms - obs.last_activity_ms)
                state = derive_state(age_ms, working_ms, obs.live)
                mapped = map_state(state)
                rec = self._units.get(session_id)
                if rec is not None and rec["cityId"] != city_id:
                    events.append({"type": "unit_despawn", "unit": rec["unit"]})
                    rec = None
                if rec is None:
                    rec = {
                        "unit": _unit_id(obs),
                        "unitType": _unit_type(obs),
                        "cityId": city_id,
                        "state": "idle",  # GameState.spawnUnit starts every unit idle
                        "sessionState": "idle",
                    }
                    self._units[session_id] = rec
                    events.append(self._spawn_event(rec, obs))
                if rec["state"] != mapped:
                    rec["state"] = mapped
                    events.append({"type": "unit_state", "unit": rec["unit"], "state": mapped})
                rec["sessionState"] = state
                rec.update(
                    agent=obs.agent,
                    model=obs.model,
                    repo=repo,
                    mission=_mission_for(obs),
                    firstActivityAt=obs.first_activity_ms,
                    lastActivityAt=obs.last_activity_ms,
                    commandCount=obs.command_count,
                    eventCount=obs.event_count,
                    totalTokens=obs.total_tokens,
                )
            self._rows, self._listed = self._recent_rows(observations, now_ms, city_of)
        return events

    def _chat_capability(self, obs: Observation) -> dict[str, Any]:
        if self._live_chat_router is None:
            from server.live_session_chat import default_router

            self._live_chat_router = default_router()
        return self._live_chat_router.capability(obs).to_dict()

    def _recent_rows(
        self,
        observations: list[Observation],
        now_ms: int,
        city_of: Callable[[Observation], tuple[str, str]],
    ) -> tuple[list[dict[str, Any]], dict[str, Observation]]:
        """Every session active within recent_s, newest first (caller holds the lock).

        A panel-only session (``section``) never has a unit; it still reads as
        working / thinking / idle while it is live, like the map ones.

        Known limit: the reading only covers sessions inside the window. Past
        it a session reads ``inactive`` even when its process is alive, because
        that is also when its unit leaves the map."""
        recent_ms = self.config.recent_s * 1000
        window_ms = self.config.window_s * 1000
        working_ms = self.config.working_s * 1000
        rows: list[dict[str, Any]] = []
        listed: dict[str, Observation] = {}
        for obs in sorted(observations, key=lambda o: o.last_activity_ms, reverse=True):
            age_ms = max(0, now_ms - obs.last_activity_ms)
            if obs.session_id in listed or age_ms > recent_ms:
                continue
            listed[obs.session_id] = obs
            city_id, repo = city_of(obs)
            rec = self._units.get(obs.session_id)
            if rec is not None:
                active, state = True, rec.get("sessionState") or rec["state"]
            elif obs.section and not obs.ended and age_ms <= window_ms:
                active, state = True, derive_state(age_ms, working_ms, obs.live)
            else:
                active, state = False, "inactive"
            rows.append({
                "sessionId": obs.session_id,
                "source": obs.source,
                "agent": obs.agent,
                "profile": obs.profile,
                "origin": obs.origin,
                "section": obs.section,
                "model": obs.model,
                "repo": repo,
                "cityId": city_id,
                "active": active,
                "state": state,
                "unit": rec["unit"] if rec is not None else None,
                "unitType": _unit_type(obs),
                "firstActivityAt": obs.first_activity_ms,
                "lastActivityAt": obs.last_activity_ms,
                "commandCount": obs.command_count,
                "eventCount": obs.event_count,
                "totalTokens": obs.total_tokens,
                "subagent": obs.parent_id is not None,
                "imported": obs.imported,
                "liveChat": self._chat_capability(obs),
            })
        return rows, listed

    @staticmethod
    def _spawn_event(rec: dict[str, Any], obs: Observation) -> dict[str, Any]:
        return {
            "type": "unit_spawn",
            "unit": rec["unit"],
            "civ": "capital",
            "hex": [0, 0],  # no parent → the client places it next to cityId
            "unitType": rec["unitType"],
            "mission": _mission_for(obs)[:120],
            "cityId": rec["cityId"],
            "ephemeral": True,
        }

    # -- read side -----------------------------------------------------------
    def _set_status(self, name: str, *, ok: bool, error: str | None) -> None:
        with self._lock:
            self._status[name].update(ok=ok, error=error, lastPollAt=self._clock())

    def source(self, name: str) -> AgentSource | None:
        return self._sources.get(name)

    def source_ok(self, name: str) -> bool:
        with self._lock:
            return bool(self._status.get(name, {}).get("ok"))

    def status(self) -> dict[str, Any]:
        """Overall health plus one entry per source. ``ok`` is true only when every
        source's last poll worked; ``error`` is the first failing source's code."""
        extras = {name: src.status() for name, src in self._sources.items()}
        with self._lock:
            per = {name: {**st, **extras[name]} for name, st in self._status.items()}
            units = len(self._units)
        oks = [st["ok"] for st in per.values()]
        errors = [st["error"] for st in per.values() if st["error"]]
        polls = [st["lastPollAt"] for st in per.values() if st["lastPollAt"] is not None]
        return {
            "enabled": True,
            "ok": None if not oks or None in oks else all(oks),
            "error": errors[0] if errors else None,
            "heartbeat": per.get("suvadu", {}).get("heartbeat"),
            "lastPollAt": max(polls) if polls else None,
            "units": units,
            "sources": per,
        }

    def agents(self) -> list[dict[str, Any]]:
        """Map-facing rows. ``sessionState`` stays out: the map speaks the unit
        vocabulary (see ``map_state``), the finer state is the panel's."""
        with self._lock:
            rows = [
                {key: value for key, value in rec.items() if key != "sessionState"}
                for rec in self._units.values()
            ]
        return sorted(rows, key=lambda r: r.get("lastActivityAt") or 0, reverse=True)

    def sessions(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(row) for row in self._rows]

    def observation(self, session_id: str) -> Observation | None:
        """Return a detached immutable snapshot for server-side routing."""
        with self._lock:
            obs = self._listed.get(session_id)
        return replace(obs) if obs is not None else None

    def send_live_chat(self, session_id: str, text: Any, request_id: str) -> tuple[int, dict[str, Any]]:
        obs = self.observation(session_id)
        if obs is None:
            return 404, {"error": "unknown_session", "sessionId": session_id}
        if self._live_chat_router is None:
            from server.live_session_chat import default_router

            self._live_chat_router = default_router()
        from server.live_session_chat import ChatError

        try:
            result = self._live_chat_router.send(obs, text, request_id)
        except ChatError as exc:
            return exc.status, {"error": exc.code, "sessionId": session_id}
        return 202, result.to_dict()

    # -- resume (on demand: the command, never the run) ----------------------
    def resume(self, session_id: str) -> tuple[int, dict[str, Any]]:
        """How to pick this session back up in a terminal (server/session_resume.py)."""
        with self._lock:
            obs = self._listed.get(session_id)
        if obs is None:
            return 404, {"error": "unknown_session"}
        hermes = self._sources.get("hermes")
        body = session_resume.plan(
            agent=obs.agent,
            native_id=obs.native_id,
            cwd=obs.cwd,
            profile=obs.profile,
            live=obs.live,
            hermes_home=getattr(hermes, "home", "~/.hermes"),
            ended=obs.ended,
        )
        body["sessionId"] = session_id
        return 200, body

    # -- reply (one turn over a session RepoCiv does not own) ----------------
    def reply(self, session_id: str, text: str) -> tuple[int, dict[str, Any]]:
        """Run one turn with the user's message (server/session_reply.py).

        The session's own model is left alone: resuming a thread and silently
        switching its model would be a surprise, not a feature."""
        with self._lock:
            obs = self._listed.get(session_id)
        if obs is None:
            return 404, {"error": "unknown_session"}
        hermes = self._sources.get("hermes")
        try:
            spec = session_reply.build(
                agent=obs.agent,
                native_id=obs.native_id,
                cwd=obs.cwd,
                text=text,
                profile=obs.profile,
                live=obs.live,
                hermes_home=getattr(hermes, "home", "~/.hermes"),
                ended=obs.ended,
            )
            run = session_reply.start(session_id, spec)
        except session_reply.ReplyRefused as exc:
            code = str(exc)
            status = 409 if code in ("session_is_live", "already_running") else 400
            return status, {"error": code, "sessionId": session_id}
        return 202, {"sessionId": session_id, **run}

    def reply_status(self, session_id: str) -> dict[str, Any] | None:
        return session_reply.status(session_id)

    # -- chat (on demand, never broadcast) -----------------------------------
    def _listed_source(self, session_id: str) -> tuple[Observation, AgentSource] | None:
        with self._lock:
            obs = self._listed.get(session_id)
        source = self._sources.get(obs.source) if obs is not None else None
        return (obs, source) if obs is not None and source is not None else None

    def refresh_transcript(self, session_id: str) -> str:
        """Ask the session's source for a fresher chat (Suvadu re-imports)."""
        found = self._listed_source(session_id)
        if found is None:
            return "unknown_session"
        obs, source = found
        try:
            return source.refresh(obs)
        except Exception:
            return "failed"

    def chat(self, session_id: str, *, limit: int = 80, refresh: bool = False) -> tuple[int, dict[str, Any]]:
        """Last ``limit`` chat messages of a listed session, oldest first."""
        with self._lock:
            row = next((dict(r) for r in self._rows if r["sessionId"] == session_id), None)
        found = self._listed_source(session_id)
        if row is None or found is None:
            return 404, {"error": "unknown_session", "sessionId": session_id}
        obs, source = found
        limit = max(1, min(limit, 400))
        body: dict[str, Any] = {"session": row, "messages": [], "hasMore": False, "available": False}
        if refresh:
            body["refresh"] = self.refresh_transcript(session_id)
        try:
            body.update(source.chat(obs, limit=limit))
        except SourceError as exc:
            body["error"] = str(exc)  # e.g. not imported yet, db locked
        except Exception:
            body["error"] = "unexpected"
        # The composer polls this endpoint anyway: it is where it learns whether
        # the turn RepoCiv started is still running, and how it ended.
        last_reply = session_reply.status(session_id)
        if last_reply is not None:
            body["lastReply"] = last_reply
        return 200, body


# ─── Module singleton (wired from bridge.py) ─────────────────────────────────
_tracker: ExternalAgentTracker | None = None
_thread: threading.Thread | None = None


def start(send: SendFn, config: TrackerConfig | None = None) -> bool:
    """Start the poll thread once. Returns False when disabled via env."""
    global _tracker, _thread
    cfg = config or TrackerConfig.from_env()
    if not cfg.enabled or _thread is not None:
        return False
    from server import claude_live, claude_sessions, hermes_sessions  # noqa: PLC0415

    sources: list[AgentSource] = [
        SuvaduSource(
            lambda args: run_suv(cfg.bin_path, args, cfg.timeout_s),
            owned_ids=claude_sessions.owned_ids,
        ),
    ]
    hermes = hermes_sessions.source_from_env(recent_s=cfg.recent_s, window_s=cfg.window_s)
    if hermes is not None:
        sources.append(hermes)
    # The process-owned claude channel: its sessions declare their own liveness.
    sources.append(claude_live.ClaudeLiveSource(claude_live.get_manager()))
    tracker = ExternalAgentTracker(cfg, send=send, sources=sources)

    def _loop() -> None:
        time.sleep(3)
        while True:
            tracker.poll_once()
            time.sleep(cfg.poll_s)

    _tracker = tracker
    _thread = threading.Thread(target=_loop, name="external-agents-tracker", daemon=True)
    _thread.start()
    return True


def covers_hermes_profile(profile: str) -> bool:
    """True when the Hermes source is up and reads ``profile``: that profile's
    sessions are already on the map, so a ps-based detector would duplicate them."""
    tracker = _tracker
    if tracker is None or not tracker.source_ok("hermes"):
        return False
    source = tracker.source("hermes")
    reads = getattr(source, "reads_profile", None)
    return bool(reads(profile)) if callable(reads) else False


def status() -> dict[str, Any]:
    """Tracker health for /health — no session data."""
    if _tracker is None:
        return {"enabled": False, "ok": None, "error": None, "units": 0}
    return _tracker.status()


def sessions() -> dict[str, Any]:
    """Payload of GET /api/external-agents/sessions (metadata only)."""
    if _tracker is None:
        return {"status": status(), "sessions": []}
    return {
        "status": _tracker.status(),
        "windowMinutes": _tracker.config.window_s / 60,
        "recentHours": _tracker.config.recent_s / 3600,
        "sessions": _tracker.sessions(),
    }


def chat(session_id: str, *, limit: int = 80, refresh: bool = False) -> tuple[int, dict[str, Any]]:
    """Payload of GET /api/external-agents/<session>/chat — prompts and responses."""
    if _tracker is None:
        return 503, {"error": "tracker_not_running"}
    return _tracker.chat(session_id, limit=limit, refresh=refresh)


def send_live_chat(session_id: str, text: Any, request_id: str) -> tuple[int, dict[str, Any]]:
    """Payload of POST /api/external-agents/<session>/chat."""
    if _tracker is None:
        return 503, {"error": "tracker_not_running"}
    return _tracker.send_live_chat(session_id, text, request_id)


def resume(session_id: str) -> tuple[int, dict[str, Any]]:
    """Payload of GET /api/external-agents/<session>/resume — the command only."""
    if _tracker is None:
        return 503, {"error": "tracker_not_running"}
    return _tracker.resume(session_id)


def reply(session_id: str, text: str) -> tuple[int, dict[str, Any]]:
    """Payload of POST /api/external-agents/<session>/reply."""
    if _tracker is None:
        return 503, {"error": "tracker_not_running"}
    return _tracker.reply(session_id, text)


def snapshot() -> dict[str, Any]:
    """Payload of GET /api/external-agents."""
    if _tracker is None:
        return {"status": status(), "agents": []}
    return {
        "status": _tracker.status(),
        "windowMinutes": _tracker.config.window_s / 60,
        "agents": _tracker.agents(),
    }
