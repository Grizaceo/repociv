"""RepoCiv — Wonder Launcher (auto-start for iframe Wonders).

Spawns the underlying servers for iframe-based Wonders (Bibliotheca,
Institutum/LabHub) and tracks their PIDs so:
  - the client can poll launch-status (F3)
  - subsequent launches are idempotent (no duplicate PIDs)
  - stop_wonder() can kill the process group cleanly

Security model
--------------
- ``WONDER_LAUNCH_SPECS`` is the allowlist; client cannot pass argv.
- ``cwd`` is resolved from env (REPOCIV_WONDER_BIBLIOTHECA_DIR /
  _INSTITUTUM_DIR) — never from a request body.
- Spawn is REJECTED in remote mode (REPOCIV_REMOTE=true): the launcher
  is loopback-only. On a remote session the user must start the
  wonder's server manually on the host.
- ``subprocess.Popen(..., start_new_session=True)`` so the spawned
  process group survives the request handler returning (truly
  detached).
- Token + rate-limit are applied at the HTTP layer (do_POST in
  bridge.py) so this module does not re-implement them.

State
-----
PIDs + log paths are persisted to
``$REPOCIV_CONFIG_DIR/wonders/launched.json`` so a bridge restart does
not orphan the user-started processes (or vice versa). Logs land in
``$REPOCIV_CONFIG_DIR/wonders/logs/<wonder>-<proc>.log``.

See ``docs/plans/2026-06-16-wonder-autostart-and-3d.md`` §1.1 for the
full spec.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# ─── Env helpers ─────────────────────────────────────────────────────────────


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if v is not None and v.strip() != "" else default


def _expand(path: str) -> str:
    return os.path.expanduser(path)


REPOCIV_CONFIG_DIR = _expand(_env("REPOCIV_CONFIG_DIR", "~/.repociv"))
WONDERS_DIR = Path(REPOCIV_CONFIG_DIR) / "wonders"
LAUNCHED_JSON = WONDERS_DIR / "launched.json"
LOGS_DIR = WONDERS_DIR / "logs"

REPOCIV_REMOTE = _env("REPOCIV_REMOTE", "").lower() in ("true", "1", "yes")

BIBLIOTHECA_DIR = _expand(
    _env(
        "REPOCIV_WONDER_BIBLIOTHECA_DIR",
        "~/.hermes/workspace/repos/la-gran-biblioteca",
    )
)
INSTITUTUM_DIR = _expand(
    _env(
        "REPOCIV_WONDER_INSTITUTUM_DIR",
        "~/.hermes/workspace/repos/labhub",
    )
)

# ─── Allowlist (server-side fixed argv — never from the client) ───────────────


@dataclass(frozen=True)
class ProcSpec:
    name: str
    argv: tuple[str, ...]
    cwd: str
    log: str


@dataclass(frozen=True)
class WonderSpec:
    id: str
    repo_dir: str
    procs: tuple[ProcSpec, ...]
    api_url: str
    api_health_path: str
    ui_url: str
    api_timeout_s: float = 4.0
    ui_timeout_s: float = 4.0


WONDER_LAUNCH_SPECS: dict[str, WonderSpec] = {
    "bibliotheca": WonderSpec(
        id="bibliotheca",
        repo_dir=BIBLIOTHECA_DIR,
        procs=(
            ProcSpec(
                name="bridge",
                argv=("python", "-m", "backend.library_bridge"),
                cwd=BIBLIOTHECA_DIR,
                log="bibliotheca-bridge.log",
            ),
            ProcSpec(
                name="ui",
                argv=("npm", "run", "dev"),
                cwd=os.path.join(BIBLIOTHECA_DIR, "frontend"),
                log="bibliotheca-ui.log",
            ),
        ),
        api_url=_env("VITE_LGB_BACKEND_URL", "http://127.0.0.1:3001"),
        api_health_path="/api/health",
        ui_url=_env("VITE_WONDER_BIBLIOTHECA_URL", "http://127.0.0.1:5173"),
    ),
    "institutum": WonderSpec(
        id="institutum",
        repo_dir=INSTITUTUM_DIR,
        procs=(
            ProcSpec(
                name="dev",
                argv=("npm", "start"),
                cwd=INSTITUTUM_DIR,
                log="institutum-dev.log",
            ),
        ),
        api_url=_env("VITE_WONDER_INSTITUTUM_API_URL", "http://127.0.0.1:5281"),
        api_health_path="/health",
        ui_url=_env("VITE_WONDER_INSTITUTUM_URL", "http://127.0.0.1:5280"),
    ),
}

ALLOWED_IDS: frozenset[str] = frozenset(WONDER_LAUNCH_SPECS.keys())


# ─── State persistence ───────────────────────────────────────────────────────


_launch_lock = threading.Lock()
_launched: dict[str, dict[str, Any]] = {}


def _ensure_dirs() -> None:
    WONDERS_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)


def _load_state() -> dict[str, dict[str, Any]]:
    """Lazy-load launched.json into the in-memory cache.

    Idempotent within a process — the in-memory cache is the source of
    truth after the first load. The on-disk JSON is only the persistence
    layer for bridge restarts.
    """
    global _launched
    if _launched:
        return _launched
    if LAUNCHED_JSON.exists():
        try:
            with open(LAUNCHED_JSON) as f:
                _launched = json.load(f)
        except (OSError, json.JSONDecodeError):
            _launched = {}
    else:
        _launched = {}
    return _launched


def _save_state() -> None:
    _ensure_dirs()
    tmp = LAUNCHED_JSON.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(_launched, f, indent=2, sort_keys=True)
    tmp.replace(LAUNCHED_JSON)


def reset_state_for_tests() -> None:
    """Clear the in-memory cache. Tests use this to start fresh."""
    global _launched
    with _launch_lock:
        _launched = {}


# ─── Process / IO helpers ─────────────────────────────────────────────────────


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def _kill_pids(pids: dict[str, int], sig: int = 15) -> None:
    """Best-effort kill of a dict of name→pid (SIGTERM by default).

    Uses process-group kill when the pid matches a process group leader
    (which our PIDs do, thanks to start_new_session=True). Falls back
    to direct ``kill`` on PermissionError (the pid is a real process but
    not our group leader).
    """
    for pid in pids.values():
        try:
            os.killpg(pid, sig)
        except (OSError, ProcessLookupError):
            # OSError covers PermissionError + ESRCH here; ProcessLookupError
            # is an alias kept for clarity.
            try:
                os.kill(pid, sig)
            except (OSError, ProcessLookupError):
                pass


def _read_log_tail(path: Path, max_bytes: int = 4096) -> str:
    if not path.exists():
        return ""
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def _http_probe(url: str, timeout_s: float) -> bool:
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            return 200 <= r.status < 400
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return False


# ─── External adoption (Fix B: avoid clobbering manually-started servers) ─────


def _read_labhub_lockfile() -> dict[str, int] | None:
    """Parse the LabHub dev-start.sh lockfile (key=value format).

    Returns {bridge: pid, vite: pid} if found, else None. Used to
    "adopt" a manually-started LabHub instead of spawning a second
    copy that would kill the running one (dev-start.sh kills the
    ports first).
    """
    lock_path = Path(os.path.expanduser("~/.labhub/labhub.lock"))
    if not lock_path.exists():
        return None
    out: dict[str, int] = {}
    try:
        for line in lock_path.read_text().splitlines():
            if "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip().lower()
            val = val.strip()
            if key in ("bridge_pid", "vite_pid") and val.isdigit():
                out["bridge" if key == "bridge_pid" else "vite"] = int(val)
    except (OSError, ValueError):
        return None
    return out or None


def _resolve_python_executable(cwd: str) -> str:
    """Pick the best Python interpreter for a venv-aware spawn.

    Prefers a repo-local venv (backend/venv/bin/python, .venv/bin/python)
    so the spawned process inherits the right deps even when the parent
    interpreter is a different one. Falls back to ``python3`` (POSIX) or
    ``python`` (Windows-ish) so the launcher still works on a fresh
    checkout before ``python -m venv`` has been run.
    """
    cwd_p = Path(cwd)
    for venv_dir in (cwd_p / "backend" / "venv", cwd_p / ".venv"):
        candidate = venv_dir / "bin" / "python"
        if candidate.is_file():
            return str(candidate)
    return "python3"


def _try_adopt_external(wonder_id: str, spec: WonderSpec) -> dict[str, Any] | None:
    """If API+UI are already up (server started manually), adopt it.

    Records the PIDs we can recover (LabHub writes them to
    ``~/.labhub/labhub.lock``; for Bibliotheca there's no equivalent
    so the entry has no PIDs and the status still reports "ready"
    because health-checks pass).

    Returns the new entry, or ``None`` if no external server is
    detected (caller should spawn instead).
    """
    api_url = spec.api_url.rstrip("/") + spec.api_health_path
    ui_url = spec.ui_url.rstrip("/") + "/"
    api_ready = _http_probe(api_url, spec.api_timeout_s)
    ui_ready = _http_probe(ui_url, spec.ui_timeout_s)
    if not (api_ready or ui_ready):
        return None

    # Try to recover PIDs from the wonder-specific lockfile. Only
    # institutum has one (labhub/scripts/dev-start.sh writes it).
    # Bibliotheca has no dev-start.sh; we accept a no-PID entry and
    # rely on health to confirm the server is up.
    recovered_pids: dict[str, int] = {}
    if wonder_id == "institutum":
        from_lockfile = _read_labhub_lockfile()
        if from_lockfile:
            recovered_pids = from_lockfile

    entry = {
        "id": wonder_id,
        "pids": recovered_pids,
        "started_at": time.time(),
        "api_url": spec.api_url,
        "ui_url": spec.ui_url,
        "log_files": [],
        "external": True,  # mark as adopted, not launched-by-us
    }
    state = _load_state()
    state[wonder_id] = entry
    _save_state()
    return entry


# ─── Errors ──────────────────────────────────────────────────────────────────


class WonderLauncherError(Exception):
    """Raised on validation failures (bad id, missing repo, remote mode, etc.).

    The HTTP route layer maps ``status`` to the response code and returns
    ``{ok: false, error: message, code: code}``.
    """

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


# ─── Public API ──────────────────────────────────────────────────────────────


def get_spec(wonder_id: str) -> WonderSpec:
    if wonder_id not in WONDER_LAUNCH_SPECS:
        raise WonderLauncherError(
            "unknown_wonder",
            f"unknown wonder id: {wonder_id!r}. Allowed: {sorted(ALLOWED_IDS)}",
            status=404,
        )
    return WONDER_LAUNCH_SPECS[wonder_id]


def list_launchable() -> list[str]:
    return sorted(ALLOWED_IDS)


def _build_status(wonder_id: str, entry: dict[str, Any] | None) -> dict[str, Any]:
    """Build the launch-status response for a wonder.

    State machine — health-checks are the source of truth, PID liveness
    is only used to disambiguate "still warming up" from "process gone":

      - "offline"   — never launched (entry is None)
      - "ready"     — API + UI both respond
      - "degraded"  — exactly one of API/UI up
      - "starting"  — neither up yet, PID(s) still alive
      - "error"     — neither up AND all spawned PIDs are gone

    Grace period: a freshly-launched wonder whose PIDs have all exited
    (the npm parent dies within ~1s of dev-start.sh forking the real
    procs) is reported as "starting", not "error", for the first
    ``_STARTUP_GRACE_S`` seconds. Without this, the F3 poller would
    see "error" during the transient window between npm-died and
    bridge-binded and abort the launch even though everything is
    actually fine.

    Why: ``institutum`` spawns a single ``npm start`` whose child
    (dev-start.sh) launches bridge+Vite detached, then exits. The npm
    process dies in seconds while the children live. With the old
    "PID-alive is required" check, that path reported "error" even
    though LabHub was perfectly healthy. Health wins.
    """
    spec = WONDER_LAUNCH_SPECS[wonder_id]

    if entry is None:
        return {
            "id": wonder_id,
            "status": "offline",
            "api_ready": False,
            "ui_ready": False,
            "ready": False,
            "pids": {},
            "started_at": None,
            "api_url": spec.api_url,
            "ui_url": spec.ui_url,
            "log_tail": "",
            "error": None,
        }

    pids = entry.get("pids", {})
    any_alive = any(_pid_alive(pid) for pid in pids.values())
    api_url = entry.get("api_url", spec.api_url)
    ui_url = entry.get("ui_url", spec.ui_url)

    api_ready = _http_probe(api_url.rstrip("/") + spec.api_health_path, spec.api_timeout_s)
    ui_ready = _http_probe(ui_url.rstrip("/") + "/", spec.ui_timeout_s)

    started_at = entry.get("started_at")
    in_grace_period = (
        started_at is not None and (time.time() - float(started_at)) < _STARTUP_GRACE_S
    )

    if api_ready and ui_ready:
        status = "ready"
        error_msg = None
    elif api_ready or ui_ready:
        status = "degraded"
        error_msg = None
    elif pids and not any_alive and not in_grace_period:
        # Real terminal error: procs were spawned, exited, and the
        # grace period has elapsed (so this isn't just a slow
        # cold-start where npm died before bridge bound).
        status = "error"
        error_msg = "all launched processes exited"
    else:
        status = "starting"
        error_msg = None

    log_files = entry.get("log_files", [])
    log_tail = ""
    if log_files:
        log_tail = _read_log_tail(LOGS_DIR / log_files[-1])[-1024:]

    return {
        "id": wonder_id,
        "status": status,
        "api_ready": api_ready,
        "ui_ready": ui_ready,
        "ready": api_ready and ui_ready,
        "pids": pids,
        "started_at": started_at,
        "api_url": api_url,
        "ui_url": ui_url,
        "log_tail": log_tail,
        "error": error_msg,
    }


# ─── Errors ──────────────────────────────────────────────────────────────────


# Grace window (seconds) during which a freshly-launched wonder whose
# tracked PIDs have all exited is still reported as "starting" (not
# "error"). 20s is enough to cover the npm-parent-dies-then-children-
# come-up sequence of dev-start.sh.
_STARTUP_GRACE_S = 20.0


def launch_wonder(wonder_id: str) -> dict[str, Any]:
    """Idempotent launcher.

    Behaviour:
      - already running (PIDs alive) → returns current status, status=
        "ready" / "starting" / "degraded" depending on health.
      - never launched → spawns the allowlisted procs, persists PIDs,
        returns status="starting".
      - previously launched but PIDs exited → respawns and overwrites.

    Raises ``WonderLauncherError`` for: unknown id, missing repo cwd,
    spawn failures, or remote mode.

    The on-disk state is updated under ``_launch_lock`` so concurrent
    launch_wonder() calls for the same id cannot double-spawn.
    """
    if REPOCIV_REMOTE:
        raise WonderLauncherError(
            "remote_rejected",
            "wonder launch is disabled in remote mode (loopback-only). "
            "Start the wonder's server manually on the host.",
            status=403,
        )

    spec = get_spec(wonder_id)

    repo = Path(spec.repo_dir)
    if not repo.exists() or not repo.is_dir():
        raise WonderLauncherError(
            "repo_not_found",
            f"wonder repo not found: {spec.repo_dir}. "
            f"Set REPOCIV_WONDER_{wonder_id.upper()}_DIR or install the repo.",
            status=412,
        )

    with _launch_lock:
        state = _load_state()
        existing = state.get(wonder_id)
        if existing:
            # If we have a real PID alive (i.e. something we spawned is
            # still running), treat as already-running.
            if any(_pid_alive(pid) for pid in existing.get("pids", {}).values()):
                return _build_status(wonder_id, existing)
            # If we previously adopted an external server, also keep the
            # entry (its health will be re-checked below).
            if existing.get("external"):
                return _build_status(wonder_id, existing)

        # Pre-launch health check: if the user already started this
        # wonder by hand, adopt it (no spawn, no clobber). LabHub
        # specifically would kill the running instance because
        # dev-start.sh kills the ports before relaunching.
        adopted = _try_adopt_external(wonder_id, spec)
        if adopted is not None:
            return _build_status(wonder_id, adopted)

        # Spawn each proc; roll back partial spawn on any failure.
        spawned: dict[str, int] = {}
        spawned_logs: list[str] = []
        _ensure_dirs()
        for proc_spec in spec.procs:
            proc_cwd = Path(proc_spec.cwd)
            if not proc_cwd.exists() or not proc_cwd.is_dir():
                _kill_pids(spawned)
                raise WonderLauncherError(
                    "proc_cwd_not_found",
                    f"process cwd not found: {proc_cwd} (proc={proc_spec.name})",
                    status=412,
                )
            log_path = LOGS_DIR / proc_spec.log
            try:
                log_fh = open(log_path, "ab")
            except OSError as e:
                _kill_pids(spawned)
                raise WonderLauncherError(
                    "log_open_failed",
                    f"failed to open log {log_path}: {e}",
                    status=500,
                )
            # Resolve interpreter (e.g. python → backend/venv/bin/python)
            # so the spawned process picks up the repo's deps.
            argv = list(proc_spec.argv)
            if argv and Path(argv[0]).name in ("python", "python3"):
                argv[0] = _resolve_python_executable(str(proc_cwd))
            try:
                proc = subprocess.Popen(
                    argv,
                    cwd=str(proc_cwd),
                    stdout=log_fh,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except OSError as e:
                log_fh.close()
                _kill_pids(spawned)
                raise WonderLauncherError(
                    "spawn_failed",
                    f"failed to spawn {proc_spec.name}: {e}",
                    status=500,
                )
            spawned[proc_spec.name] = proc.pid
            spawned_logs.append(proc_spec.log)

        entry = {
            "id": wonder_id,
            "pids": spawned,
            "started_at": time.time(),
            "api_url": spec.api_url,
            "ui_url": spec.ui_url,
            "log_files": spawned_logs,
            "external": False,
        }
        state[wonder_id] = entry
        _save_state()
        return _build_status(wonder_id, entry)


def wonder_launch_status(wonder_id: str) -> dict[str, Any]:
    get_spec(wonder_id)  # validates id
    state = _load_state()
    return _build_status(wonder_id, state.get(wonder_id))


def stop_wonder(wonder_id: str) -> dict[str, Any]:
    """Send SIGTERM to the process group(s) and forget the entry.

    Idempotent: returns ``{ok: false, error: not_launched}`` if the
    wonder is not in the state. Otherwise kills (best-effort) and
    removes the entry.
    """
    get_spec(wonder_id)  # validates id
    with _launch_lock:
        state = _load_state()
        entry = state.get(wonder_id)
        if not entry:
            return {"ok": False, "id": wonder_id, "error": "not launched"}
        pids = entry.get("pids", {})
        _kill_pids(pids, sig=15)
        del state[wonder_id]
        _save_state()
        return {"ok": True, "id": wonder_id, "killed_pids": pids}
