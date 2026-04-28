#!/usr/bin/env python3
"""RepoCiv ↔ DAVI bridge.

Recibe comandos desde RepoCiv (port 5273) y los ejecuta via openclaw o Hermes API.
Streamea stdout del agente como eventos chat_chunk a RepoCiv.
Persiste misiones en ~/.repociv/missions.json.

Nuevos endpoints:
  GET /gpu      — VRAM y temperatura GPU via nvidia-smi
  GET /pending  — Misiones pendientes de ~/.hermes/workspace/PENDING_TRACKER.md
  POST /quest_add — Agrega misión a PENDING_TRACKER.md

Uso:
    python3 bridge.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import uuid
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any


# ─── .env loader (sin python-dotenv para evitar dependencia) ────────────────
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
BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "5274"))

CONFIG_DIR = Path(os.path.expanduser(os.environ.get("REPOCIV_CONFIG_DIR", "~/.repociv")))
CONFIG_DIR.mkdir(exist_ok=True, parents=True)
MISSIONS_FILE = CONFIG_DIR / "missions.json"
HERMES_ROOT = Path(os.path.expanduser(os.environ.get("HERMES_ROOT", "~/.hermes")))
PENDING_TRACKER = HERMES_ROOT / "workspace" / "PENDING_TRACKER.md"

# ─── Mission persistence ────────────────────────────────────────────────────
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


# ─── Phase 9: XCOM Context Fatigue state ─────────────────────────────────────
# In-memory fatigue tracking for all active units.
# Key = unit_id, Value = {"fatigue": int, "effectiveSpeed": float, "isResting": bool, "restAreaId": str|None}
_fatigue_state: dict[str, dict[str, Any]] = {}
# Rest areas discovered in the world.
# Key = restAreaId, Value = {"id": str, "roomId": str, "coord": [q,r], "recoveryRate": float, "capacity": int, "unitsInside": list[str]}
_rest_areas: dict[str, dict[str, Any]] = {}
# Lock for thread-safe fatigue updates
_fatigue_lock = threading.Lock()


def get_unit_fatigue(unit_id: str) -> dict[str, Any]:
    with _fatigue_lock:
        return _fatigue_state.get(unit_id, {
            "fatigue": 100,
            "effectiveSpeed": 1.0,
            "isResting": False,
            "restAreaId": None,
        })


def update_unit_fatigue(unit_id: str, *, fatigue: int | None = None,
                        effective_speed: float | None = None,
                        is_resting: bool | None = None,
                        rest_area_id: str | None = None,
                        delta: int = 0) -> dict[str, Any]:
    """Update fatigue fields for a unit. Returns the updated state dict."""
    with _fatigue_lock:
        entry = _fatigue_state.setdefault(unit_id, {
            "fatigue": 100,
            "effectiveSpeed": 1.0,
            "isResting": False,
            "restAreaId": None,
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
        # Recompute effective speed from fatigue (linear falloff)
        entry["effectiveSpeed"] = round(entry["fatigue"] / 100.0, 3)
        return dict(entry)


def discover_rest_area(rest_area_id: str, room_id: str, coord: tuple,
                       recovery_rate: float = 8.0, capacity: int = 4) -> dict[str, Any]:
    """Register a new rest area discovered in the world."""
    with _fatigue_lock:
        area = {
            "id": rest_area_id,
            "roomId": room_id,
            "coord": list(coord),
            "recoveryRate": recovery_rate,
            "capacity": capacity,
            "unitsInside": [],
        }
        _rest_areas[rest_area_id] = area
        return dict(area)


def enter_rest_area(unit_id: str, rest_area_id: str) -> bool:
    """Attempt to enter a rest area. Returns True if successful."""
    with _fatigue_lock:
        area = _rest_areas.get(rest_area_id)
        if not area:
            return False
        if len(area["unitsInside"]) >= area["capacity"]:
            return False
        if unit_id not in area["unitsInside"]:
            area["unitsInside"].append(unit_id)
        entry = _fatigue_state.get(unit_id, {})
        entry["isResting"] = True
        entry["restAreaId"] = rest_area_id
        _fatigue_state[unit_id] = entry
        return True


def exit_rest_area(unit_id: str) -> None:
    """Remove unit from whatever rest area they were in."""
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


def tick_fatigue_recovery(dt_seconds: float) -> None:
    """Call each frame/tick to recover fatigue for resting units."""
    with _fatigue_lock:
        for unit_id, entry in list(_fatigue_state.items()):
            if entry.get("isResting") and entry.get("restAreaId"):
                ra = _rest_areas.get(entry["restAreaId"])
                if ra:
                    recovered = ra["recoveryRate"] * dt_seconds
                    entry["fatigue"] = max(0, min(100, entry["fatigue"] + recovered))
                    entry["effectiveSpeed"] = round(entry["fatigue"] / 100.0, 3)


# ─── RepoCiv event sender ───────────────────────────────────────────────────
def send_to_repociv(event: dict[str, Any]) -> None:
    try:
        data = json.dumps(event).encode()
        req = urllib.request.Request(
            f"http://localhost:{REPOCIV_PORT}/event",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass


# ─── Quest name generator ──────────────────────────────────────────────────
def generate_quest_name(mission: str) -> str:
    words = re.findall(r"\b[a-zA-ZáéíóúñÁÉÍÓÚÑ]+\b", mission)
    if not words:
        return "Misión Desconocida"
    keywords = [w for w in words if len(w) >= 4][:3]
    if not keywords:
        keywords = words[:3]
    return " ".join(w.capitalize() for w in keywords)[:40]


# ─── GPU info via nvidia-smi ────────────────────────────────────────────────
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
        return {
            "vramUsed": int(parts[0]),
            "vramTotal": int(parts[1]),
            "temp": int(parts[2]),
        }
    except Exception:
        return None


# ─── Tech-debt scanner ────────────────────────────────────────────────────────
_TD_PATTERNS = re.compile(
    r'(TODO\s*[:\-]?\s*tech\s*debt|FIXME\s*[:\-]?\s*hack|HACK|BUG\s*[:\-]?\s*|'
    r'REFACTOR|TECH\s*DEBT|DEBT\s*[:\-]?\s*|LEGACY|STALE)',
    re.IGNORECASE,
)
_TD_EXTENSIONS = {'.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.cpp', '.c', '.h'}


def scan_tech_debt(root_path: str = os.path.expanduser("~/.hermes/workspace/repos")) -> list[dict[str, Any]]:
    """Walk repos looking for files with tech-debt markers."""
    results: list[dict[str, Any]] = []
    try:
        for repo in os.listdir(root_path):
            repo_path = os.path.join(root_path, repo)
            if not os.path.isdir(repo_path):
                continue
            for dirpath, _dirs, filenames in os.walk(repo_path):
                # Skip node_modules, .git, __pycache__, .venv
                skip = set(json.loads(Path(__file__).parent.parent.joinpath("shared/skip-dirs.json").read_text()))
                if any(s in dirpath for s in skip):
                    continue
                for fname in filenames:
                    ext = os.path.splitext(fname)[1].lower()
                    if ext not in _TD_EXTENSIONS:
                        continue
                    fpath = os.path.join(dirpath, fname)
                    try:
                        rel = os.path.relpath(fpath, root_path)
                        with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
                            content = f.read()
                        matches: list[dict[str, str]] = []
                        for i, line in enumerate(content.splitlines(), 1):
                            if _TD_PATTERNS.search(line):
                                matches.append({'line': i, 'text': line.strip()[:120]})
                        if matches:
                            results.append({
                                'repo': repo,
                                'file': rel,
                                'path': fpath,
                                'matches': matches,
                                'severity': _assess_debt_severity(matches),
                            })
                    except Exception:
                        pass
    except Exception:
        pass
    return results


def _assess_debt_severity(matches: list[dict[str, str]]) -> str:
    """Heuristic severity based on keyword."""
    critical = {'BUG', 'HACK', 'FIXME'}
    high = {'TECH DEBT', 'REFACTOR', 'DEBT', 'LEGACY'}
    for m in matches:
        first_word = m['text'].split()[0].upper() if m['text'] else ''
        if first_word in critical:
            return 'critical'
        if any(w in m['text'].upper() for w in high):
            return 'high'
    return 'normal'


# ─── PENDING_TRACKER parser ─────────────────────────────────────────────────
def load_pending_tasks() -> list[dict[str, str]]:
    if not PENDING_TRACKER.exists():
        return []
    try:
        tasks = []
        for line in PENDING_TRACKER.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*-\s*\[\s*\]\s*(.+)", line)
            if m:
                tasks.append({"title": m.group(1).strip()})
        return tasks
    except Exception:
        return []


def append_pending_task(title: str, description: str = "") -> None:
    try:
        existing = PENDING_TRACKER.read_text(encoding="utf-8") if PENDING_TRACKER.exists() else ""
        entry = f"\n- [ ] {title}"
        if description:
            entry += f"\n  {description}"
        PENDING_TRACKER.write_text(existing.rstrip() + entry + "\n", encoding="utf-8")
    except Exception as e:
        print(f"[bridge] No pude escribir PENDING_TRACKER: {e}")


# ─── Process scanner ────────────────────────────────────────────────────────
PROCESS_KEYWORDS = [
    "python train", "python3 train", "cargo run", "cargo build",
    "npm run", "vite", "pytest", "uvicorn", "flask run",
]

_last_scan_pids: set[int] = set()


def scan_active_processes() -> None:
    global _last_scan_pids
    try:
        result = subprocess.run(["ps", "aux"], capture_output=True, text=True, timeout=5)
        lines = result.stdout.strip().splitlines()
        current_pids: set[int] = set()

        for line in lines[1:]:
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
                    # New process detected
                    cmd_clean = parts[10][:80]
                    send_to_repociv({
                        "type": "building_start",
                        "city": "main",
                        "building": cmd_clean,
                        "durationSeconds": 300,
                        "pid": pid,
                        "cmd": cmd_clean,
                    })
                    send_to_repociv({
                        "type": "log",
                        "msg": f"Proceso detectado: {cmd_clean[:50]}",
                        "level": "info",
                    })
        _last_scan_pids = current_pids
    except Exception:
        pass


# ─── LexO-Alpha detection ────────────────────────────────────────────────────
_lexo_spawned: set[str] = set()
_lexo_counter = 0


def detect_lexo() -> None:
    global _lexo_counter
    try:
        result = subprocess.run(["ps", "aux"], capture_output=True, text=True, timeout=5)
        found_pids: list[tuple[int, str]] = []

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
                found_pids.append((pid, parts[10]))

        for pid, cmd in found_pids:
            pid_key = str(pid)
            if pid_key not in _lexo_spawned:
                _lexo_spawned.add(pid_key)
                _lexo_counter += 1
                unit_id = f"LEXO-{_lexo_counter}"
                send_to_repociv({
                    "type": "unit_spawn",
                    "unit": unit_id,
                    "civ": "gris",
                    "hex": [2, _lexo_counter],
                    "unitType": "lexo",
                    "mission": f"Proceso: {cmd[:40]}",
                })
                send_to_repociv({
                    "type": "log",
                    "msg": f"LexO-α detectado (pid {pid})",
                    "level": "success",
                })
    except Exception:
        pass


# ─── Agent roster ───────────────────────────────────────────────────────────
# stateful=True  → la sesión de openclaw persiste entre misiones (DAVI, LEXO).
# stateful=False → cada misión arranca con session-id fresco, sin contexto previo
#                  (WORKER, SCOUT — agentes "ejecutores" eficientes).
AGENT_CONFIGS: dict[str, dict[str, Any]] = {
    "DAVI": {
        "agent": "main",
        "personality": "technical",
        "stateful": True,
        "system": (
            "Eres DAVI, agente principal de Cristóbal. Conoces el workspace, "
            "mantienes contexto entre misiones y respondes técnico y conciso."
        ),
    },
    "WORKER": {
        "agent": "main",
        "personality": "concise",
        "stateful": False,
        "system": (
            "Eres WORKER, ejecutor sin memoria previa. Recibes UNA tarea, "
            "la resuelves en el mínimo de tokens posible y entregas el resultado. "
            "No hagas preguntas de clarificación; asume lo razonable y avanza."
        ),
    },
    "SCOUT": {
        "agent": "main",
        "personality": "helpful",
        "stateful": False,
        "system": (
            "Eres SCOUT, explorador sin memoria previa. Tu trabajo es inspeccionar "
            "código/archivos/repos y devolver un resumen breve y accionable. "
            "Prioriza hechos sobre opiniones."
        ),
    },
    "LEXO": {
        "agent": "main",
        "personality": "analytical",
        "stateful": True,
        "system": (
            "Eres LexO-α, agente analítico con memoria. Analiza con profundidad, "
            "cita el archivo y línea cuando aplique, y produce diagnóstico antes "
            "que solución."
        ),
    },
    "OPENCLAW": {
        "agent": "main",
        "personality": "technical",
        "stateful": True,
        "system": "Eres openclaw, agente local de Cristóbal.",
    },
}


def _get_agent_config(unit_id: str) -> dict[str, Any]:
    base = unit_id.split("-")[0].upper()
    return AGENT_CONFIGS.get(base, AGENT_CONFIGS["DAVI"])


def run_agent(unit_id: str, city_id: str, mission: str, agent_type: str = "hero") -> None:
    mission_id = str(uuid.uuid4())[:8]
    quest_name = generate_quest_name(mission)
    started_at = time.time()

    mission_record: dict[str, Any] = {
        "id": mission_id,
        "unit": unit_id,
        "city": city_id,
        "mission": mission,
        "questName": quest_name,
        "agentType": agent_type,
        "startedAt": started_at,
        "completedAt": None,
        "status": "running",
        "summary": "",
        "lines": 0,
        "duration": 0,
    }
    save_mission(mission_record)

    send_to_repociv({"type": "mission_start", "missionId": mission_id, "unit": unit_id, "questName": quest_name})
    send_to_repociv({"type": "building_start", "city": city_id, "building": quest_name, "durationSeconds": 120, "missionId": mission_id})
    send_to_repociv({"type": "unit_state", "unit": unit_id, "state": "working"})

    success, output = _execute_streaming(unit_id, mission_id, mission)

    duration = time.time() - started_at
    mission_record.update({
        "completedAt": time.time(),
        "status": "complete" if success else "failed",
        "summary": output[-500:],
        "duration": duration,
        "lines": len(output.splitlines()),
    })
    save_mission(mission_record)

    if success:
        send_to_repociv({"type": "building_complete", "city": city_id, "building": quest_name, "missionId": mission_id})
        send_to_repociv({"type": "log", "msg": f"{unit_id} completó: {quest_name}", "level": "success"})
    else:
        send_to_repociv({"type": "building_failed", "city": city_id, "building": quest_name, "missionId": mission_id})
        send_to_repociv({"type": "log", "msg": f"{unit_id} falló en: {quest_name}", "level": "warn"})

    send_to_repociv({"type": "unit_state", "unit": unit_id, "state": "idle"})
    send_to_repociv({"type": "mission_complete", "missionId": mission_id, "unit": unit_id, "success": success, "duration": int(duration)})


def _execute_streaming(unit_id: str, mission_id: str, mission: str) -> tuple[bool, str]:
    config = _get_agent_config(unit_id)
    base = unit_id.split("-")[0].upper()

    # OPENCLAW unit → always openclaw, no fallback
    if base == "OPENCLAW":
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id,
                         "text": "[transport: openclaw]\n"})
        return _run_openclaw_streaming(unit_id, mission_id, mission, config)

    # All other agents (DAVI, WORKER, SCOUT, LEXO) → Hermes primary.
    # Each agent has its own system prompt and stateful/stateless session semantics.
    # openclaw is available as fallback only if Hermes fails.
    send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id,
                     "text": "[transport: hermes]\n"})
    success, output = _run_hermes_streaming(unit_id, mission_id, mission, config)
    if not success and _has_openclaw():
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id,
                         "text": "[hermes falló → fallback openclaw]\n"})
        return _run_openclaw_streaming(unit_id, mission_id, mission, config)
    return success, output


def _has_openclaw() -> bool:
    try:
        subprocess.run(["which", "openclaw"], capture_output=True, check=True, timeout=2)
        return True
    except Exception:
        return False


def _run_openclaw_streaming(unit_id: str, mission_id: str, mission: str,
                             config: dict[str, Any]) -> tuple[bool, str]:
    # Stateless agents (WORKER, SCOUT) get fresh session id per mission
    # so no context leaks between misiones.
    if config.get("stateful", True):
        session_id = f"repociv-{unit_id.lower()}"
    else:
        session_id = f"repociv-{unit_id.lower()}-{mission_id}"

    cmd = [
        "openclaw", "agent",
        "--agent", config["agent"],
        "--session-id", session_id,
        "--message", mission,
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    output_buf: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        output_buf.append(line)
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": line})
    proc.wait(timeout=600)
    return proc.returncode == 0, "".join(output_buf)


def _run_hermes_streaming(unit_id: str, mission_id: str, mission: str,
                           config: dict[str, Any] | None = None) -> tuple[bool, str]:
    HERMES_URL = os.environ.get("HERMES_URL", "http://localhost:8642/v1/chat/completions")
    HERMES_KEY = os.environ.get("HERMES_KEY", "davi-voice-bridge-2026")
    HERMES_MODEL = os.environ.get("HERMES_MODEL", "minimax-m2.6")

    cfg = config if config is not None else _get_agent_config(unit_id)
    system_prompt = cfg.get("system", "Eres un agente útil.")

    payload = {
        "model": HERMES_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": mission},
        ],
        "stream": False,
    }
    try:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(HERMES_URL, data=data, headers={"Content-Type": "application/json", "Authorization": f"Bearer {HERMES_KEY}"}, method="POST")
        with urllib.request.urlopen(req, timeout=120) as resp:
            response_text = resp.read().decode()
        result = json.loads(response_text)
        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        for i in range(0, len(content), 40):
            send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": content[i:i + 40]})
            time.sleep(0.04)
        return True, content

    except Exception as e:
        return False, str(e)


# ─── HTTP Handler ───────────────────────────────────────────────────────────
class BridgeHandler(BaseHTTPRequestHandler):
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/missions":
            missions = load_missions()
            self._json(missions)
            return

        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(b'{"ok":true,"openclaw":' + (b"true" if _has_openclaw() else b"false") + b"}")
            return

        if self.path == "/gpu":
            data = get_gpu_info()
            self._json(data)
            return

        if self.path == "/pending":
            tasks = load_pending_tasks()
            self._json(tasks)
            return

        if self.path == "/techdebt":
            root = os.environ.get("REPOCIV_REPOS_ROOT",
                                 str(Path(__file__).parent.parent / "workspace" / "repos"))
            debt = scan_tech_debt(root)
            self._json(debt)
            return

        # Phase 9: XCOM Context Fatigue endpoints
        if self.path == "/context":
            # GET /context — return fatigue state for all tracked units
            self._json({"ok": True, "fatigue": _fatigue_state, "restAreas": _rest_areas})
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            t = body.get("type")

            if t == "unit_command":
                threading.Thread(
                    target=run_agent,
                    args=(body.get("unit", "DAVI"), body.get("city", "main"), body.get("mission", ""), body.get("agentType", "hero")),
                    daemon=True,
                ).start()

            elif t == "tile_inspected":
                city_name = body.get("cityName", "")
                repo_path = body.get("repoPath", "")
                print(f"[bridge] tile_inspected: {city_name} ({repo_path})", flush=True)
                # Extensible: enviar contexto a Hermes en el futuro
                send_to_repociv({"type": "log", "msg": f"Inspeccionando: {city_name}", "level": "info"})

            elif t == "quest_add":
                title = body.get("title", "Sin título")
                description = body.get("description", "")
                append_pending_task(title, description)
                # Persist as mission too
                mission_rec: dict[str, Any] = {
                    "id": f"pending-{uuid.uuid4().hex[:6]}",
                    "unit": "DAVI",
                    "city": "main",
                    "mission": title,
                    "questName": title,
                    "agentType": "hero",
                    "startedAt": time.time(),
                    "completedAt": None,
                    "status": "running",
                    "summary": description,
                    "lines": 0,
                    "duration": 0,
                }
                save_mission(mission_rec)
                send_to_repociv({"type": "mission_start", "missionId": mission_rec["id"], "unit": "DAVI", "questName": title})
                send_to_repociv({"type": "log", "msg": f"Quest agregado: {title}", "level": "success"})

            # Phase 9: XCOM Context Fatigue POST commands
            elif t == "unit_fatigue_delta":
                # Decay or recover fatigue for a unit (e.g. after a mission tick)
                unit_id = body.get("unit", "")
                delta = int(body.get("delta", 0))
                entry = update_unit_fatigue(unit_id, delta=delta)
                send_to_repociv({
                    "type": "unit_fatigue_update",
                    "unit": unit_id,
                    "fatigue": entry["fatigue"],
                    "effectiveSpeed": entry["effectiveSpeed"],
                })

            elif t == "discover_rest_area":
                # Mark a room as a rest area
                ra_id = body.get("restAreaId", f"ra-{uuid.uuid4().hex[:6]}")
                room_id = body.get("roomId", "")
                coord = body.get("coord", [0, 0])
                area = discover_rest_area(ra_id, room_id, tuple(coord))
                send_to_repociv({"type": "rest_area_discovered", "restArea": area})

            elif t == "enter_rest_area":
                unit_id = body.get("unit", "")
                ra_id = body.get("restAreaId", "")
                ok = enter_rest_area(unit_id, ra_id)
                if ok:
                    send_to_repociv({"type": "rest_area_entered", "unit": unit_id, "restAreaId": ra_id})
                else:
                    send_to_repociv({"type": "log", "msg": f"Rest area {ra_id} llena o no existe", "level": "warn"})

            elif t == "exit_rest_area":
                unit_id = body.get("unit", "")
                exit_rest_area(unit_id)
                send_to_repociv({"type": "rest_area_exited", "unit": unit_id, "restAreaId": ""})

            self._json({"ok": True})

        except Exception as e:
            self.send_response(400)
            self._cors()
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def _json(self, data: Any) -> None:
        payload = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_args) -> None:
        pass


# ─── Background scanner thread ───────────────────────────────────────────────
def background_scanner() -> None:
    time.sleep(3)  # wait for bridge to be ready
    scan_active_processes()
    detect_lexo()
    while True:
        time.sleep(60)
        scan_active_processes()
        time.sleep(30)
        detect_lexo()


# ─── Main ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    server = HTTPServer(("localhost", BRIDGE_PORT), BridgeHandler)
    threading.Thread(target=background_scanner, daemon=True).start()
    has_gpu = get_gpu_info() is not None
    print(f"╭─ RepoCiv Bridge ─────────────────────────────╮")
    print(f"│ Comandos:  http://localhost:{BRIDGE_PORT}              │")
    print(f"│ Eventos:   http://localhost:{REPOCIV_PORT}/event        │")
    print(f"│ Missions:  {MISSIONS_FILE}    │")
    print(f"│ openclaw:  {'OK' if _has_openclaw() else 'NO (usará Hermes API)'}                          │")
    print(f"│ GPU:       {'OK (nvidia-smi)' if has_gpu else 'no disponible'}                    │")
    print(f"│ Pending:   {PENDING_TRACKER}  │")
    print(f"╰──────────────────────────────────────────────╯")
    print(f"Ctrl+C para detener")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBridge detenido.")
