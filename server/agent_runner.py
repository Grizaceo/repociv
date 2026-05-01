"""Agent execution layer for RepoCiv bridge.

Kept outside bridge.py so HTTP routing, transport, and long-running agent work
can be tested independently.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import uuid
import urllib.request
from pathlib import Path
from typing import Any, Callable

from server import event_store as _es
from server import directive_store as _ds
from server import sessions as _sessions
from server import run_state as _run_state
from server import runtime_adapters as _runtime_adapters
from server.quest import generate_quest_name

SendFn = Callable[[dict[str, Any]], None]
SaveMissionFn = Callable[[dict[str, Any]], None]


def _noop_send(_event: dict[str, Any]) -> None:
    return None


def _noop_save(_mission: dict[str, Any]) -> None:
    return None


send_to_repociv: SendFn = _noop_send
save_mission: SaveMissionFn = _noop_save


def configure(*, send: SendFn | None = None, save: SaveMissionFn | None = None) -> None:
    global send_to_repociv, save_mission
    if send is not None:
        send_to_repociv = send
    if save is not None:
        save_mission = save


AGENT_CONFIGS: dict[str, dict[str, Any]] = {
    "DAVI": {
        "agent": "main", "personality": "technical", "stateful": True,
        "system": ("Eres DAVI, agente principal de Cristóbal. Conoces el workspace, "
                   "mantienes contexto entre misiones y respondes técnico y conciso."),
    },
    "WORKER": {
        "agent": "main", "personality": "concise", "stateful": False,
        "system": ("Eres WORKER, ejecutor sin memoria previa. Recibes UNA tarea, "
                   "la resuelves en el mínimo de tokens posible y entregas el resultado. "
                   "No hagas preguntas de clarificación; asume lo razonable y avanza."),
    },
    "SCOUT": {
        "agent": "main", "personality": "helpful", "stateful": False,
        "system": ("Eres SCOUT, explorador sin memoria previa. Tu trabajo es inspeccionar "
                   "código/archivos/repos y devolver un resumen breve y accionable. "
                   "Prioriza hechos sobre opiniones."),
    },
    "LEXO": {
        "agent": "main", "personality": "analytical", "stateful": True,
        "system": ("Eres LexO-α, agente analítico con memoria. Analiza con profundidad, "
                   "cita el archivo y línea cuando aplique, y produce diagnóstico antes "
                   "que solución."),
    },
    "OPENCLAW": {
        "agent": "main", "personality": "technical", "stateful": True,
        "system": "Eres openclaw, agente local de Cristóbal.",
    },
}


def _get_agent_config(unit_id: str) -> dict[str, Any]:
    base = unit_id.split("-")[0].upper()
    return AGENT_CONFIGS.get(base, AGENT_CONFIGS["DAVI"])


def _resolve_city_path(city_id: str) -> str | None:
    root = os.environ.get("REPOCIV_REPOS_ROOT",
                          os.environ.get("WORKSPACE_ROOT",
                          str(Path.home() / ".hermes" / "workspace" / "repos")))
    root = os.path.expanduser(root)
    candidate = os.path.join(root, city_id)
    return candidate if os.path.isdir(candidate) else None


def run_agent(unit_id: str, city_id: str, mission: str, agent_type: str = "hero",
              command_id: str | None = None) -> None:
    mission_id = command_id or str(uuid.uuid4())[:8]
    quest_name = generate_quest_name(mission)
    started_at = time.time()
    working_dir = _resolve_city_path(city_id)

    runtime = _runtime_adapters.default_agent_runtime(unit_id)

    mission_record: dict[str, Any] = {
        "id": mission_id, "unit": unit_id, "city": city_id, "mission": mission,
        "questName": quest_name, "agentType": agent_type, "startedAt": started_at,
        "completedAt": None, "status": "running", "summary": "", "lines": 0, "duration": 0,
    }
    save_mission(mission_record)
    _es.record_started(mission_id)
    _sessions.patch(
        unit_id,
        runtimeId=runtime.harness_id,
        repo=city_id,
        workingDirectory=working_dir or "",
        summary=quest_name,
        lastMissionId=mission_id,
    )
    _sessions.append_message(unit_id, "user", mission, {"missionId": mission_id, "city": city_id})
    _run_state.save(mission_id, {
        "unitId": unit_id,
        "runtimeId": runtime.harness_id,
        "repo": city_id,
        "commandType": "execute_agent",
        "phase": "executing",
        "status": "running",
        "retries": 0,
        "checkpointApproved": [],
        "filesTouched": [],
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started_at)),
    })

    send_to_repociv({"type": "mission_start", "missionId": mission_id, "unit": unit_id, "questName": quest_name})
    send_to_repociv({"type": "building_start", "city": city_id, "building": quest_name,
                     "durationSeconds": 120, "missionId": mission_id})
    send_to_repociv({"type": "unit_state", "unit": unit_id, "state": "working"})

    success, output = _execute_streaming(unit_id, mission_id, mission, working_dir)

    duration = time.time() - started_at
    mission_record.update({"completedAt": time.time(), "status": "complete" if success else "failed",
                           "summary": output[-500:], "duration": duration, "lines": len(output.splitlines())})
    save_mission(mission_record)

    if success:
        _es.record_completed(mission_id, output[-500:])
        _ds.record_outcome(mission_id, "success", duration)
        _run_state.patch(
            mission_id,
            status="completed",
            phase="completed",
            finishedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            result=output[-500:],
        )
        send_to_repociv({"type": "building_complete", "city": city_id, "building": quest_name, "missionId": mission_id})
        send_to_repociv({"type": "log", "msg": f"{unit_id} completó: {quest_name}", "level": "success"})
    else:
        _es.record_failed(mission_id, output[-500:])
        _ds.record_outcome(mission_id, "failure", duration)
        _run_state.patch(
            mission_id,
            status="failed",
            phase="failed",
            finishedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            error=output[-500:],
        )
        send_to_repociv({"type": "building_failed", "city": city_id, "building": quest_name, "missionId": mission_id})
        send_to_repociv({"type": "log", "msg": f"{unit_id} falló en: {quest_name}", "level": "warn"})

    send_to_repociv({"type": "unit_state", "unit": unit_id, "state": "idle"})
    send_to_repociv({"type": "mission_complete", "missionId": mission_id, "unit": unit_id,
                     "success": success, "duration": int(duration)})


def _execute_streaming(unit_id: str, mission_id: str, mission: str,
                       working_dir: str | None = None) -> tuple[bool, str]:
    config = _get_agent_config(unit_id)
    base = unit_id.split("-")[0].upper()

    if base == "OPENCLAW":
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": "[transport: openclaw]\n"})
        return _run_openclaw_streaming(unit_id, mission_id, mission, config, working_dir)

    # Adapter selection: claude-code → hermes → openclaw
    if _has_claude_code():
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": "[transport: claude-code]\n"})
        success, output = _run_claude_code_streaming(unit_id, mission_id, mission, config, working_dir)
        if success:
            return success, output
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": "[claude-code falló → fallback hermes]\n"})

    send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": "[transport: hermes]\n"})
    success, output = _run_hermes_streaming(unit_id, mission_id, mission, config, working_dir)
    if not success:
        if _has_openclaw():
            send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": "[hermes falló → fallback openclaw]\n"})
            return _run_openclaw_streaming(unit_id, mission_id, mission, config, working_dir)
        # All adapters unavailable — return explicit failure, not a silent success
        msg = "[offline] Ningún adaptador de agente disponible (claude-code, hermes, openclaw). Sin ejecución real.\n"
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": msg})
        return False, msg.strip()
    return success, output


def _has_openclaw() -> bool:
    return _find_openclaw() is not None


def _find_openclaw() -> str | None:
    candidates = [
        shutil.which("openclaw"),
        str(Path.home() / ".npm-global" / "bin" / "openclaw"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists() and os.access(candidate, os.X_OK):
            return candidate
    return None


def _has_claude_code() -> bool:
    return _find_claude_code() is not None


def _find_claude_code() -> str | None:
    candidates = [
        shutil.which("claude"),
        str(Path.home() / ".npm-global" / "bin" / "claude"),
        str(Path.home() / ".local" / "bin" / "claude"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists() and os.access(candidate, os.X_OK):
            return candidate
    return None


def _run_claude_code_streaming(unit_id: str, mission_id: str, mission: str,
                                config: dict[str, Any],
                                working_dir: str | None = None) -> tuple[bool, str]:
    claude_bin = _find_claude_code()
    if not claude_bin:
        text = "[claude-code error] binary not found in PATH, ~/.npm-global/bin or ~/.local/bin\n"
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": text})
        _es.record_output_chunk(mission_id, unit_id, text)
        return False, text.strip()

    system_prompt = config.get("system", "")
    full_prompt = f"{system_prompt}\n\n{mission}" if system_prompt else mission
    cmd = [claude_bin, "--print", "--dangerously-skip-permissions", full_prompt]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1, cwd=working_dir or None)
    output_buf: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        output_buf.append(line)
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": line})
        _es.record_output_chunk(mission_id, unit_id, line)
    proc.wait(timeout=600)
    return proc.returncode == 0, "".join(output_buf)


def _has_cursor() -> bool:
    return _find_cursor() is not None


def _find_cursor() -> str | None:
    candidates = [
        shutil.which("cursor"),
        str(Path.home() / ".local" / "bin" / "cursor"),
        "/usr/local/bin/cursor",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists() and os.access(candidate, os.X_OK):
            return candidate
    return None


def _run_cursor_streaming(unit_id: str, mission_id: str, mission: str,
                           config: dict[str, Any],
                           working_dir: str | None = None) -> tuple[bool, str]:
    cursor_bin = _find_cursor()
    if not cursor_bin:
        text = "[cursor error] binary not found in PATH, ~/.local/bin or /usr/local/bin\n"
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": text})
        _es.record_output_chunk(mission_id, unit_id, text)
        return False, text.strip()

    system_prompt = config.get("system", "")
    full_prompt = f"{system_prompt}\n\n{mission}" if system_prompt else mission
    cmd = [cursor_bin, "--headless", "--message", full_prompt]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1, cwd=working_dir or None)
    output_buf: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        output_buf.append(line)
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": line})
        _es.record_output_chunk(mission_id, unit_id, line)
    proc.wait(timeout=600)
    return proc.returncode == 0, "".join(output_buf)


def _run_openclaw_streaming(unit_id: str, mission_id: str, mission: str,
                             config: dict[str, Any],
                             working_dir: str | None = None) -> tuple[bool, str]:
    if config.get("stateful", True):
        session_id = f"repociv-{unit_id.lower()}"
    else:
        session_id = f"repociv-{unit_id.lower()}-{mission_id}"

    openclaw_bin = _find_openclaw()
    if not openclaw_bin:
        text = "[openclaw error] binary not found in PATH or ~/.npm-global/bin/openclaw\n"
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": text})
        _es.record_output_chunk(mission_id, unit_id, text)
        return False, text.strip()

    cmd = [openclaw_bin, "agent", "--agent", config["agent"],
           "--session-id", session_id, "--message", mission]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, cwd=working_dir or None)
    output_buf: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        output_buf.append(line)
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": line})
        _es.record_output_chunk(mission_id, unit_id, line)
    proc.wait(timeout=600)
    return proc.returncode == 0, "".join(output_buf)


def _run_hermes_streaming(unit_id: str, mission_id: str, mission: str,
                           config: dict[str, Any] | None = None,
                           working_dir: str | None = None) -> tuple[bool, str]:
    HERMES_URL   = os.environ.get("HERMES_URL",   "http://localhost:8642/v1/chat/completions")
    HERMES_KEY   = os.environ.get("HERMES_KEY",   "davi-voice-bridge-2026")
    HERMES_MODEL = os.environ.get("HERMES_MODEL", "minimax-m2.6")

    cfg = config if config is not None else _get_agent_config(unit_id)
    payload: dict[str, Any] = {
        "model": HERMES_MODEL,
        "messages": [
            {"role": "system", "content": cfg.get("system", "Eres un agente útil.")},
            {"role": "user", "content": mission},
        ],
        "stream": False,
    }
    if working_dir:
        payload["working_directory"] = working_dir
    try:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            HERMES_URL, data=data,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {HERMES_KEY}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode())
        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        for i in range(0, len(content), 40):
            chunk = content[i:i + 40]
            send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": chunk})
            _es.record_output_chunk(mission_id, unit_id, chunk)
            time.sleep(0.04)
        return True, content
    except Exception as e:
        err = str(e)
        text = f"[hermes error] {err}\n"
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": text})
        _es.record_output_chunk(mission_id, unit_id, text)
        return False, err
