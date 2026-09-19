"""Suvadu → RepoCiv: external AI-agent sessions as ephemeral map units.

Suvadu (`suv`, github.com/AppachiTech/suvadu) records the Claude Code / Codex /
Cursor / OpenCode sessions that run on this machine, whoever launched them.
This module polls its CLI every ~30 s and mirrors the recently active sessions
onto the map:

  * spawn   — a session with activity in the last WINDOW minutes becomes an
              ephemeral unit ``ext-<agent>-<native_id[:8]>`` in the city whose
              repo path is the longest prefix of the session cwd (else capital);
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

Privacy: only metadata leaves this module (agent, repo/city, model, counts,
last activity). No prompts, no commands, no cwd.

Fail-open: a missing binary, a timeout, a non-zero exit or bad JSON never
raises out of the poll loop; the error code is kept in ``status()`` for /health
and the units already on the map age out on their last known activity.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass, replace
from typing import Any, Callable, Iterable

SendFn = Callable[[dict[str, Any]], None]
RepoPathsFn = Callable[[], list[str]]
RunFn = Callable[[list[str]], str]

CAPITAL_ID = "capital"  # src/map.ts CAPITAL_ID
_REPOCIV_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SESSIONS_LIMIT = 50  # `agent sessions` is ordered by updated_at DESC
_HISTORY_LIMIT = 300

# Suvadu agent id → unitType from the bridgeSchema.ts picklist.
_UNIT_TYPES = {"claude-code": "claude", "claude": "claude", "codex": "codex"}
_DEFAULT_UNIT_TYPE = "scout"


class SuvaduError(Exception):
    """A `suv` call failed. ``str(err)`` is a short code safe for /health."""


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
    timeout_s: float = 5.0
    enabled: bool = True

    @classmethod
    def from_env(cls) -> TrackerConfig:
        window_s = _env_float("REPOCIV_EXT_AGENTS_WINDOW_MIN", 10.0, 1.0) * 60
        working_s = _env_float("REPOCIV_EXT_AGENTS_WORKING_MIN", 2.0, 0.5) * 60
        return cls(
            bin_path=os.path.expanduser(os.environ.get("SUVADU_BIN", "") or "~/.cargo/bin/suv"),
            poll_s=_env_float("REPOCIV_EXT_AGENTS_POLL_S", 30.0, 5.0),
            window_s=window_s,
            working_s=min(working_s, window_s),
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


def city_for_cwd(
    cwd: str,
    repo_paths: Iterable[str],
    *,
    home_repo: str = _REPOCIV_ROOT,
) -> tuple[str, str]:
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
    candidates = [(p, False) for p in repo_paths if p]
    if home_repo:
        candidates.append((home_repo, True))
    best: tuple[int, str, bool] | None = None
    for raw, is_home in candidates:
        repo_abs = os.path.abspath(os.path.expanduser(raw))
        repo_c = _canonical(repo_abs)
        try:
            inside = os.path.commonpath([cwd_c, repo_c]) == repo_c
        except ValueError:
            continue
        if inside and (best is None or len(repo_c) > best[0]):
            best = (len(repo_c), repo_abs, is_home)
    if best is not None:
        city_id = CAPITAL_ID if best[2] else encode_repo_id(best[1])
        return city_id, os.path.basename(best[1])
    enclosing = _enclosing_git_repo(cwd_c)
    if enclosing is not None:
        return encode_repo_id(enclosing), os.path.basename(enclosing)
    return CAPITAL_ID, ""


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
    return f"{obs.agent} · {obs.model}" if obs.model else obs.agent


# ─── Tracker ─────────────────────────────────────────────────────────────────
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
    ) -> None:
        self.config = config
        self._send = send
        self._repo_paths = repo_paths
        self._run: RunFn = run or (lambda args: run_suv(config.bin_path, args, config.timeout_s))
        self._clock = clock
        self._lock = threading.Lock()
        self._units: dict[str, dict[str, Any]] = {}  # session_id → unit record
        self._last_obs: list[Observation] = []
        self._status: dict[str, Any] = {
            "ok": None,
            "error": None,
            "heartbeat": None,
            "lastPollAt": None,
        }

    # -- polling -------------------------------------------------------------
    def poll_once(self) -> None:
        """One poll cycle. Never raises."""
        try:
            sessions = parse_sessions(self._run(["agent", "sessions", "--limit", str(_SESSIONS_LIMIT)]))
        except SuvaduError as exc:
            self._set_status(ok=False, error=str(exc), heartbeat=None)
            observations = self._last_obs  # age out what we already show
        except Exception:
            self._set_status(ok=False, error="unexpected", heartbeat=None)
            observations = self._last_obs
        else:
            heartbeat_ok = True
            try:
                beats = parse_history(
                    self._run(["history", "--executor", "agent", "--json", "-n", str(_HISTORY_LIMIT)])
                )
            except Exception:
                beats, heartbeat_ok = {}, False
            observations = merge(sessions, beats)
            self._last_obs = observations
            self._set_status(ok=True, error=None, heartbeat=heartbeat_ok)
        try:
            repo_paths = self._repo_paths()
        except Exception:
            repo_paths = []
        for event in self.reconcile(observations, int(self._clock() * 1000), repo_paths):
            try:
                self._send(event)
            except Exception:
                pass

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
            if now_ms - obs.last_activity_ms <= window_ms:
                prev = desired.get(obs.session_id)
                if prev is None or obs.last_activity_ms > prev.last_activity_ms:
                    desired[obs.session_id] = obs

        events: list[dict[str, Any]] = []
        with self._lock:
            for session_id in list(self._units):
                if session_id not in desired:
                    events.append({"type": "unit_despawn", "unit": self._units.pop(session_id)["unit"]})

            for session_id, obs in desired.items():
                city_id, repo = city_for_cwd(obs.cwd, repo_paths)
                age_ms = max(0, now_ms - obs.last_activity_ms)
                state = "working" if age_ms <= working_ms else "idle"
                rec = self._units.get(session_id)
                if rec is not None and rec["cityId"] != city_id:
                    events.append({"type": "unit_despawn", "unit": rec["unit"]})
                    rec = None
                if rec is None:
                    rec = {
                        "unit": unit_id_for(obs.agent, obs.native_id),
                        "unitType": unit_type_for(obs.agent),
                        "cityId": city_id,
                        "state": "idle",  # GameState.spawnUnit starts every unit idle
                    }
                    self._units[session_id] = rec
                    events.append(self._spawn_event(rec, obs))
                if rec["state"] != state:
                    rec["state"] = state
                    events.append({"type": "unit_state", "unit": rec["unit"], "state": state})
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
        return events

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
    def _set_status(self, *, ok: bool, error: str | None, heartbeat: bool | None) -> None:
        with self._lock:
            self._status.update(ok=ok, error=error, heartbeat=heartbeat, lastPollAt=self._clock())

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {"enabled": True, **self._status, "units": len(self._units)}

    def agents(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = [dict(rec) for rec in self._units.values()]
        return sorted(rows, key=lambda r: r.get("lastActivityAt") or 0, reverse=True)


# ─── Module singleton (wired from bridge.py) ─────────────────────────────────
_tracker: ExternalAgentTracker | None = None
_thread: threading.Thread | None = None


def start(send: SendFn, config: TrackerConfig | None = None) -> bool:
    """Start the poll thread once. Returns False when disabled via env."""
    global _tracker, _thread
    cfg = config or TrackerConfig.from_env()
    if not cfg.enabled or _thread is not None:
        return False
    tracker = ExternalAgentTracker(cfg, send=send)

    def _loop() -> None:
        time.sleep(3)
        while True:
            tracker.poll_once()
            time.sleep(cfg.poll_s)

    _tracker = tracker
    _thread = threading.Thread(target=_loop, name="suvadu-tracker", daemon=True)
    _thread.start()
    return True


def status() -> dict[str, Any]:
    """Tracker health for /health — no session data."""
    if _tracker is None:
        return {"enabled": False, "ok": None, "error": None, "units": 0}
    return _tracker.status()


def snapshot() -> dict[str, Any]:
    """Payload of GET /api/external-agents."""
    if _tracker is None:
        return {"status": status(), "agents": []}
    return {
        "status": _tracker.status(),
        "windowMinutes": _tracker.config.window_s / 60,
        "agents": _tracker.agents(),
    }
