#!/usr/bin/env python3
"""RepoCiv ↔ DAVI bridge — hardened gateway (Sprint B).

Security:
  - All POST routes require X-RepoCiv-Token header.
  - CORS restricted to http://localhost:5273 and http://127.0.0.1:5273.
  - Request body limited to 128 KB.
  - Incoming commands validated via command_schema.py.
  - Rate limit: 60 requests/minute per IP (in-memory, resets on restart).

Endpoints:
  GET  /health                    — liveness
  GET  /ready                     — readiness
  GET  /missions                  — persisted missions list
  GET  /gpu                       — VRAM + temp via nvidia-smi
  GET  /pending                   — tasks from PENDING_TRACKER.md
  GET  /context                   — XCOM fatigue state
  GET  /events                    — event store replay (?since=<unix_ts>)
  GET  /approvals                 — commands waiting_approval
  GET  /agents                    — agent status + heartbeat + queue depth
  GET  /agents/capabilities       — capability model (Fase 6)
  GET  /metrics                   — observability metrics (Fase 7)
  GET  /improve/reflect           — SICA: list observed improvement patterns
  GET  /improve/proposals         — SICA: list scoped, schema-valid proposals
  POST /commands                  — new Command Bus intake
  POST /commands/<id>/cancel      — cancel a queued command
  POST /approvals/<id>/approve    — approve a pending command
  POST /approvals/<id>/reject     — reject a pending command
  POST /                          — legacy unit_command / quest_add

Uso:
    python3 server/bridge.py
"""

from __future__ import annotations

import sys
if __name__ == "__main__":
    # Alias the __main__ module to server.bridge to prevent duplicate loading and state bifurcation
    sys.modules["server.bridge"] = sys.modules["__main__"]

from .sse_server import _fanout_sse, _register_sse_client, _unregister_sse_client, send_to_repociv  # noqa: F401 (_fanout_sse patched by tests)
from .pending_tracker import load_pending_tasks, append_pending_task, change_pending_state, resolve_pending_task, edit_pending_task, delete_pending_task, PENDING_TRACKER  # noqa: F401 (re-exported for tests and external callers)
from .process_scanner import scan_active_processes, detect_lexo
import hmac
import json
import os
import queue
import shutil  # noqa: F401 (patched by tests via bridge.shutil)
import signal
import subprocess
import threading
import time
import urllib.request  # noqa: F401 (patched by tests via bridge.urllib.request)
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


# ─── .env loader ─────────────────────────────────────────────────────────────
def _load_dotenv() -> None:
    # Load RepoCiv own .env first
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        _load_dotenv_file(env_path)
    # Then load Hermes .env (API keys for providers) — non-existing keys are skipped
    hermes_env = Path.home() / ".hermes" / ".env"
    if hermes_env.exists():
        _load_dotenv_file(hermes_env)

def _load_dotenv_file(env_path: Path) -> None:
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except Exception:
        pass


_load_dotenv()

REPOCIV_PORT = int(os.environ.get("REPOCIV_PORT", "5273"))
BRIDGE_PORT  = int(os.environ.get("BRIDGE_PORT", "5274"))
BRIDGE_WS_PORT = int(os.environ.get("BRIDGE_WS_PORT", "5275"))
REPOCIV_TOKEN = os.environ.get("REPOCIV_TOKEN", "")  # empty = auth disabled (dev only)
REPOCIV_REMOTE = os.environ.get("REPOCIV_REMOTE", "").lower() in ("true", "1", "yes")

# ─── Remote mode: force 0.0.0.0 + require token ─────────────────────────────
if REPOCIV_REMOTE and not REPOCIV_TOKEN:
    print("ERROR: REPOCIV_REMOTE=true requires REPOCIV_TOKEN to be set.")
    print("Generate one with: python3 -c \"import secrets; print(secrets.token_hex(32))\"")
    raise SystemExit(1)

BRIDGE_HOST = "0.0.0.0" if REPOCIV_REMOTE else "127.0.0.1"

CONFIG_DIR = Path(os.path.expanduser(os.environ.get("REPOCIV_CONFIG_DIR", "~/.repociv")))
MISSIONS_FILE    = CONFIG_DIR / "missions.json"
HERMES_ROOT      = Path(os.path.expanduser(os.environ.get("HERMES_ROOT", "~/.hermes")))

# ─── CORS allowed origins ─────────────────────────────────────────────────────
# Remote mode: allow the configured remote origin only (not wildcard).
# REPOCIV_REMOTE_ORIGIN overrides; falls back to REPOCIV_PORT-based localhost
# so that the Vite dev proxy keeps working even when remote=true.
if REPOCIV_REMOTE:
    _remote_origin = os.environ.get("REPOCIV_REMOTE_ORIGIN", "").strip()
    _ALLOWED_ORIGINS: set[str] = (
        {_remote_origin} if _remote_origin
        else {
            f"http://localhost:{REPOCIV_PORT}",
            f"http://127.0.0.1:{REPOCIV_PORT}",
        }
    )
else:
    _ALLOWED_ORIGINS = {
        f"http://localhost:{REPOCIV_PORT}",
        f"http://127.0.0.1:{REPOCIV_PORT}",
    }

# ─── Body size limit ──────────────────────────────────────────────────────────
_MAX_BODY = 128 * 1024  # 128 KB

# ─── Rate limiter (per-IP, in-memory) ────────────────────────────────────────
_rate_lock = threading.Lock()
_rate_buckets: dict[str, list[float]] = {}
_RATE_LIMIT = 60
_RATE_WINDOW = 60.0


def _rate_check(ip: str) -> bool:
    """Return True if request is allowed, False if rate-limited."""
    now = time.time()
    with _rate_lock:
        bucket = _rate_buckets.setdefault(ip, [])
        bucket[:] = [t for t in bucket if now - t < _RATE_WINDOW]
        if len(bucket) >= _RATE_LIMIT:
            return False
        bucket.append(now)
        return True


# ─── Approval queue ───────────────────────────────────────────────────────────
_approval_lock = threading.Lock()
_approvals: dict[str, dict[str, Any]] = {}  # command_id → command dict


def _add_approval(cmd_dict: dict[str, Any]) -> None:
    with _approval_lock:
        _approvals[cmd_dict["id"]] = cmd_dict


def _get_approvals() -> list[dict[str, Any]]:
    with _approval_lock:
        return list(_approvals.values())


def _pop_approval(cmd_id: str) -> dict[str, Any] | None:
    with _approval_lock:
        return _approvals.pop(cmd_id, None)


# ─── Event store init
from server import event_store as _es  # noqa: E402
from server import sessions as _sessions  # noqa: E402
from server import run_state as _run_state  # noqa: E402
from server import workspace_issue as _wi  # noqa: E402
from server import checkpoint as _checkpoint  # noqa: E402
from server import endpoint_usage as _endpoint_usage  # noqa: E402

# ─── Command schema + policy
from server.command_schema import validate_command, CommandValidationError, Command  # noqa: E402
from server import policy as _policy  # noqa: E402
from server.context_pack import build_context_pack  # noqa: E402
from server import directive_store as _ds  # noqa: E402
from server import directive_learner as _dl  # noqa: E402
from server import harness_registry as _hr  # noqa: E402
from server import recovery as _recovery  # noqa: E402
from server import runtime_adapters as _runtime_adapters  # noqa: E402
from server import agent_runner as _agent_runner  # noqa: E402
from server import task_orchestrator as _to  # noqa: E402
from server import rate_limiter as _rl  # noqa: E402
from server import missions_store as _missions_store  # noqa: E402
from server import fatigue_state as _fatigue_state_mod  # noqa: E402
from server import command_executors as _command_executors  # noqa: E402

_BRIDGE_STATE_CONFIG_DIR: Path | None = None


def init_bridge_state(config_dir: Path | str | None = None) -> Path:
    """Initialize persistent bridge stores.

    The bridge historically initialized stores at import time. Keeping this
    function idempotent preserves runtime compatibility while allowing tests and
    future callers to rebind bridge state explicitly to a temporary directory.
    """
    global CONFIG_DIR, MISSIONS_FILE, _BRIDGE_STATE_CONFIG_DIR

    selected = Path(config_dir) if config_dir is not None else CONFIG_DIR
    selected = Path(os.path.expanduser(str(selected)))
    selected.mkdir(exist_ok=True, parents=True)

    CONFIG_DIR = selected
    MISSIONS_FILE = CONFIG_DIR / "missions.json"
    _missions_store.init(CONFIG_DIR)
    _es.init(CONFIG_DIR)
    _sessions.init(CONFIG_DIR)
    _run_state.init(CONFIG_DIR)
    _wi.init(CONFIG_DIR)
    _checkpoint.init(CONFIG_DIR)
    _endpoint_usage.init(CONFIG_DIR)
    _ds.init(CONFIG_DIR)
    _dl.set_templates_path(CONFIG_DIR / "directive_templates.json")
    _BRIDGE_STATE_CONFIG_DIR = CONFIG_DIR
    return CONFIG_DIR


init_bridge_state(CONFIG_DIR)

# ─── Per-agent-type rate limiter ──────────────────────────────────────────────
_agent_rate_limiter = _rl.RateLimiter()

# ─── Scheduler ────────────────────────────────────────────────────────────────
from server import scheduler as _sched  # noqa: E402


# ─── Mission persistence ──────────────────────────────────────────────────────
def load_missions() -> list[dict[str, Any]]:
    return _missions_store.load_missions()


def save_mission(mission: dict[str, Any]) -> None:
    _missions_store.save_mission(mission)


# ─── XCOM Context Fatigue state ───────────────────────────────────────────────
_fatigue_state = _fatigue_state_mod._fatigue_state
_rest_areas = _fatigue_state_mod._rest_areas


def get_unit_fatigue(unit_id: str) -> dict[str, Any]:
    return _fatigue_state_mod.get_unit_fatigue(unit_id)


def update_unit_fatigue(unit_id: str, *, fatigue: int | None = None,
                        effective_speed: float | None = None,
                        is_resting: bool | None = None,
                        rest_area_id: str | None = None,
                        delta: int = 0) -> dict[str, Any]:
    return _fatigue_state_mod.update_unit_fatigue(
        unit_id,
        fatigue=fatigue,
        effective_speed=effective_speed,
        is_resting=is_resting,
        rest_area_id=rest_area_id,
        delta=delta,
    )


def discover_rest_area(rest_area_id: str, room_id: str, coord: tuple,
                       recovery_rate: float = 8.0, capacity: int = 4) -> dict[str, Any]:
    return _fatigue_state_mod.discover_rest_area(
        rest_area_id,
        room_id,
        coord,
        recovery_rate=recovery_rate,
        capacity=capacity,
    )


def enter_rest_area(unit_id: str, rest_area_id: str) -> bool:
    return _fatigue_state_mod.enter_rest_area(unit_id, rest_area_id)


def exit_rest_area(unit_id: str) -> None:
    _fatigue_state_mod.exit_rest_area(unit_id)


# ─── GPU info ─────────────────────────────────────────────────────────────────
def get_gpu_info() -> dict[str, Any] | None:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3,
        )
        if result.returncode != 0:
            return None
        line = result.stdout.strip().split("\n")[0]
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3:
            return None
        return {"vramUsed": int(parts[0]), "vramTotal": int(parts[1]), "temp": int(parts[2])}
    except Exception:
        return None


# ─── Agent runner facade ──────────────────────────────────────────────────────
def _configure_agent_runner() -> None:
    _agent_runner.configure(send=send_to_repociv, save=save_mission)
    from server import subagent_tracker as _st  # noqa: PLC0415
    _st.configure(send=send_to_repociv, add_approval=_add_approval)


def _run_openclaw_streaming(unit_id: str, mission_id: str, mission: str,
                             config: dict[str, Any],
                             working_dir: str | None = None,
                             city_id: str = "",
                             model: str = "") -> tuple[bool, str]:
    _configure_agent_runner()
    return _agent_runner._run_openclaw_streaming(unit_id, mission_id, mission, config, working_dir, city_id, model)


def _run_hermes_streaming(unit_id: str, mission_id: str, mission: str,
                           config: dict[str, Any] | None = None,
                           working_dir: str | None = None,
                           city_id: str = "",
                           model: str = "") -> tuple[bool, str]:
    _configure_agent_runner()
    return _agent_runner._run_hermes_streaming(unit_id, mission_id, mission, config, working_dir, city_id, model)

def run_agent(unit_id: str, city_id: str, mission: str, agent_type: str = "hero",
              command_id: str | None = None, harness: str = "", provider: str = "", model: str = "",
              repo_path: str = "", file_path: str = "") -> None:
    _configure_agent_runner()
    return _agent_runner.run_agent(unit_id, city_id, mission, agent_type, command_id, harness=harness, provider=provider, model=model, repo_path=repo_path, file_path=file_path)


def _execute_streaming(unit_id: str, mission_id: str, mission: str,
                       working_dir: str | None = None,
                       city_id: str = "",
                       harness: str = "",
                       provider: str = "",
                       model: str = "") -> tuple[bool, str]:
    _configure_agent_runner()
    return _agent_runner._execute_streaming(unit_id, mission_id, mission, working_dir, city_id,
                                             harness=harness, provider=provider, model=model)


def _has_openclaw() -> bool:
    return _agent_runner._has_openclaw()


def _find_openclaw() -> str | None:
    return _agent_runner._find_openclaw()


def _has_claude_code() -> bool:
    return _agent_runner._has_claude_code()


def _has_cursor() -> bool:
    return _agent_runner._has_cursor()


def _has_codex() -> bool:
    return _agent_runner._has_codex()


# ─── Command Bus intake ───────────────────────────────────────────────────────
def _handle_command(cmd: Command) -> dict[str, Any]:
    """Apply policy, attach context pack, dispatch or queue command."""
    cmd, block_reason = _policy.apply_policy(cmd)
    _es.record_created(cmd.id, cmd.created_by, cmd.to_dict())

    if cmd.status == "rejected":
        reason = block_reason or "blocked by policy"
        _es.record_rejected(cmd.id, reason)
        return {"ok": False, "status": "rejected", "commandId": cmd.id,
                "reason": reason}

    # Attach context pack to payload so the agent starts with context
    agent_id = str(cmd.payload.get("unit", "MAIN"))
    cmd.payload["_context"] = build_context_pack(agent_id, cmd.target, _es)

    if cmd.status == "waiting_approval":
        _es.record_waiting_approval(cmd.id)
        _add_approval(cmd.to_dict())
        send_to_repociv({"type": "log",
                         "msg": f"Aprobación requerida: {cmd.type} → {cmd.target}",
                         "level": "warn"})
        send_to_repociv({"type": "waiting_approval",
                         "commandId": cmd.id,
                         "commandType": cmd.type,
                         "target": cmd.target,
                         "risk": cmd.risk})
        return {"ok": True, "status": "waiting_approval", "commandId": cmd.id}

    # auto-safe: enqueue in scheduler (priority-sorted dispatch)
    _es.record_queued(cmd.id)
    send_to_repociv({"type": "log",
                     "msg": f"Comando encolado: {cmd.type} → {cmd.target}",
                     "level": "info"})

    _sched.enqueue(cmd)
    return {"ok": True, "status": "queued", "commandId": cmd.id}


def _default_mission_for_command(cmd: Command) -> str:
    return _command_executors.default_mission_for_command(cmd)


def _register_issue_run(payload: dict[str, Any], run_id: str) -> None:
    _command_executors.register_issue_run(payload, run_id, _wi.register_run)


def _dispatch_command(cmd: Command) -> None:
    from server import subagent_tracker as _st  # noqa: PLC0415
    _command_executors.dispatch_command(
        cmd,
        run_agent=run_agent,
        send_to_repociv=send_to_repociv,
        append_pending_task=append_pending_task,
        save_mission=save_mission,
        infer_adapter_for_command=lambda command_type, harness_id: _runtime_adapters.infer_adapter_for_command(command_type, harness_id),
        sessions_patch=_sessions.patch,
        sessions_append_message=_sessions.append_message,
        run_state_save=_run_state.save,
        event_record_output_chunk=_es.record_output_chunk,
        event_record_completed=_es.record_completed,
        event_record_failed=_es.record_failed,
        record_outcome=_ds.record_outcome,
        register_issue_run_fn=_register_issue_run,
        task_run=_to.run_task,
        subagent_approve_spawn=_st.approve_spawn,
        subagent_request_dispatch=_st.request_dispatch,
    )


# ─── HTTP Handler ─────────────────────────────────────────────────────────────
from . import http_routes as _routes  # noqa: E402


class BridgeHandler(BaseHTTPRequestHandler):

    def _origin(self) -> str:
        return self.headers.get("Origin", "")

    def _cors(self) -> None:
        # _ALLOWED_ORIGINS is always a concrete set (localhost pair, or the
        # configured REPOCIV_REMOTE_ORIGIN). We never emit a wildcard ACAO:
        # auth is token-based and credentials/headers depend on a known origin.
        origin = self._origin()
        if origin in _ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        else:
            # Fallback for non-browser clients / curl (no/Origin not allowed):
            # reflect the canonical localhost origin, never the caller's.
            self.send_header("Access-Control-Allow-Origin", f"http://localhost:{REPOCIV_PORT}")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-RepoCiv-Token")
        self.send_header("Vary", "Origin")

    def _check_token(self) -> bool:
        """Return True if the request carries a valid token (or token is not configured)."""
        if not REPOCIV_TOKEN:
            return True  # auth disabled in dev
        received = self.headers.get("X-RepoCiv-Token", "")
        # Constant-time comparison to avoid a timing oracle on the token
        # (relevant when REPOCIV_REMOTE=true exposes auth over the network).
        return hmac.compare_digest(received.encode("utf-8"), REPOCIV_TOKEN.encode("utf-8"))

    def _client_ip(self) -> str:
        return self.client_address[0] if self.client_address else "unknown"

    def _rate_limited(self) -> bool:
        return not _rate_check(self._client_ip())

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self._cors()
        self.end_headers()

    def _parse_qs(self) -> dict[str, str]:
        """Parse query string into a flat dict, URL-decoding values."""
        params: dict[str, str] = {}
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        for part in qs.split("&"):
            if "=" in part:
                k, _, v = part.partition("=")
                params[k] = v
        # URL-decode values
        import urllib.parse as _up
        decoded: dict[str, str] = {}
        for k, v in params.items():
            decoded[k] = _up.unquote_plus(v)
        return decoded

    def _respond(self, status: int, data: Any) -> None:
        """Write a JSON response with CORS headers."""
        _endpoint_usage.record(self.command, self.path, status)
        if status == 200:
            self._json(data, record_usage=False)
        else:
            payload = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(payload)

    def _err_json(self, status: int, error: str) -> None:
        """Write a plain error JSON response with Content-Type set."""
        _endpoint_usage.record(self.command, self.path, status)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps({"error": error}).encode())

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        params = self._parse_qs()
        ctx: dict[str, Any] = {"params": params}

        # Health and ready endpoints are exempt from token auth (used by monitors)
        if path not in ("/health", "/ready") and not self._check_token():
            # EventSource cannot send custom headers — accept the token via
            # query param for the SSE stream only.
            sse_token_ok = (
                path == "/events"
                and bool(REPOCIV_TOKEN)
                and hmac.compare_digest(
                    params.get("token", "").encode("utf-8"),
                    REPOCIV_TOKEN.encode("utf-8"),
                )
            )
            if not sse_token_ok:
                self._err_json(401, "unauthorized")
                return

        # ── Simple exact-match GET routes ──────────────────────────────────────
        _GET_EXACT: dict[str, Any] = {
            "/health":             _routes.get_health,
            "/ready":              _routes.get_ready,
            "/missions":           _routes.get_missions,
            "/subagents":          _routes.get_subagents,
            "/gpu":                _routes.get_gpu,
            "/pending":            _routes.get_pending,
            "/context":            _routes.get_context,
            "/approvals":          _routes.get_approvals,
            "/agents":             _routes.get_agents,
            "/agents/capabilities": _routes.get_agents_capabilities,
            "/api/providers":      _routes.get_chat_config,
            "/providers":          _routes.get_chat_config,
            "/api/chat-config":    _routes.get_chat_config,
            "/metrics":            _routes.get_metrics,
            "/directives/stats":   _routes.get_directives_stats,
            "/directives/suggest": _routes.get_directives_suggest,
            "/harnesses":          _routes.get_harnesses,
            "/api/config/default-harness": _routes.get_default_harness,
            "/log":                _routes.get_log,
            "/tasks":              _routes.get_tasks,
            "/improve/reflect":    _routes.get_improve_reflect,
            "/improve/proposals":  _routes.get_improve_proposals,
            "/providers/live":     _routes.get_providers_live,
            "/ws":                 _routes.get_ws_info,
            "/api/news/latest":    _routes.get_latest_news,
            "/api/wonders":        _routes.get_wonders,
            "/api/wonders/launchable": _routes.get_wonder_launchable,
            "/wonders":            _routes.get_wonders,  # legacy alias
            "/api/graph-relations":       _routes.get_graph_relations,
            "/api/graph-relations/stats": _routes.get_graph_relations_stats,
            "/api/foreign/repo-profile": _routes.get_repo_profile,
            "/api/foreign/repo-profile/cache": _routes.get_repo_profile_cache,
            "/api/foreign/reports": _routes.get_reports,
            "/api/labhub/status":    _routes.get_labhub_status,
            "/api/profiles":         _routes.get_profiles,
        }
        if path in _GET_EXACT:
            status, body = _GET_EXACT[path](ctx)
            self._respond(status, body)
            return

        # ── SSE stream ────────────────────────────────────────────────────────
        if path == "/events":
            accept = self.headers.get("Accept", "")
            if "text/event-stream" in accept:
                _endpoint_usage.record("GET", self.path, 200)
                self._sse_stream()
                return
            try:
                since = float(params.get("since", "0"))
            except Exception:
                since = 0.0
            self._json(_es.read_events(since=since))
            return

        # ── Prefix-match GET routes ────────────────────────────────────────────
        if path.startswith("/harnesses/"):
            ctx["harness_id"] = path.split("/", 2)[2]
            status, body = _routes.get_harness_by_id(ctx)
            self._respond(status, body)
            return

        if path.startswith("/api/wonders/") or path.startswith("/wonders/"):
            # Canonical: /api/wonders/{id}[/health|launch-status]; legacy: /wonders/{id}[...]
            prefix = "/api/wonders/" if path.startswith("/api/wonders/") else "/wonders/"
            rest = path[len(prefix):]
            parts = rest.split("/")
            if len(parts) >= 2 and parts[1] == "health":
                status, body = _routes.get_wonder_health({"wonder_id": parts[0]})
                self._respond(status, body)
                return
            if len(parts) >= 2 and parts[1] == "launch-status":
                status, body = _routes.get_wonder_launch_status({"wonder_id": parts[0]})
                self._respond(status, body)
                return
            if parts[0]:
                status, body = _routes.get_wonder_by_id({"wonder_id": parts[0]})
                self._respond(status, body)
                return

        if path.startswith("/tasks/"):
            parts = path.split("/")[2:]
            if len(parts) >= 3 and parts[2] == "circuit-status":
                ctx["repo"], ctx["issue_id"], ctx["circuit"] = parts[0], parts[1], True
            elif len(parts) >= 2:
                ctx["repo"], ctx["issue_id"], ctx["circuit"] = parts[0], parts[1], False
            else:
                self._err_json(404, "invalid task path")
                return
            status, body = _routes.get_task_by_key(ctx)
            self._respond(status, body)
            return

        # ── Mission tree (subagent swarm log) ────────────────────────────────
        if path.startswith("/missions/") and path.endswith("/tree"):
            mission_id = path[len("/missions/"):path.rfind("/tree")]
            if mission_id:
                ctx["mission_id"] = mission_id
                status, body = _routes.get_mission_tree(ctx)
                self._respond(status, body)
                return

        # ── Foreign relations report by ID ─────────────────────────────────────
        if path.startswith("/api/foreign/reports/"):
            parts = path.split("/")
            if len(parts) >= 5:
                report_id = parts[4]
                status, body = _routes.get_report_by_id({"report_id": report_id})
                self._respond(status, body)
                return

        # ── Graph relations evidence / refresh ──────────────────────────────────
        if path == "/api/graph-relations/evidence":
            status, body = _routes.get_graph_relations_evidence(ctx)
            self._respond(status, body)
            return
        if path.startswith("/api/graph-relations/"):
            parts = path.split("/")
            if len(parts) >= 5 and parts[4] == "evidence":
                ctx["from_id"] = parts[5] if len(parts) > 5 else ""
                ctx["to_id"] = params.get("toId", "")
                status, body = _routes.get_graph_relations_evidence(ctx)
                self._respond(status, body)
                return

        # ── LabHub per-city status ───────────────────────────────────────────────
        if path.startswith("/api/labhub/status/"):
            city_id = path[len("/api/labhub/status/"):].split("/")[0]
            if city_id:
                ctx["city_id"] = city_id
                status, body = _routes.get_city_lab_status(ctx)
                self._respond(status, body)
                return

        # ── File tree API for local view ──────────────────────────────────────────
        if path.startswith("/api/files/"):
            repo_id = path[len("/api/files/"):].split("/")[0]
            if repo_id:
                ctx["path"] = self.path  # full path for extraction
                ctx["repo_path"] = ""  # will be resolved from repo_id
                status, body = _routes.get_repo_file_tree(ctx)
                self._respond(status, body)
                return

        self._err_json(404, "not found")

    def do_POST(self) -> None:
        # Token auth first: an unauthenticated caller must not be able to
        # consume another IP's rate-limit budget (or trip the limiter at all).
        if not self._check_token():
            self._err_json(401, "unauthorized")
            return

        if self._rate_limited():
            self._err_json(429, "rate limited")
            return

        # Body size guard — tolerate a missing/garbage Content-Length header
        # instead of crashing with an unhandled ValueError (500).
        try:
            length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            self._err_json(400, "invalid Content-Length")
            return
        if length < 0 or length > _MAX_BODY:
            self._err_json(413, "payload too large")
            return

        try:
            body = json.loads(self.rfile.read(length))
        except Exception:
            self._err_json(400, "invalid JSON")
            return

        path = self.path.split("?")[0]

        # ── Simple exact-match POST routes ────────────────────────────────────
        _POST_EXACT: dict[str, Any] = {
            "/directives/record": _routes.post_directives_record,
            "/commands":          _routes.post_commands,
            "/pending/add":       _routes.post_pending_add,
            "/pending/resolve":   _routes.post_pending_resolve,
            "/pending/edit":      _routes.post_pending_edit,
            "/pending/delete":    _routes.post_pending_delete,
            "/pending/state":     _routes.post_pending_state,
            "/api/news/read":     _routes.post_news_read,
            "/api/news/scan":     _routes.post_news_scan,
            "/api/foreign/score": _routes.post_foreign_score,
            "/api/foreign/report": _routes.post_foreign_report,
            "/api/graph-relations/flags": _routes.post_graph_relations_flags,
            "/api/graph-relations/refresh": _routes.post_graph_relations_refresh,
            "/session/reset":  _routes.post_session_reset,
            "/model/override": _routes.post_model_override,
            "/api/config/default-harness": _routes.post_default_harness,
            "/subagents/cancel": _routes.post_subagent_cancel,
            "/api/profiles": _routes.post_profiles,
            "/api/profiles/delete": _routes.post_profiles_delete,
        }
        if path in _POST_EXACT:
            status, resp = _POST_EXACT[path](body, {})
            self._respond(status, resp)
            return

        # ─── Wonder auto-start (F2) ─────────────────────────────────────────────
        if path.startswith("/api/wonders/") or path.startswith("/wonders/"):
            prefix = "/api/wonders/" if path.startswith("/api/wonders/") else "/wonders/"
            rest = path[len(prefix):]
            parts = rest.split("/")
            if len(parts) >= 2 and parts[1] == "launch":
                status, resp = _routes.post_wonder_launch(body, {"wonder_id": parts[0]})
                self._respond(status, resp)
                return
            if len(parts) >= 2 and parts[1] == "stop":
                status, resp = _routes.post_wonder_stop(body, {"wonder_id": parts[0]})
                self._respond(status, resp)
                return

        # ── Prefix-match POST routes ───────────────────────────────────────────
        if path.startswith("/commands/") and path.endswith("/cancel"):
            cmd_id = path.split("/")[2]
            removed = _sched.cancel(cmd_id)
            # Also check approval queue
            if not removed:
                removed = _pop_approval(cmd_id) is not None
                if removed:
                    _es.record_rejected(cmd_id, "cancelled by user")
            send_to_repociv({"type": "log",
                             "msg": f"Comando cancelado: {cmd_id}" if removed else f"Comando no encontrado: {cmd_id}",
                             "level": "warn" if removed else "info"})
            self._json({"ok": removed, "commandId": cmd_id})
            return

        if path.startswith("/tasks/") and path.endswith("/cancel"):
            # URL pattern: /tasks/<encoded_key>/cancel where key = "repo::ISSUE-id"
            # We support both /tasks/repo::ISSUE-1/cancel and /tasks/repo/ISSUE-1/cancel
            inner = path[len("/tasks/"):path.rfind("/cancel")]
            if "::" in inner:
                parts = inner.split("::", 1)
                task_repo, task_issue = parts[0], parts[1]
            else:
                # fallback: /tasks/<repo>/<issueId>/cancel (3 path segments)
                segments = [s for s in inner.split("/") if s]
                if len(segments) >= 2:
                    task_repo, task_issue = segments[0], segments[1]
                else:
                    self._err_json(400, "invalid task key")
                    return
            cancelled = _to.cancel_task(task_repo, task_issue)
            self._json({"ok": cancelled, "key": f"{task_repo}::{task_issue}"})
            return


        # ─── Approval endpoints ───────────────────────────────────────────────
        if path.startswith("/approvals/") and path.endswith("/approve"):
            cmd_id = path.split("/")[2]
            cmd_dict = _pop_approval(cmd_id)
            if not cmd_dict:
                self._json({"ok": False, "error": "approval not found"})
                return
            _es.record_approved(cmd_id)
            # Rebuild command and dispatch
            from server.command_schema import Command as _Cmd
            cmd = _Cmd(
                id=cmd_dict["id"],
                type=cmd_dict["type"],
                target=cmd_dict["target"],
                payload=cmd_dict.get("payload", {}),
                created_by=cmd_dict.get("created_by", "user"),
                risk=cmd_dict.get("risk", "medium"),
                requires_approval=False,
                status="queued",
            )
            _es.record_queued(cmd.id)
            _sched.enqueue(cmd)
            send_to_repociv({"type": "log", "msg": f"Comando aprobado: {cmd.type}", "level": "success"})
            self._json({"ok": True, "status": "queued", "commandId": cmd_id})
            return

        if path.startswith("/approvals/") and path.endswith("/reject"):
            cmd_id = path.split("/")[2]
            cmd_dict = _pop_approval(cmd_id)
            if not cmd_dict:
                self._json({"ok": False, "error": "approval not found"})
                return
            _es.record_rejected(cmd_id, "user rejected")
            send_to_repociv({"type": "log", "msg": f"Comando rechazado: {cmd_dict.get('type')}", "level": "warn"})
            self._json({"ok": True, "status": "rejected", "commandId": cmd_id})
            return

        # ─── Legacy root POST (unit_command / quest_add / fatigue) ───────────
        t = body.get("type")

        if t == "unit_command":
            cmd_data = {
                "type": "unit_command",
                "target": body.get("city", "main"),
                "payload": {
                    "unit": body.get("unit", "MAIN"),
                    "city": body.get("city", "main"),
                    "mission": body.get("mission", ""),
                    "agentType": body.get("agentType", "hero"),
                    # 3-layer config from chat UI
                    "harness": body.get("harness", ""),
                    "provider": body.get("provider", ""),
                    "model": body.get("model", ""),
                },
                "created_by": "user",
            }
            try:
                cmd = validate_command(cmd_data)
                _handle_command(cmd)
            except CommandValidationError as e:
                self._json({"ok": False, "error": str(e)})
                return
            self._json({"ok": True})
            return

        if t == "tile_inspected":
            city_name = body.get("cityName", "")
            send_to_repociv({"type": "log", "msg": f"Inspeccionando: {city_name}", "level": "info"})
            self._json({"ok": True})
            return

        if t == "quest_add":
            cmd_data = {
                "type": "quest_add",
                "target": body.get("title", "Sin título"),
                "payload": {"title": body.get("title", "Sin título"), "description": body.get("description", "")},
                "created_by": "user",
            }
            try:
                cmd = validate_command(cmd_data)
                _handle_command(cmd)
            except CommandValidationError as e:
                self._json({"ok": False, "error": str(e)})
                return
            self._json({"ok": True})
            return

        # ─── Fatigue commands (Phase 9) ───────────────────────────────────────
        if t == "unit_fatigue_delta":
            unit_id = body.get("unit", "")
            delta = int(body.get("delta", 0))
            entry = update_unit_fatigue(unit_id, delta=delta)
            send_to_repociv({"type": "unit_fatigue_update", "unit": unit_id,
                             "fatigue": entry["fatigue"], "maxFatigue": 100,
                             "atRest": entry["isResting"], "restAreaId": entry["restAreaId"]})
            self._json({"ok": True})
            return

        if t == "discover_rest_area":
            ra_id = body.get("restAreaId", f"ra-{uuid.uuid4().hex[:6]}")
            area = discover_rest_area(ra_id, body.get("roomId", ""), tuple(body.get("coord", [0, 0])))
            send_to_repociv({"type": "rest_area_discovered", "restArea": area})
            self._json({"ok": True})
            return

        # ─── Recovery command ─────────────────────────────────────────────────────
        # POST /harnesses/<id>/recovery-command
        if path.startswith("/harnesses/") and path.endswith("/recovery-command"):
            parts = path.split("/")
            if len(parts) >= 3:
                harness_id = parts[2]
                harness = _hr.get_harness(harness_id)
                if harness is None:
                    self._err_json(404, f"Harness '{harness_id}' not found")
                    return
                reason = body.get("reason", "unknown")
                failure_context = {
                    "reason": reason,
                    "command_type": body.get("command_type", ""),
                    "target": body.get("target", ""),
                    "details": body.get("details", ""),
                }
                plan = _recovery.build_recovery_plan(harness, failure_context)
                # Emit audit event
                _es.record_event("HarnessRecoveryRequested", {
                    "harness_id": harness_id,
                    "reason": reason,
                    "mode": plan.get("mode", ""),
                })
                self._json(plan)
                return

        if t == "enter_rest_area":
            unit_id = body.get("unit", "")
            ra_id = body.get("restAreaId", "")
            ok = enter_rest_area(unit_id, ra_id)
            if ok:
                send_to_repociv({"type": "rest_area_entered", "unit": unit_id, "restAreaId": ra_id})
            else:
                send_to_repociv({"type": "log", "msg": f"Rest area {ra_id} llena o no existe", "level": "warn"})
            self._json({"ok": ok})
            return

        if t == "exit_rest_area":
            unit_id = body.get("unit", "")
            exit_rest_area(unit_id)
            send_to_repociv({"type": "rest_area_exited", "unit": unit_id, "restAreaId": ""})
            self._json({"ok": True})
            return


        self._json({"ok": True, "ignored": t})

    def _sse_stream(self) -> None:
        client: queue.Queue[dict[str, Any] | None] = queue.Queue()
        _register_sse_client(client)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self._cors()
        self.end_headers()
        self.wfile.write(b'data: {"type":"ping"}\n\n')
        self.wfile.flush()
        try:
            while True:
                try:
                    event = client.get(timeout=15)
                except queue.Empty:
                    event = {"type": "ping"}
                if event is None:
                    break
                payload = json.dumps(event).encode()
                self.wfile.write(b"data: " + payload + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass
        finally:
            _unregister_sse_client(client)

    def _json(self, data: Any, *, record_usage: bool = True) -> None:
        if record_usage:
            _endpoint_usage.record(self.command, self.path, 200)
        payload = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args) -> None:
        pass


# ─── Scheduler dispatcher registration ───────────────────────────────────────
def _scheduler_dispatch(cmd_dict: dict[str, Any]) -> None:
    """Called by scheduler worker for each dequeued command."""
    from server.command_schema import Command as _Cmd
    cmd = _Cmd(
        id=cmd_dict.get("id", ""),
        type=cmd_dict.get("type", ""),
        target=cmd_dict.get("target", ""),
        payload=cmd_dict.get("payload", {}),
        created_by=cmd_dict.get("created_by", "system"),
        risk=cmd_dict.get("risk", "low"),
        requires_approval=False,
        status="running",
    )
    unit_id = cmd.payload.get("unit", "MAIN")
    _sched.heartbeat(unit_id)
    _dispatch_command(cmd)
    _sched.heartbeat(unit_id)


# ─── Background scanner ───────────────────────────────────────────────────────
def background_scanner() -> None:
    time.sleep(3)
    scan_active_processes()
    detect_lexo()
    while True:
        time.sleep(60)
        scan_active_processes()
        time.sleep(30)
        detect_lexo()


# ─── Startup recovery ────────────────────────────────────────────────────────
def _recover_hung_commands() -> int:
    """Mark commands stuck in 'running' state as failed on bridge restart."""
    events = _es.read_events(since=0, limit=10_000)
    started: set[str] = set()
    terminal: set[str] = set()
    for ev in events:
        etype = ev.get("type", "")
        cid = _es.command_id(ev)
        if not cid:
            continue
        if etype == "CommandStarted":
            started.add(cid)
        elif etype in ("CommandCompleted", "CommandFailed", "CommandRejected"):
            terminal.add(cid)
    hung = started - terminal
    for cid in hung:
        _es.record_failed(cid, "recovered: bridge restarted mientras el comando estaba en ejecución")
    return len(hung)


def _seed_initial_heartbeats() -> None:
    """Soft heartbeat for known agents at bridge boot — avoids eternal never_seen."""
    from server import agent_runner as _ar  # noqa: PLC0415

    seen: set[str] = {"MAIN"}
    seen.update(_ar.AGENT_CONFIGS.keys())
    sessions_dir = CONFIG_DIR / "sessions"
    if sessions_dir.is_dir():
        for entry in sessions_dir.iterdir():
            if entry.is_dir():
                seen.add(entry.name.upper())
    for agent_id in sorted(seen):
        _sched.heartbeat(agent_id)


# ─── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    _sched.set_dispatcher(_scheduler_dispatch)
    # Wire fatigue state into scheduler priority scoring
    _sched.set_fatigue_provider(lambda unit_id: get_unit_fatigue(unit_id).get("fatigue"))
    _sched.start_worker()
    _seed_initial_heartbeats()

    # Wire P4 step executor → orchestrator (agent dispatch: SCOUT/WORKER/DAVI)
    from server.step_executor import dispatch_plan_step
    _to.set_step_executor(dispatch_plan_step)

    # Recover any commands that were running when the bridge last died
    recovered = _recover_hung_commands()

    # ─── WebSocket server (Phase 1: bidirectional transport) ───────────
    from server.websocket_handler import start_ws_server, broadcast as ws_broadcast
    from server.websocket_handler import set_command_callback as ws_set_command_callback
    from server.sse_server import set_ws_broadcast_hook

    # Wire WS broadcast into SSE fan-out so send_to_repociv() reaches WS clients
    set_ws_broadcast_hook(ws_broadcast)

    # Wire bridge command dispatch for incoming WS commands
    def _ws_command_handler(data: dict[str, Any]) -> None:
        """Handle incoming commands from WebSocket clients."""
        from server.command_schema import validate_command, CommandValidationError
        cmd_type = data.get("type", "")
        if cmd_type == "command":
            raw = data.get("data", {})
            # Normalize: the frontend sends flat fields (unit, city, mission, ...)
            # but validate_command expects { type, target, payload: {...} }.
            # Mirror the same normalization done in the legacy HTTP POST handler
            # at lines ~849-862 so WS and HTTP produce identical Command objects.
            raw_type = raw.get("type", "")
            if raw_type in ("unit_command", "execute_agent"):
                # Build Command-compatible structure
                cmd_data = {
                    "type": raw_type,
                    "target": raw.get("city", "main"),
                    "payload": {
                        "unit": raw.get("unit", "MAIN"),
                        "city": raw.get("city", "main"),
                        "mission": raw.get("mission", ""),
                        "agentType": raw.get("agentType", "hero"),
                        "harness": raw.get("harness", ""),
                        "provider": raw.get("provider", ""),
                        "model": raw.get("model", ""),
                        "repoPath": raw.get("repoPath", ""),
                        "filePath": raw.get("filePath", ""),
                        "fileName": raw.get("fileName", ""),
                        "cwd": raw.get("cwd", ""),
                    },
                    "created_by": "user",
                }
            else:
                cmd_data = raw  # passthrough for other types
            try:
                cmd = validate_command(cmd_data)
                _handle_command(cmd)
            except CommandValidationError as e:
                send_to_repociv({"type": "log",
                                 "msg": f"WS command rejected: {e}",
                                 "level": "warn"})
        elif cmd_type == "approval":
            cmd_id = data.get("id", "")
            approved = data.get("approved", True)
            # Delegate to existing approval logic via scheduler
            if approved:
                # Re-use the approval flow from do_POST
                from server.command_schema import Command as _Cmd
                cmd_dict = _pop_approval(cmd_id)
                if cmd_dict:
                    cmd = _Cmd(
                        id=cmd_dict["id"], type=cmd_dict["type"],
                        target=cmd_dict["target"], payload=cmd_dict.get("payload", {}),
                        created_by=cmd_dict.get("created_by", "user"),
                        risk=cmd_dict.get("risk", "medium"),
                        requires_approval=False, status="queued",
                    )
                    _es.record_approved(cmd.id)
                    _es.record_queued(cmd.id)
                    _sched.enqueue(cmd)
                    send_to_repociv({"type": "log", "msg": f"WS aprobado: {cmd.type}", "level": "success"})
            else:
                _pop_approval(cmd_id)
                _es.record_rejected(cmd_id, "user rejected (WS)")
                send_to_repociv({"type": "log", "msg": f"WS rechazado: {cmd_id}", "level": "warn"})

    ws_set_command_callback(_ws_command_handler)

    # Start WS server in a daemon thread — use BRIDGE_HOST for remote support
    ws_thread = start_ws_server(host=BRIDGE_HOST, port=BRIDGE_WS_PORT)

    server = ThreadingHTTPServer((BRIDGE_HOST, BRIDGE_PORT), BridgeHandler)
    threading.Thread(target=background_scanner, daemon=True).start()

    # Graceful shutdown on SIGTERM (systemd / dev-stop.sh)
    def _handle_sigterm(signum: int, frame: object) -> None:
        print("\nBridge: SIGTERM recibido — cerrando limpiamente.")
        # Shutdown HTTP immediately so systemd doesn't see a hung service
        threading.Thread(target=server.shutdown, daemon=True).start()
        # Persist learned directive templates with a hard timeout so a slow disk
        # or contested lock doesn't turn us into a zombie with an open socket.
        def _persist() -> None:
            try:
                records = _ds.read_records()
                saved = _dl.save_templates(records)
                if saved:
                    print(f"Bridge: {saved} directive templates persisted.")
            except Exception:
                pass
        persist_thread = threading.Thread(target=_persist, daemon=True)
        persist_thread.start()
        persist_thread.join(timeout=3.0)
    signal.signal(signal.SIGTERM, _handle_sigterm)

    has_gpu = get_gpu_info() is not None
    auth_status = "ON" if REPOCIV_TOKEN else "OFF (dev)"
    mode_str = "REMOTE" if REPOCIV_REMOTE else "LOCAL"
    bind_url = f"http://{BRIDGE_HOST}:{BRIDGE_PORT}"
    ws_url = f"ws://{BRIDGE_HOST}:{BRIDGE_WS_PORT}"
    print(f"╭─ RepoCiv Bridge [{mode_str}] ───────────────────────╮")
    print(f"│ HTTP:      {bind_url:<38}│")
    print(f"│ WebSocket: {ws_url:<38}│")
    print(f"│ Auth:      {auth_status:<40}│")
    print(f"│ CORS:      {'0.0.0.0/0 (remote)' if REPOCIV_REMOTE else 'localhost only':<40}│")
    print(f"│ Events:    {_es._store_path}  │")
    print(f"│ Missions:  {MISSIONS_FILE}    │")
    print("│ default:   hermes (luego claude-code, openclaw)                        │")
    print(f"│ openclaw:  {'OK' if _has_openclaw() else 'NO'}                                      │")
    print(f"│ claude-code: {'OK' if _has_claude_code() else 'NO'}                              │")
    print(f"│ cursor:    {'OK' if _has_cursor() else 'NO'}                                    │")
    print(f"│ codex:     {'OK' if _has_codex() else 'NO'}                                    │")
    print(f"│ GPU:       {'OK (nvidia-smi)' if has_gpu else 'no disponible'}                    │")
    if recovered:
        print(f"│ Recuperados: {recovered} comando(s) colgado(s)              │")
    print("╰───────────────────────────────────────────────────╯")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBridge detenido.")
