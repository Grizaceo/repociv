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
  GET  /techdebt                  — tech-debt scan across repos
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

import json
import os
import queue
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


# ─── .env loader ─────────────────────────────────────────────────────────────
def _load_dotenv() -> None:
    env_path = Path(__file__).parent.parent / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()

REPOCIV_PORT = int(os.environ.get("REPOCIV_PORT", "5273"))
BRIDGE_PORT  = int(os.environ.get("BRIDGE_PORT", "5274"))
REPOCIV_TOKEN = os.environ.get("REPOCIV_TOKEN", "")  # empty = auth disabled (dev only)

CONFIG_DIR = Path(os.path.expanduser(os.environ.get("REPOCIV_CONFIG_DIR", "~/.repociv")))
CONFIG_DIR.mkdir(exist_ok=True, parents=True)
MISSIONS_FILE    = CONFIG_DIR / "missions.json"
HERMES_ROOT      = Path(os.path.expanduser(os.environ.get("HERMES_ROOT", "~/.hermes")))
PENDING_TRACKER  = HERMES_ROOT / "workspace" / "PENDING_TRACKER.md"

# ─── CORS allowed origins ─────────────────────────────────────────────────────
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


# ─── Event store init ─────────────────────────────────────────────────────────
from server import event_store as _es
from server import sessions as _sessions
from server import run_state as _run_state
from server import workspace_issue as _wi
from server import checkpoint as _checkpoint
_es.init(CONFIG_DIR)
_sessions.init(CONFIG_DIR)
_run_state.init(CONFIG_DIR)
_wi.init(CONFIG_DIR)
_checkpoint.init(CONFIG_DIR)

# ─── Command schema + policy ──────────────────────────────────────────────────
from server.command_schema import validate_command, CommandValidationError, Command
from server import policy as _policy
from server.capabilities import capabilities_snapshot
from server.context_pack import build_context_pack
from server.metrics import compute_metrics
from server import directive_store as _ds
from server import directive_learner as _dl
from server import harness_registry as _hr
from server import recovery as _recovery
from server import runtime_adapters as _runtime_adapters
from server.quest import generate_quest_name
from server.tech_debt import scan_tech_debt
from server import agent_runner as _agent_runner
from server import task_orchestrator as _to
from server import rate_limiter as _rl
_ds.init(CONFIG_DIR)
_dl.set_templates_path(CONFIG_DIR / "directive_templates.json")

# ─── Per-agent-type rate limiter ──────────────────────────────────────────────
_agent_rate_limiter = _rl.RateLimiter()

# ─── Scheduler ────────────────────────────────────────────────────────────────
from server import scheduler as _sched


# ─── Mission persistence ──────────────────────────────────────────────────────
_missions_lock = threading.Lock()


def load_missions() -> list[dict[str, Any]]:
    if not MISSIONS_FILE.exists():
        return []
    try:
        return json.loads(MISSIONS_FILE.read_text())
    except Exception:
        return []


def save_mission(mission: dict[str, Any]) -> None:
    with _missions_lock:
        missions = load_missions()
        for i, m in enumerate(missions):
            if m.get("id") == mission.get("id"):
                missions[i] = mission
                break
        else:
            missions.append(mission)
        missions = missions[-200:]
        MISSIONS_FILE.write_text(json.dumps(missions, indent=2, ensure_ascii=False))


# ─── XCOM Context Fatigue state ───────────────────────────────────────────────
_fatigue_state: dict[str, dict[str, Any]] = {}
_rest_areas: dict[str, dict[str, Any]] = {}
_fatigue_lock = threading.Lock()


def get_unit_fatigue(unit_id: str) -> dict[str, Any]:
    with _fatigue_lock:
        return _fatigue_state.get(unit_id, {
            "fatigue": 100, "effectiveSpeed": 1.0, "isResting": False, "restAreaId": None,
        })


def update_unit_fatigue(unit_id: str, *, fatigue: int | None = None,
                        effective_speed: float | None = None,
                        is_resting: bool | None = None,
                        rest_area_id: str | None = None,
                        delta: int = 0) -> dict[str, Any]:
    with _fatigue_lock:
        entry = _fatigue_state.setdefault(unit_id, {
            "fatigue": 100, "effectiveSpeed": 1.0, "isResting": False, "restAreaId": None,
        })
        if fatigue is not None:
            entry["fatigue"] = max(0, min(100, fatigue))
        elif delta:
            entry["fatigue"] = max(0, min(100, entry["fatigue"] + delta))
        if effective_speed is not None:
            entry["effectiveSpeed"] = effective_speed
        if is_resting is not None:
            entry["isResting"] = is_resting
        if rest_area_id is not None:
            entry["restAreaId"] = rest_area_id
        entry["effectiveSpeed"] = round(entry["fatigue"] / 100.0, 3)
        return dict(entry)


def discover_rest_area(rest_area_id: str, room_id: str, coord: tuple,
                       recovery_rate: float = 8.0, capacity: int = 4) -> dict[str, Any]:
    with _fatigue_lock:
        area = {
            "id": rest_area_id, "roomId": room_id, "coord": list(coord),
            "recoveryRate": recovery_rate, "capacity": capacity, "unitsInside": [],
        }
        _rest_areas[rest_area_id] = area
        return dict(area)


def enter_rest_area(unit_id: str, rest_area_id: str) -> bool:
    with _fatigue_lock:
        area = _rest_areas.get(rest_area_id)
        if not area or len(area["unitsInside"]) >= area["capacity"]:
            return False
        if unit_id not in area["unitsInside"]:
            area["unitsInside"].append(unit_id)
        entry = _fatigue_state.setdefault(unit_id, {"fatigue": 100, "effectiveSpeed": 1.0, "isResting": False, "restAreaId": None})
        entry["isResting"] = True
        entry["restAreaId"] = rest_area_id
        return True


def exit_rest_area(unit_id: str) -> None:
    with _fatigue_lock:
        entry = _fatigue_state.get(unit_id, {})
        ra_id = entry.get("restAreaId")
        if ra_id and ra_id in _rest_areas:
            try:
                _rest_areas[ra_id]["unitsInside"].remove(unit_id)
            except ValueError:
                pass
        entry["isResting"] = False
        entry["restAreaId"] = None
        _fatigue_state[unit_id] = entry


# ─── Event sender → RepoCiv frontend ─────────────────────────────────────────
_sse_lock = threading.Lock()
_sse_clients: list[queue.Queue[dict[str, Any] | None]] = []


def _fanout_sse(event: dict[str, Any]) -> None:
    with _sse_lock:
        clients = list(_sse_clients)
    for client in clients:
        try:
            client.put_nowait(event)
        except Exception:
            pass


def _register_sse_client(client: queue.Queue[dict[str, Any] | None]) -> None:
    with _sse_lock:
        _sse_clients.append(client)


def _unregister_sse_client(client: queue.Queue[dict[str, Any] | None]) -> None:
    with _sse_lock:
        try:
            _sse_clients.remove(client)
        except ValueError:
            pass


def send_to_repociv(event: dict[str, Any]) -> None:
    event_type = str(event.get("type", ""))
    unit = str(event.get("unit", ""))
    mission_id = str(event.get("missionId", ""))
    if event_type == "chat_chunk" and unit and mission_id:
        try:
            _sessions.append_message(unit, "assistant", str(event.get("text", "")), {"missionId": mission_id})
        except Exception:
            pass
    _fanout_sse(event)
    try:
        data = json.dumps(event).encode()
        req = urllib.request.Request(
            f"http://localhost:{REPOCIV_PORT}/event", data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass


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


# ─── PENDING_TRACKER ──────────────────────────────────────────────────────────
def load_pending_tasks() -> list[dict[str, str]]:
    if not PENDING_TRACKER.exists():
        return []
    try:
        tasks = []
        for line in PENDING_TRACKER.read_text(encoding="utf-8").splitlines():
            # Soporta - [ ], * [ ], + [ ]; excluye [x] y [X] (completadas)
            m = re.match(r"^\s*[-*+]\s*\[\s*\]\s*(.+)", line)
            if m:
                title = m.group(1).strip()
                priority = "high" if title.startswith("!") or "[HIGH]" in title else "normal"
                tasks.append({"title": title.lstrip("!").strip(), "priority": priority})
        return tasks
    except Exception:
        return []


def append_pending_task(title: str, description: str = "") -> None:
    try:
        existing = PENDING_TRACKER.read_text(encoding="utf-8") if PENDING_TRACKER.exists() else ""
        # Guard: no duplicar si el título ya existe como tarea pendiente
        if re.search(re.escape(title), existing):
            return
        entry = f"\n- [ ] {title}"
        if description:
            entry += f"\n  {description}"
        PENDING_TRACKER.write_text(existing.rstrip() + entry + "\n", encoding="utf-8")
    except Exception as e:
        print(f"[bridge] No pude escribir PENDING_TRACKER: {e}")


# ─── Process scanner ──────────────────────────────────────────────────────────
PROCESS_KEYWORDS = ["python train", "python3 train", "cargo run", "cargo build",
                    "npm run", "vite", "pytest", "uvicorn", "flask run"]
_last_scan_pids: set[int] = set()


def scan_active_processes() -> None:
    global _last_scan_pids
    try:
        result = subprocess.run(["ps", "aux"], capture_output=True, text=True, timeout=5)
        current_pids: set[int] = set()
        for line in result.stdout.strip().splitlines()[1:]:
            parts = line.split(None, 10)
            if len(parts) < 11:
                continue
            try:
                pid = int(parts[1])
            except ValueError:
                continue
            cmd = parts[10].lower()
            if any(kw in cmd for kw in PROCESS_KEYWORDS):
                current_pids.add(pid)
                if pid not in _last_scan_pids:
                    cmd_clean = parts[10][:80]
                    send_to_repociv({"type": "building_start", "city": "main", "building": cmd_clean,
                                     "durationSeconds": 300, "pid": pid, "cmd": cmd_clean})
                    send_to_repociv({"type": "log", "msg": f"Proceso detectado: {cmd_clean[:50]}", "level": "info"})
        _last_scan_pids = current_pids
    except Exception:
        pass


# ─── LexO-Alpha detection ─────────────────────────────────────────────────────
_lexo_spawned: set[str] = set()


def detect_lexo() -> None:
    try:
        result = subprocess.run(["ps", "aux"], capture_output=True, text=True, timeout=5)
        for line in result.stdout.strip().splitlines()[1:]:
            parts = line.split(None, 10)
            if len(parts) < 11:
                continue
            try:
                pid = int(parts[1])
            except ValueError:
                continue
            cmd = parts[10].lower()
            if re.search(r"lexo|hermes.*lexo|lexo.*hermes", cmd):
                pid_key = str(pid)
                if pid_key not in _lexo_spawned:
                    _lexo_spawned.add(pid_key)
                    # UUID corto: único entre sesiones (no colisiona tras restart)
                    unit_id = f"LEXO-{uuid.uuid4().hex[:8]}"
                    # Distribuir hexes usando hash del PID para evitar colisiones visuales
                    hex_q = 2 + (pid % 3)
                    hex_r = pid % 5
                    send_to_repociv({"type": "unit_spawn", "unit": unit_id, "civ": "gris",
                                     "hex": [hex_q, hex_r], "unitType": "lexo",
                                     "mission": f"Proceso: {parts[10][:40]}"})
                    send_to_repociv({"type": "log", "msg": f"LexO-α detectado (pid {pid})", "level": "success"})
    except Exception:
        pass


# ─── Agent runner facade ──────────────────────────────────────────────────────
def _configure_agent_runner() -> None:
    _agent_runner.configure(send=send_to_repociv, save=save_mission)


def run_agent(unit_id: str, city_id: str, mission: str, agent_type: str = "hero",
              command_id: str | None = None) -> None:
    _configure_agent_runner()
    return _agent_runner.run_agent(unit_id, city_id, mission, agent_type, command_id)


def _execute_streaming(unit_id: str, mission_id: str, mission: str,
                       working_dir: str | None = None) -> tuple[bool, str]:
    _configure_agent_runner()
    return _agent_runner._execute_streaming(unit_id, mission_id, mission, working_dir)


def _has_openclaw() -> bool:
    return _agent_runner._has_openclaw()


def _find_openclaw() -> str | None:
    return _agent_runner._find_openclaw()


def _has_claude_code() -> bool:
    return _agent_runner._has_claude_code()


def _has_cursor() -> bool:
    return _agent_runner._has_cursor()


def _run_openclaw_streaming(unit_id: str, mission_id: str, mission: str,
                             config: dict[str, Any],
                             working_dir: str | None = None) -> tuple[bool, str]:
    _configure_agent_runner()
    return _agent_runner._run_openclaw_streaming(unit_id, mission_id, mission, config, working_dir)


def _run_hermes_streaming(unit_id: str, mission_id: str, mission: str,
                           config: dict[str, Any] | None = None,
                           working_dir: str | None = None) -> tuple[bool, str]:
    _configure_agent_runner()
    return _agent_runner._run_hermes_streaming(unit_id, mission_id, mission, config, working_dir)


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
    agent_id = str(cmd.payload.get("unit", "DAVI"))
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
    """Human-readable fallback mission for command types without explicit text."""
    labels = {
        "inspect_repo":  f"Inspeccionar repo {cmd.target} y reportar hallazgos accionables.",
        "read_file":     f"Leer {cmd.target} y resumir contenido relevante.",
        "run_tests":     f"Ejecutar tests en {cmd.target}, diagnosticar fallos y proponer corrección.",
        "run_build":     f"Ejecutar build en {cmd.target}, diagnosticar fallos y proponer corrección.",
        "edit_file":     f"Editar/proponer cambios en {cmd.target} según la instrucción del usuario.",
        "create_branch": f"Crear/preparar rama de trabajo para {cmd.target}.",
        "git_commit":    f"Preparar commit limpio para {cmd.target}, con resumen verificable.",
        "delete_file":   f"Eliminar {cmd.target} solo si la aprobación explícita lo autoriza y reportar impacto.",
        "send_message":  f"Preparar/enviar mensaje relacionado con {cmd.target} según política aprobada.",
        "execute_agent": f"Ejecutar misión agente sobre {cmd.target}.",
        "unit_command":  f"Ejecutar misión de unidad sobre {cmd.target}.",
    }
    return labels.get(cmd.type, f"Ejecutar comando {cmd.type} sobre {cmd.target}.")


def _register_issue_run(payload: dict[str, Any], run_id: str) -> None:
    """If payload carries issue/repo context, register the run in the issue workspace."""
    issue_id = str(payload.get("issueId") or payload.get("issue_id") or "")
    repo = str(payload.get("repo") or payload.get("target") or "")
    if not issue_id or not repo:
        return
    try:
        _wi.register_run(repo, issue_id, run_id)
    except Exception:
        pass  # non-critical — don't block command dispatch


def _dispatch_command(cmd: Command) -> None:
    """Run a queued command synchronously inside the scheduler worker thread.

    Earlier code spawned another thread for agent commands and returned
    immediately, causing the scheduler lease to be released while the agent was
    still running. That made concurrency limits decorative. This function now
    blocks until the command reaches a terminal event.
    """
    payload = cmd.payload

    agent_command_types = {
        "unit_command", "execute_agent", "inspect_repo", "read_file",
        "run_tests", "run_build", "edit_file", "create_branch",
        "git_commit", "delete_file", "send_message",
    }

    if cmd.type in agent_command_types:
        unit = str(payload.get("unit", "DAVI"))
        city = str(payload.get("city", cmd.target or "main"))
        mission = str(payload.get("mission") or _default_mission_for_command(cmd))
        agent_type = str(payload.get("agentType", "hero"))
        run_agent(unit, city, mission, agent_type, cmd.id)
        _register_issue_run(payload, cmd.id)
        return

    if cmd.type == "e2e_probe":
        unit = str(payload.get("unit", "DAVI"))
        marker = str(payload.get("marker", cmd.id))[:120]
        quest_name = f"E2E probe: {marker}"
        text = f"E2E probe completado: {marker}"
        adapter = _runtime_adapters.infer_adapter_for_command("e2e_probe", cmd.harness_id)
        runtime_id = adapter.harness_id if adapter else "local-cli"
        _sessions.patch(unit, runtimeId=runtime_id, repo=str(cmd.target or "main"), summary=quest_name, lastMissionId=cmd.id)
        _sessions.append_message(unit, "user", marker, {"missionId": cmd.id, "kind": "e2e_probe"})
        _run_state.save(cmd.id, {
            "unitId": unit,
            "runtimeId": runtime_id,
            "repo": str(cmd.target or "main"),
            "commandType": "e2e_probe",
            "phase": "completed",
            "status": "completed",
            "retries": 0,
            "checkpointApproved": [],
            "filesTouched": [],
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "result": text,
        })
        send_to_repociv({"type": "mission_start", "missionId": cmd.id, "unit": unit, "questName": quest_name})
        send_to_repociv({"type": "chat_chunk", "unit": unit, "text": text, "missionId": cmd.id})
        _es.record_output_chunk(cmd.id, unit, text)
        _es.record_completed(cmd.id, text)
        send_to_repociv({"type": "mission_complete", "missionId": cmd.id, "unit": unit, "success": True, "duration": 0})
        send_to_repociv({"type": "log", "msg": text, "level": "success"})
        _register_issue_run(payload, cmd.id)
        return

    if cmd.type == "quest_add":
        title = str(payload.get("title", cmd.target))
        description = str(payload.get("description", ""))
        append_pending_task(title, description)
        mission_rec: dict[str, Any] = {
            "id": cmd.id, "unit": "DAVI", "city": "main", "mission": title,
            "questName": title, "agentType": "hero", "startedAt": time.time(),
            "completedAt": time.time(), "status": "complete", "summary": description,
            "lines": 0, "duration": 0,
        }
        save_mission(mission_rec)
        adapter = _runtime_adapters.infer_adapter_for_command("quest_add", cmd.harness_id)
        runtime_id = adapter.harness_id if adapter else "local-cli"
        _sessions.patch("DAVI", runtimeId=runtime_id, repo="main", summary=title, lastMissionId=cmd.id)
        _sessions.append_message("DAVI", "user", title, {"missionId": cmd.id, "kind": "quest_add"})
        if description:
            _sessions.append_message("DAVI", "assistant", description, {"missionId": cmd.id, "kind": "quest_add_summary"})
        _run_state.save(cmd.id, {
            "unitId": "DAVI",
            "runtimeId": runtime_id,
            "repo": "main",
            "commandType": "quest_add",
            "phase": "completed",
            "status": "completed",
            "retries": 0,
            "checkpointApproved": [],
            "filesTouched": [],
            "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "result": description,
        })
        send_to_repociv({"type": "mission_start", "missionId": cmd.id, "unit": "DAVI", "questName": title})
        send_to_repociv({"type": "mission_complete", "missionId": cmd.id, "unit": "DAVI", "success": True, "duration": 0})
        send_to_repociv({"type": "log", "msg": f"Quest agregado: {title}", "level": "success"})
        _es.record_completed(cmd.id, "quest added")
        _ds.record_outcome(cmd.id, "success", 0.0)
        return

    if cmd.type == "tile_inspected":
        city_name = str(payload.get("cityName", cmd.target))
        send_to_repociv({"type": "log", "msg": f"Inspeccionando: {city_name}", "level": "info"})
        _es.record_completed(cmd.id, "tile inspected")
        _ds.record_outcome(cmd.id, "success", 0.0)
        return

    # ─── Task orchestrator (P3) ────────────────────────────────────────────
    if cmd.type == "task_run":
        repo = str(payload.get("repo", cmd.target))
        issue_id = str(payload.get("issueId") or payload.get("issue_id") or "")
        if not issue_id:
            _es.record_failed(cmd.id, "task_run requires issueId in payload")
            return
        _es.record_started(cmd.id)
        try:
            result = _to.run_task(repo, issue_id)
            _es.record_completed(cmd.id, json.dumps({"phase": result.get("phase"), "repo": repo, "issueId": issue_id}))
            send_to_repociv({
                "type": "task_complete", "repo": repo, "issueId": issue_id,
                "phase": result.get("phase"), "missionId": cmd.id,
            })
        except Exception as e:
            _es.record_failed(cmd.id, str(e))
            send_to_repociv({
                "type": "task_failed", "repo": repo, "issueId": issue_id,
                "error": str(e), "missionId": cmd.id,
            })
        return

    send_to_repociv({"type": "log", "msg": f"Comando {cmd.type} sin executor — sin ejecución real", "level": "warn"})
    _es.record_failed(cmd.id, f"no executor for {cmd.type}")
    _ds.record_outcome(cmd.id, "failure", 0.0)
    send_to_repociv({
        "type": "mission_complete",
        "missionId": cmd.id,
        "unit": str(cmd.payload.get("unit", "DAVI")),
        "success": False,
        "duration": 0,
        "error": f"Sin executor para tipo '{cmd.type}' — no se ejecutó ninguna acción real",
    })


# ─── HTTP Handler ─────────────────────────────────────────────────────────────
class BridgeHandler(BaseHTTPRequestHandler):

    def _origin(self) -> str:
        return self.headers.get("Origin", "")

    def _cors(self) -> None:
        origin = self._origin()
        if origin in _ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        else:
            # Dev fallback: allow any localhost origin (non-browser clients / curl)
            self.send_header("Access-Control-Allow-Origin", f"http://localhost:{REPOCIV_PORT}")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-RepoCiv-Token")
        self.send_header("Vary", "Origin")

    def _check_token(self) -> bool:
        """Return True if the request carries a valid token (or token is not configured)."""
        if not REPOCIV_TOKEN:
            return True  # auth disabled in dev
        return self.headers.get("X-RepoCiv-Token", "") == REPOCIV_TOKEN

    def _client_ip(self) -> str:
        return self.client_address[0] if self.client_address else "unknown"

    def _rate_limited(self) -> bool:
        return not _rate_check(self._client_ip())

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?")[0]

        if path == "/health":
            self._json({
                "ok": True,
                "openclaw": _has_openclaw(),
                "claudeCode": _has_claude_code(),
                "cursor": _has_cursor(),
            })
            return

        if path == "/ready":
            self._json({"ok": True, "eventStore": str(_es._store_path), "token": bool(REPOCIV_TOKEN)})
            return

        if path == "/missions":
            self._json(load_missions())
            return

        if path == "/gpu":
            self._json(get_gpu_info())
            return

        if path == "/pending":
            self._json(load_pending_tasks())
            return

        if path == "/techdebt":
            root = os.environ.get("REPOCIV_REPOS_ROOT",
                                  str(Path(__file__).parent.parent / "workspace" / "repos"))
            self._json(scan_tech_debt(root))
            return

        if path == "/context":
            self._json({"ok": True, "fatigue": _fatigue_state, "restAreas": _rest_areas})
            return

        if path == "/events":
            accept = self.headers.get("Accept", "")
            if "text/event-stream" in accept:
                self._sse_stream()
                return
            try:
                qs = self.path.split("?", 1)[1] if "?" in self.path else ""
                since = 0.0
                for part in qs.split("&"):
                    if part.startswith("since="):
                        since = float(part.split("=", 1)[1])
            except Exception:
                since = 0.0
            self._json(_es.read_events(since=since))
            return

        if path == "/approvals":
            self._json(_get_approvals())
            return

        if path == "/agents":
            self._json({
                "agents": _sched.get_agent_status(),
                "queueDepth": len(_sched.queue_snapshot()),
                "queue": _sched.queue_snapshot()[:20],
            })
            return

        if path == "/agents/capabilities":
            self._json(capabilities_snapshot())
            return

        if path == "/metrics":
            events = _es.read_events(since=0, limit=500)
            agent_status = _sched.get_agent_status()
            queue_depth = len(_sched.queue_snapshot())
            gpu = get_gpu_info()
            payload = compute_metrics(events, agent_status, queue_depth, gpu)
            # Inject circuit breaker count from task registry
            payload["circuitOpenCount"] = _to.count_circuit_open()
            self._json(payload)
            return

        if path == "/directives/stats":
            records = _ds.read_records()
            self._json(_dl.stats_snapshot(records))
            return

        if path == "/directives/suggest":
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            params: dict[str, str] = {}
            for part in qs.split("&"):
                if "=" in part:
                    k, _, v = part.partition("=")
                    params[k] = v
            gesture  = params.get("gesture", "")
            agent_id = params.get("agent", "DAVI")
            records  = _ds.read_records()
            # Optional context for smarter scoring
            ctx: dict[str, Any] | None = None
            if params.get("repoType") or params.get("testStatus") or params.get("lastCmdType"):
                ctx = {}
                if params.get("repoType"):
                    ctx["repoType"] = params["repoType"]
                if params.get("testStatus"):
                    ctx["testStatus"] = params["testStatus"]
                if params.get("lastCmdType"):
                    ctx["lastCmdType"] = params["lastCmdType"]
            self._json(_dl.suggest(gesture, agent_id, records, current_context=ctx))
            return

        # ─── Harness registry ────────────────────────────────────────────────────
        # GET /harnesses           — list all harnesses
        if path == "/harnesses":
            self._json(_hr.list_harnesses())
            return

        # GET /harnesses/<id>     — single harness detail
        if path.startswith("/harnesses/"):
            harness_id = path.split("/", 2)[2]
            harness = _hr.get_harness(harness_id)
            if harness is None:
                self.send_response(404)
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({"error": f"Harness '{harness_id}' not found"}).encode())
                return
            self._json(harness)
            return

        # GET /log — last N events from the event store (D3 live log panel)
        if path == "/log":
            try:
                qs = self.path.split("?", 1)[1] if "?" in self.path else ""
                params: dict[str, str] = {}
                for part in qs.split("&"):
                    if "=" in part:
                        k, _, v = part.partition("=")
                        params[k] = v
                n = min(max(1, int(params.get("n", "100"))), 500)
                event_type_filter = params.get("type", "")
            except Exception:
                n = 100
                event_type_filter = ""
            events = _es.read_events(since=0, limit=500)
            if event_type_filter:
                events = [e for e in events if e.get("type") == event_type_filter]
            self._json(events[-n:])
            return

        # GET /tasks — list all tasks from orchestrator registry (C3)
        if path == "/tasks":
            self._json(_to.list_tasks())
            return

        # ─── SICA self-improvement (Fase 5, opt-in) ──────────────────────────
        # Read-only inspection: surface patterns and proposals so the user
        # (alpha tester) can decide if any are worth acting on. No changes
        # are ever applied through GET.
        if path == "/improve/reflect":
            try:
                from server.self_improve import SelfImprovementEngine
                engine = SelfImprovementEngine()
                patterns = engine.reflect()
                self._json({
                    "patterns": [
                        {
                            "kind": p.kind,
                            "summary": p.summary,
                            "evidence": p.evidence,
                            "confidence": p.confidence,
                        }
                        for p in patterns
                    ]
                })
            except Exception as exc:
                self.send_response(500)
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(exc)}).encode())
            return

        if path == "/improve/proposals":
            try:
                from server.self_improve import SelfImprovementEngine
                engine = SelfImprovementEngine()
                proposals = []
                for pattern in engine.reflect():
                    try:
                        improvement = engine.propose_improvement(pattern)
                    except Exception:
                        continue
                    proposals.append({
                        "id": improvement.id,
                        "targetType": improvement.target_type,
                        "filePath": improvement.file_path,
                        "description": improvement.description,
                        "rationale": improvement.rationale,
                        "payload": improvement.payload,
                    })
                self._json({"proposals": proposals})
            except Exception as exc:
                self.send_response(500)
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(exc)}).encode())
            return

        # GET /tasks/<repo>/<issueId> — task orchestrator status (P3)
        if path.startswith("/tasks/"):
            parts = path.split("/")[2:]
            if len(parts) >= 3 and parts[2] == "circuit-status":
                repo, issue_id = parts[0], parts[1]
                self._json(_to.get_circuit_status(repo, issue_id))
                return
            if len(parts) >= 2:
                repo, issue_id = parts[0], parts[1]
                status = _to.get_task_status(repo, issue_id)
                self._json(status)
                return

        self.send_response(404)
        self._cors()
        self.end_headers()

    def do_POST(self) -> None:
        # Rate limit check (before reading body)
        if self._rate_limited():
            self.send_response(429)
            self._cors()
            self.end_headers()
            self.wfile.write(b'{"error":"rate limited"}')
            return

        # Token auth (POST always requires token if configured)
        if not self._check_token():
            self.send_response(401)
            self._cors()
            self.end_headers()
            self.wfile.write(b'{"error":"unauthorized"}')
            return

        # Body size guard
        length = int(self.headers.get("Content-Length", 0))
        if length > _MAX_BODY:
            self.send_response(413)
            self._cors()
            self.end_headers()
            self.wfile.write(b'{"error":"payload too large"}')
            return

        try:
            body = json.loads(self.rfile.read(length))
        except Exception:
            self.send_response(400)
            self._cors()
            self.end_headers()
            self.wfile.write(b'{"error":"invalid JSON"}')
            return

        path = self.path.split("?")[0]

        # ─── Cancel a queued command ──────────────────────────────────────────
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

        # ─── Cancel a task (C3) ───────────────────────────────────────────────
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
                    self.send_response(400)
                    self._cors()
                    self.end_headers()
                    self.wfile.write(b'{"error":"invalid task key"}')
                    return
            cancelled = _to.cancel_task(task_repo, task_issue)
            self._json({"ok": cancelled, "key": f"{task_repo}::{task_issue}"})
            return

        # ─── Directive gesture record (Fase 9) ───────────────────────────────────
        if path == "/directives/record":
            command_id = str(body.get("commandId", ""))
            gesture    = str(body.get("gesture",   ""))
            agent_id   = str(body.get("agentId",   "DAVI"))
            cmd_type   = str(body.get("cmdType",   ""))
            target     = str(body.get("target",    ""))
            # Optional context features for smarter learning
            ctx: dict[str, Any] = {}
            if body.get("repoType"):
                ctx["repoType"] = str(body["repoType"])
            if body.get("testStatus"):
                ctx["testStatus"] = str(body["testStatus"])
            if body.get("lastCmdType"):
                ctx["lastCmdType"] = str(body["lastCmdType"])
            if body.get("gameTick") is not None:
                ctx["gameTick"] = int(body["gameTick"])
            if command_id and gesture and cmd_type:
                _ds.record_gesture(command_id, gesture, agent_id, cmd_type, target,
                                   ctx if ctx else None)
            self._json({"ok": True})
            return

        # ─── Command Bus ─────────────────────────────────────────────────────
        if path == "/commands":
            try:
                cmd = validate_command(body)
            except CommandValidationError as e:
                self.send_response(400)
                self._cors()
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
                return
            # Per-agent-type rate limit
            _agent_type = str(
                cmd.payload.get("unit") or body.get("agentType") or "DAVI"
            )
            if not _agent_rate_limiter.check_and_consume(_agent_type):
                self.send_response(429)
                self._cors()
                self.end_headers()
                self.wfile.write(
                    json.dumps({"error": "rate_limit", "agent": _agent_type}).encode()
                )
                return
            result = _handle_command(cmd)
            self._json(result)
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
                    "unit": body.get("unit", "DAVI"),
                    "city": body.get("city", "main"),
                    "mission": body.get("mission", ""),
                    "agentType": body.get("agentType", "hero"),
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
                    self.send_response(404)
                    self._cors()
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": f"Harness '{harness_id}' not found"}).encode())
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

    def _json(self, data: Any) -> None:
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
    unit_id = cmd.payload.get("unit", "DAVI")
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


# ─── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    _sched.set_dispatcher(_scheduler_dispatch)
    # Wire fatigue state into scheduler priority scoring
    _sched.set_fatigue_provider(lambda unit_id: get_unit_fatigue(unit_id).get("fatigue"))
    _sched.start_worker()

    # Wire P4 step executor → orchestrator (agent dispatch: SCOUT/WORKER/DAVI)
    from server.step_executor import dispatch_plan_step
    _to.set_step_executor(dispatch_plan_step)

    # Recover any commands that were running when the bridge last died
    recovered = _recover_hung_commands()

    server = ThreadingHTTPServer(("localhost", BRIDGE_PORT), BridgeHandler)
    threading.Thread(target=background_scanner, daemon=True).start()

    # Graceful shutdown on SIGTERM (systemd / dev-stop.sh)
    def _handle_sigterm(signum: int, frame: object) -> None:
        print("\nBridge: SIGTERM recibido — cerrando limpiamente.")
        # Persist learned directive templates before exit
        try:
            records = _ds.read_records()
            saved = _dl.save_templates(records)
            if saved:
                print(f"Bridge: {saved} directive templates persisted.")
        except Exception:
            pass
        server.shutdown()
    signal.signal(signal.SIGTERM, _handle_sigterm)

    has_gpu = get_gpu_info() is not None
    auth_status = "ON" if REPOCIV_TOKEN else "OFF (dev)"
    print(f"╭─ RepoCiv Bridge ──────────────────────────────────╮")
    print(f"│ Endpoint:  http://localhost:{BRIDGE_PORT}                  │")
    print(f"│ Auth:      {auth_status:<40}│")
    print(f"│ CORS:      localhost:{REPOCIV_PORT} only                  │")
    print(f"│ Events:    {_es._store_path}  │")
    print(f"│ Missions:  {MISSIONS_FILE}    │")
    print(f"│ openclaw:  {'OK' if _has_openclaw() else 'NO (usará Hermes API)'}                          │")
    print(f"│ claude-code: {'OK' if _has_claude_code() else 'NO'}                              │")
    print(f"│ cursor:    {'OK' if _has_cursor() else 'NO'}                                    │")
    print(f"│ GPU:       {'OK (nvidia-smi)' if has_gpu else 'no disponible'}                    │")
    if recovered:
        print(f"│ Recuperados: {recovered} comando(s) colgado(s)              │")
    print(f"╰───────────────────────────────────────────────────╯")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBridge detenido.")
