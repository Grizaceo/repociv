import json
import os
import re
import subprocess
import uuid
from pathlib import Path

from .sse_server import send_to_repociv


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
_LEXO_PERSIST_PATH = Path.home() / ".repociv" / "detected_lexo.json"


def _load_lexo_seen() -> dict[str, str]:
    try:
        data = json.loads(_LEXO_PERSIST_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items()}
        # backward compat: lista vieja → map vacío (se reconstruye)
        return {}
    except Exception:
        return {}


def _save_lexo_seen(seen: dict[str, str]) -> None:
    try:
        _LEXO_PERSIST_PATH.parent.mkdir(parents=True, exist_ok=True)
        _LEXO_PERSIST_PATH.write_text(json.dumps(seen), encoding="utf-8")
    except Exception:
        pass


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


# Regex estricta: solo el proceso agente hermes con perfil lexo-alpha
_LEXO_RE = re.compile(
    r"(?:^|\s)hermes\s+chat\s+.*lexo-alpha|hermes-agent.*lexo",
    re.IGNORECASE,
)


def detect_lexo() -> None:
    seen = _load_lexo_seen()

    # 1) Limpiar PIDs muertos
    dead = {pk for pk in seen if not _pid_alive(int(pk))}
    if dead:
        for pk in dead:
            send_to_repociv({"type": "unit_despawn", "unit": seen[pk]})
        for pk in dead:
            seen.pop(pk, None)
        _save_lexo_seen(seen)

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
            cmd = parts[10]
            if not _LEXO_RE.search(cmd):
                continue
            pk = str(pid)
            # 2) Ya trackeado
            if pk in seen:
                continue
            # 3) Cap: máximo 1 LexO a la vez
            if any(_pid_alive(int(k)) for k in seen):
                continue
            unit_id = f"LEXO-{uuid.uuid4().hex[:8]}"
            seen[pk] = unit_id
            _save_lexo_seen(seen)
            hex_q = 2 + (pid % 3)
            hex_r = pid % 5
            send_to_repociv({"type": "unit_spawn", "unit": unit_id, "civ": "gris",
                             "hex": [hex_q, hex_r], "unitType": "lexo",
                             "mission": f"Proceso: {cmd[:40]}"})
            send_to_repociv({"type": "log", "msg": f"LexO-α detectado (pid {pid})", "level": "success"})
    except Exception:
        pass

