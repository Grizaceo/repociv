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
from server import container_runtime as _container_runtime
from server import run_state as _run_state
from server import runtime_adapters as _runtime_adapters
from server import security_harness as _security_harness
from server import token_ledger as _token_ledger
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


def _repos_root() -> str:
    root = os.environ.get(
        "REPOCIV_REPOS_ROOT",
        os.environ.get(
            "WORKSPACE_ROOT",
            str(Path.home() / ".hermes" / "workspace" / "repos"),
        ),
    )
    return os.path.expanduser(root)


def _resolve_city_path(city_id: str) -> str | None:
    candidate = os.path.join(_repos_root(), city_id)
    return candidate if os.path.isdir(candidate) else None


def _spatial_context_block(city_id: str, working_dir: str | None) -> str:
    """Facts about which repo/city this mission targets — models must not invent a fixed home repo."""
    root = _repos_root()
    expected = os.path.join(root, city_id)
    if working_dir:
        path_line = f"- **Ruta de trabajo (cwd del adaptador):** `{working_dir}`"
    else:
        path_line = (
            f"- **Ruta de trabajo:** NO resuelta: no existe `{expected}`. "
            "Alinea el nombre de la carpeta con `city_id` o crea el clone ahi."
        )
    return (
        "\n\n## Contexto espacial RepoCiv (fuente de verdad)\n"
        f"- **Ciudad / target (`city_id`):** `{city_id}`\n"
        f"{path_line}\n"
        f"- **Raiz de repos (`REPOCIV_REPOS_ROOT` / `WORKSPACE_ROOT`):** `{root}`\n"
        f"- **Ruta esperada para este target:** `{expected}`\n"
        "\n## REGLA DE ORO — APLICABLE A TODA ESTA MISION\n"
        f"Tu directorio de trabajo es y DEBE ser siempre: `{expected}`\n"
        "El gateway NO controla tu CWD automaticamente. Cada tool call es independiente.\n"
        f"Para todo comando de terminal, DEBES usar el parametro `workdir='{expected}'`.\n"
        "Esto asegura que el comando se ejecute en el repo correcto.\n\n"
        f"Ejemplo: terminal_tool(command='ls -la', workdir='{expected}')\n"
        "NUNCA uses terminal() sin pasar workdir. NUNCA asumas el CWD correcto.")



def run_agent(unit_id: str, city_id: str, mission: str, agent_type: str = "hero",
              command_id: str | None = None, harness: str = "",
              provider: str = "", model: str = "") -> None:
    mission_id = command_id or str(uuid.uuid4())[:8]
    quest_name = generate_quest_name(mission)
    started_at = time.time()
    working_dir = _resolve_city_path(city_id)
    if not working_dir:
        send_to_repociv({
            "type": "log",
            "msg": (
                f"city_id={city_id!r}: no hay carpeta bajo {_repos_root()} — "
                "cwd del adaptador puede ser el del bridge (confunde el repo)."
            ),
            "level": "warn",
        })

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
    send_to_repociv({"type": "unit_work", "unit": unit_id, "cityId": city_id, "progress": 0})
    send_to_repociv({"type": "unit_state", "unit": unit_id, "state": "working"})

    success, output = _execute_streaming(unit_id, mission_id, mission, working_dir, city_id,
                                         harness=harness, provider=provider, model=model)

    duration = time.time() - started_at

    # Log token usage — character-count estimate (~4 chars/token) for subprocess
    # adapters. The hermes adapter also logs with real counts when available;
    # this call provides a baseline for all adapters.
    _token_ledger.get_ledger().log_usage(
        model=os.environ.get("HERMES_MODEL", "claude-code"),
        prompt_tokens=max(1, len(mission) // 4),
        completion_tokens=max(1, len(output) // 4),
    )

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
                       working_dir: str | None = None,
                       city_id: str = "",
                       harness: str = "",
                       provider: str = "",
                       model: str = "") -> tuple[bool, str]:
    config = _get_agent_config(unit_id)
    base = unit_id.split("-")[0].upper()

    if _container_mode_enabled():
        return _run_container_streaming(unit_id, mission_id, mission, config, working_dir, city_id)

    # ── 3-layer dispatch: harness → provider → model ──────────────────────────
    # If the user selected a specific harness, use it directly.
    # The provider+model are passed through to the harness runner so it can
    # pick the right API endpoint and model ID.
    if harness and harness != "auto":
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id,
                          "text": f"[harness: {harness}]\n"})
        if harness == "openclaw" and _has_openclaw():
            return _run_openclaw_streaming(unit_id, mission_id, mission, config, working_dir, city_id,
                                           model=model or provider)
        if harness == "claude-code" and _has_claude_code():
            # For claude-code: if model includes provider prefix (e.g. openrouter/deepseek),
            # pass it through — claude CLI --model accepts provider/model format
            return _run_claude_code_streaming(unit_id, mission_id, mission, config, working_dir, city_id,
                                              model=model or provider)
        if harness == "cursor" and _has_cursor():
            return _run_cursor_streaming(unit_id, mission_id, mission, config, working_dir, city_id,
                                         model=model or provider)
        if harness == "hermes":
            return _run_hermes_streaming(unit_id, mission_id, mission, config, working_dir, city_id,
                                         model=model or provider)
        # Unknown harness — fall through to cascade with a warning
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id,
                          "text": f"[warn: harness '{harness}' no reconocido, usando cascade]\n"})

    # ── Default cascade: hermes → claude-code → openclaw ────────────────────
    if base == "OPENCLAW":
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": "[harness: openclaw]\n"})
        return _run_openclaw_streaming(unit_id, mission_id, mission, config, working_dir, city_id)

    send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": "[harness: hermes]\n"})
    success, output = _run_hermes_streaming(unit_id, mission_id, mission, config, working_dir, city_id, model=model or provider)
    if success:
        return success, output

    send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": "[hermes falló → probando claude-code]\n"})
    if _has_claude_code():
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": "[harness: claude-code]\n"})
        success, output = _run_claude_code_streaming(unit_id, mission_id, mission, config, working_dir, city_id, model=model or provider)
        if success:
            return success, output

    if _has_openclaw():
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": "[fallback openclaw]\n"})
        return _run_openclaw_streaming(unit_id, mission_id, mission, config, working_dir, city_id, model=model or provider)

    msg = "[offline] Ningún adaptador de agente disponible (hermes, claude-code, openclaw). Sin ejecución real.\n"
    send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": msg})
    return False, msg.strip()


def _container_mode_enabled() -> bool:
    return os.environ.get("REPOCIV_AGENT_CONTAINER", "").lower() in {"1", "true", "yes"}


def _run_container_streaming(unit_id: str, mission_id: str, mission: str,
                             config: dict[str, Any],
                             working_dir: str | None = None,
                             city_id: str = "") -> tuple[bool, str]:
    if not working_dir:
        text = "[docker error] working directory is required for container mode\n"
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": text})
        _es.record_output_chunk(mission_id, unit_id, text)
        return False, text.strip()

    system_prompt = config.get("system", "")
    spatial = _spatial_context_block(city_id, working_dir)
    full_prompt = (
        f"{system_prompt}{spatial}\n\n{mission}" if system_prompt else f"{spatial}\n\n{mission}"
    )
    token = (
        os.environ.get(_container_runtime.DEFAULT_TOKEN_ENV)
        or os.environ.get("REPOCIV_TOKEN")
        or os.environ.get("X_REPOCIV_TOKEN")
    )
    command = _container_runtime.build_docker_run_command(
        repo_root=working_dir,
        mission=full_prompt,
        token=token,
    )
    harness = _security_harness.get_harness()
    gate = harness.pre_launch_gate(full_prompt, container_command=command)
    if gate.blocked:
        text = f"[security blocked] {gate.reason}\n"
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": text})
        _es.record_output_chunk(mission_id, unit_id, text)
        return False, text.strip()

    runtime_gate = harness.runtime_enforce(container_command=command)
    if runtime_gate.blocked:
        text = f"[runtime blocked] {runtime_gate.reason}\n"
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": text})
        _es.record_output_chunk(mission_id, unit_id, text)
        return False, text.strip()

    result = _container_runtime.run_agent_container(
        repo_root=working_dir,
        mission=full_prompt,
        token=token,
    )
    audit = harness.post_container_exit_audit(
        working_dir,
        result.output,
        changed_files=result.changed_files,
    )
    output = result.output
    for line in output.splitlines(keepends=True):
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": line})
        _es.record_output_chunk(mission_id, unit_id, line)
    if not audit.clean:
        text = f"[security audit failed] {audit.incident_level}\n"
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": text})
        _es.record_output_chunk(mission_id, unit_id, text)
        return False, (output + text).strip()
    return result.ok, output


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
                                working_dir: str | None = None,
                                city_id: str = "",
                                model: str = "") -> tuple[bool, str]:
    claude_bin = _find_claude_code()
    if not claude_bin:
        text = "[claude-code error] binary not found in PATH, ~/.npm-global/bin or ~/.local/bin\n"
        send_to_repociv({"type": "chat_chunk", "unit": unit_id, "missionId": mission_id, "text": text})
        _es.record_output_chunk(mission_id, unit_id, text)
        return False, text.strip()

    system_prompt = config.get("system", "")
    spatial = _spatial_context_block(city_id, working_dir)
    cd_cmd = f"cd {working_dir}\n\n" if working_dir else ""
    full_prompt = (
        f"{system_prompt}{spatial}\n\n{cd_cmd}{mission}" if system_prompt else f"{spatial}\n\n{cd_cmd}{mission}"
    )
    cmd = [claude_bin, "--print", "--dangerously-skip-permissions"]
    # If a specific model was requested via UI, pass it to claude CLI
    if model:
        cmd.extend(["--model", model])
    cmd.append(full_prompt)
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
                           working_dir: str | None = None,
                           city_id: str = "",
                           model: str = "") -> tuple[bool, str]:
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
                             working_dir: str | None = None,
                             city_id: str = "",
                             model: str = "") -> tuple[bool, str]:
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

    spatial = _spatial_context_block(city_id, working_dir)
    cd_cmd = f"cd {working_dir}\n\n" if working_dir else ""
    full_message = f"{spatial}\n\n{cd_cmd}{mission}"
    cmd = [openclaw_bin, "agent", "--agent", config["agent"],
           "--session-id", session_id, "--message", full_message]
    # If a specific model was requested via UI, pass it to openclaw
    if model:
        cmd.extend(["--model", model])
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
                           working_dir: str | None = None,
                           city_id: str = "",
                           model: str = "") -> tuple[bool, str]:
    HERMES_URL   = os.environ.get("HERMES_URL",   "http://localhost:8642/v1/chat/completions")
    HERMES_KEY   = os.environ.get("HERMES_KEY",   "davi-voice-bridge-2026")
    HERMES_MODEL = model or os.environ.get("HERMES_MODEL", "hermes-agent")

    cfg = config if config is not None else _get_agent_config(unit_id)
    # Build session_id matching _run_openclaw_streaming logic for consistency
    if cfg.get("stateful", True):
        session_id = f"repociv-{unit_id.lower()}"
    else:
        session_id = f"repociv-{unit_id.lower()}-{mission_id}"

    spatial = _spatial_context_block(city_id, working_dir)
    system_content = cfg.get("system", "Eres un agente util.") + spatial
    # Inject imperative cd instruction directly in the user message
    # (Hermes gateway ignores the working_directory field; we compensate
    # by making the very first line of the mission a cd command.)
    user_content: str
    if working_dir:
        user_content = f"cd {working_dir}\n\n{mission}"
    else:
        user_content = mission
    payload: dict[str, Any] = {
        "model": HERMES_MODEL,
        "messages": [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ],
        "stream": False,
        "max_tokens": 4096,
    }
    if working_dir:
        payload["working_directory"] = working_dir
    try:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            HERMES_URL, data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {HERMES_KEY}",
                "X-Hermes-Session-Id": session_id,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=900) as resp:
            result = json.loads(resp.read().decode())
        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        # Log real token usage from the OpenAI-compatible response when present.
        usage = result.get("usage") or {}
        if usage.get("prompt_tokens") or usage.get("completion_tokens"):
            _token_ledger.get_ledger().log_usage(
                model=HERMES_MODEL,
                prompt_tokens=int(usage.get("prompt_tokens", 0)),
                completion_tokens=int(usage.get("completion_tokens", 0)),
            )
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
