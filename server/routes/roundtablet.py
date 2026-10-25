"""RepoCiv — RoundTablet routes.

Bot Mode para RepoCiv: cada perfil de Hermes y cada harness externo
(claude, codex, cursor, opencode) es un bot que puede sentarse
en la mesa redonda y deliberar sobre un tema.

Endpoints:
  GET  /api/roundtablet/bots   — lista de bots disponibles (roster + harnesses)
  POST /api/roundtablet/round  — ejecuta una ronda: cada bot responde en orden
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from server import agent_runner as _agent_runner
from server import event_store as _es
from server.sse_server import send_to_repociv
from server import profile_identity as _pi  # type: ignore

CITY_ID = "roundtablet"
_HERMES_ROOT = Path.home() / ".hermes"

# Harnesses externos que son bots de RoundTablet (CLI-based, sin perfil de Hermes).
# Cada unit_id debe rutar a un adapter real en default_agent_runtime(); "devin"
# quedó fuera porque no existe devin-local en harness-registry — caía al cascade
# y corría como hermes genérico con una etiqueta que mentía.
_EXTERNAL_BOTS: dict[str, dict[str, str]] = {
    "claude":   {"unit_id": "CLAUDE",   "harness": "claude",   "label": "Claude Code",   "domain": "ingeniería de software"},
    "codex":    {"unit_id": "CODEX",    "harness": "codex",    "label": "Codex",         "domain": "programación asistida"},
    "cursor":   {"unit_id": "CURSOR",   "harness": "cursor",   "label": "Cursor",        "domain": "edición y refactorización"},
    "opencode": {"unit_id": "OPENCODE", "harness": "opencode", "label": "OpenCode",      "domain": "agente autónomo CLI"},
    "openclaw": {"unit_id": "OPENCLAW", "harness": "openclaw", "label": "OpenClaw",      "domain": "agente autónomo CLI"},
}

_PROFILES_DIR = _HERMES_ROOT / "profiles"

# Solo una ronda a la vez: cada bot ejecuta run_agent() de forma síncrona y
# solapar dos rondas mezclaría los transcripts de ambas sobre el mismo SSE.
_round_lock = threading.Lock()


def _list_hermes_bots() -> list[dict[str, Any]]:
    """Lista perfiles de Hermes como bots, reusando la lógica de roster."""
    names = [n for n in _pi.list_harness_options("hermes") if not n.startswith(".")]
    bots: list[dict[str, Any]] = []
    for name in names:
        avatar_url = None
        pet_detail = None
        pet_dir = _PROFILES_DIR / name / "pets"
        if pet_dir.is_dir():
            pet_ids = sorted(p.parent.name for p in pet_dir.glob("*/pet.json"))
            if pet_ids:
                canon = pet_ids[0]
                pj = pet_dir / canon / "pet.json"
                try:
                    meta = json.loads(pj.read_text())
                except Exception:
                    meta = {}
                pet_detail = {
                    "id": meta.get("id") or canon,
                    "displayName": meta.get("displayName", canon),
                    "description": meta.get("description", ""),
                }
                avatar_url = f"/api/roster/asset/{name}/pet/{canon}.webp"
        if not avatar_url and (_PROFILES_DIR / name / "assets" / "avatar.png").is_file():
            avatar_url = f"/api/roster/asset/{name}/avatar.png"
        bots.append({
            "id": f"hermes:{name}",
            "name": name,
            "type": "hermes_profile",
            "harness": "hermes",
            "unit_id": name.upper(),
            "profile": str(_PROFILES_DIR / name),
            "label": name.replace("-", " ").title(),
            "domain": "deliberación general",
            "is_bot": True,
            "avatar_url": avatar_url,
            "pet": pet_detail,
        })
    return bots


def _list_external_bots() -> list[dict[str, Any]]:
    """Lista harnesses externos como bots de RoundTablet."""
    bots: list[dict[str, Any]] = []
    for key, info in _EXTERNAL_BOTS.items():
        bots.append({
            "id": f"external:{key}",
            "name": key,
            "type": "external_harness",
            "harness": info["harness"],
            "unit_id": info["unit_id"],
            "profile": "",
            "label": info["label"],
            "domain": info["domain"],
            "is_bot": True,
            "avatar_url": None,
            "pet": None,
        })
    return bots


def get_roundtablet_bots(_ctx: dict[str, Any]) -> tuple[int, Any]:
    """GET /api/roundtablet/bots — todos los bots disponibles para la mesa."""
    hermes_bots = _list_hermes_bots()
    external_bots = _list_external_bots()
    return 200, {"bots": hermes_bots + external_bots}


def _turn_transcript(command_id: str, since: float) -> str:
    """Texto completo que un bot emitió en su turno (para dárselo al siguiente)."""
    chunks = [
        str(evt["data"].get("text", ""))
        for evt in _es.read_events(since=since, limit=1000)
        if evt.get("type") == "AgentOutputChunk" and evt.get("commandId") == command_id
    ]
    return "".join(chunks).strip()


def _run_bot(
    bot: dict[str, Any], mission: str, round_id: str, turn: int,
    city_id: str, repo_path: str,
) -> None:
    """Ejecuta un solo bot en la ronda, grabando en el event store."""
    unit_id = bot["unit_id"]
    harness = bot["harness"]
    profile = bot.get("profile") or ""

    command_id = f"{round_id}-turn{turn}-{bot['id'].replace(':', '-')}"

    # Mensaje de inicio del turno en el transcript.
    send_to_repociv({
        "type": "chat_chunk",
        "unit": unit_id,
        "missionId": command_id,
        "text": f"[{bot['label']} / {bot['domain']}]\n",
    })
    _es.record_output_chunk(command_id, unit_id, f"[{bot['label']} / {bot['domain']}]\n")

    _agent_runner.run_agent(
        unit_id=unit_id,
        city_id=city_id,
        mission=mission,
        command_id=command_id,
        harness=harness,
        profile=profile,
        repo_path=repo_path,
        agent_type="roundtablet",
    )


def _run_round(
    round_id: str, topic: str, bot_ids: list[str], started_at: float,
    city_id: str, repo_path: str,
) -> None:
    """Worker de la ronda: corre en background para no bloquear el POST."""
    all_bots = {b["id"]: b for b in _list_hermes_bots() + _list_external_bots()}
    prior_turns: list[str] = []

    try:
        for turn, bot_id in enumerate(bot_ids, start=1):
            bot = all_bots.get(bot_id)
            if bot is None:
                send_to_repociv({
                    "type": "chat_chunk",
                    "unit": "system",
                    "missionId": f"{round_id}-turn{turn}",
                    "text": f"[bot desconocido: {bot_id}]\n",
                })
                continue

            mission = (
                f"Eres el bot '{bot['label']}' ({bot['domain']}) en una mesa redonda de RepoCiv. "
                f"Tema de la ronda: {topic}\n\n"
                f"Responde como este bot, con su propia voz y dominio. "
                f"Mantén tu respuesta concisa y dirigida al tema."
            )
            if prior_turns:
                mission += (
                    "\n\nTurnos previos de esta ronda:\n"
                    + "\n\n".join(prior_turns)
                    + "\n\nPuedes referirte a esas respuestas al argumentar."
                )

            turn_started = time.time()
            command_id = f"{round_id}-turn{turn}-{bot_id.replace(':', '-')}"
            try:
                _run_bot(bot, mission, round_id, turn, city_id, repo_path)
            except Exception as exc:  # noqa: BLE001 — nunca detener la ronda por un bot
                error_text = f"[error en {bot['label']}: {exc}]\n"
                send_to_repociv({
                    "type": "chat_chunk",
                    "unit": bot["unit_id"],
                    "missionId": f"{round_id}-turn{turn}",
                    "text": error_text,
                })
                _es.record_output_chunk(f"{round_id}-turn{turn}", bot["unit_id"], error_text)

            transcript = _turn_transcript(command_id, turn_started)
            if transcript:
                prior_turns.append(f"— {bot['label']}:\n{transcript}")
    finally:
        finished_at = time.time()
        payload = {
            "roundId": round_id,
            "topic": topic,
            "botIds": bot_ids,
            "finishedAt": finished_at,
            "duration": finished_at - started_at,
        }
        _es.record_event("RoundTabletRoundCompleted", payload)
        # El frontend escucha este tipo por SSE para reactivar el botón.
        send_to_repociv({"type": "RoundTabletRoundCompleted", **payload})
        _round_lock.release()


def post_roundtablet_round(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/roundtablet/round — lanza una ronda de deliberación.

    Body:
      { "topic": str, "botIds": string[] }

    Devuelve el roundId de inmediato y corre la ronda en un thread: cada bot
    toma minutos en responder y el transcript viaja por SSE /events mientras
    se produce (grabado también como AgentOutputChunk en el event store).
    """
    topic = body.get("topic")
    bot_ids = body.get("botIds")
    city_id = body.get("cityId") if isinstance(body.get("cityId"), str) else ""
    repo_path = body.get("repoPath") if isinstance(body.get("repoPath"), str) else ""

    if not isinstance(topic, str) or not topic.strip():
        return 400, {"error": "topic is required"}
    if not isinstance(bot_ids, list) or not bot_ids:
        return 400, {"error": "botIds must be a non-empty list"}

    if not _round_lock.acquire(blocking=False):
        return 409, {"error": "ya hay una ronda en curso"}

    try:
        round_id = str(uuid.uuid4())[:8]
        started_at = time.time()

        # Registro del evento de inicio de ronda.
        _es.record_event("RoundTabletRoundStarted", {
            "roundId": round_id,
            "topic": topic.strip(),
            "botIds": bot_ids,
            "startedAt": started_at,
        })

        thread = threading.Thread(
            target=_run_round,
            args=(round_id, topic.strip(), bot_ids, started_at, city_id, repo_path),
            name=f"roundtablet-{round_id}",
            daemon=True,
        )
        thread.start()
    except Exception:
        _round_lock.release()
        raise

    return 200, {"ok": True, "roundId": round_id, "turns": len(bot_ids)}
