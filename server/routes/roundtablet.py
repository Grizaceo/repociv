"""RepoCiv — RoundTablet routes.

Bot Mode para RepoCiv: cada perfil de Hermes y cada harness externo
(claude, codex, cursor, opencode, devin) es un bot que puede sentarse
en la mesa redonda y deliberar sobre un tema.

Endpoints:
  GET  /api/roundtablet/bots   — lista de bots disponibles (roster + harnesses)
  POST /api/roundtablet/round  — ejecuta una ronda: cada bot responde en orden
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any

from server import agent_runner as _agent_runner
from server import event_store as _es
from server.agent_runner import send_to_repociv  # type: ignore
from server import profile_identity as _pi  # type: ignore

CITY_ID = "roundtablet"
_HERMES_ROOT = Path.home() / ".hermes"

# Harnesses externos que son bots de RoundTablet (CLI-based, sin perfil de Hermes).
_EXTERNAL_BOTS: dict[str, dict[str, str]] = {
    "claude":   {"unit_id": "CLAUDE",   "harness": "claude",   "label": "Claude Code",   "domain": "ingeniería de software"},
    "codex":    {"unit_id": "CODEX",    "harness": "codex",    "label": "Codex",         "domain": "programación asistida"},
    "cursor":   {"unit_id": "CURSOR",   "harness": "cursor",   "label": "Cursor",        "domain": "edición y refactorización"},
    "opencode": {"unit_id": "OPENCODE", "harness": "opencode", "label": "OpenCode",      "domain": "agente autónomo CLI"},
    "devin":    {"unit_id": "DEVIN",    "harness": "devin",    "label": "Devin",         "domain": "ingeniería de software autónoma"},
}

_PROFILES_DIR = _HERMES_ROOT / "profiles"


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


def _run_bot(bot: dict[str, Any], mission: str, round_id: str, turn: int) -> None:
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
        "text": f"[{bot['label']} / {bot['domain']}]\\n",
    })
    _es.record_output_chunk(command_id, unit_id, f"[{bot['label']} / {bot['domain']}]\\n")

    _agent_runner.run_agent(
        unit_id=unit_id,
        city_id=CITY_ID,
        mission=mission,
        command_id=command_id,
        harness=harness,
        profile=profile,
        agent_type="roundtablet",
    )


def post_roundtablet_round(body: dict[str, Any], _ctx: dict[str, Any]) -> tuple[int, Any]:
    """POST /api/roundtablet/round — ejecuta una ronda de deliberación.

    Body:
      { "topic": str, "botIds": string[] }

    Ejecuta cada bot en orden, grabando cada respuesta como AgentOutputChunk
    en el event store. El frontend lee el transcript vía SSE /events.
    """
    topic = body.get("topic", "").strip()
    bot_ids = body.get("botIds", [])

    if not topic:
        return 400, {"error": "topic is required"}
    if not isinstance(bot_ids, list) or not bot_ids:
        return 400, {"error": "botIds must be a non-empty list"}

    round_id = str(uuid.uuid4())[:8]
    started_at = time.time()

    # Registro del evento de inicio de ronda.
    _es.record_event("RoundTabletRoundStarted", {
        "roundId": round_id,
        "topic": topic,
        "botIds": bot_ids,
        "startedAt": started_at,
    })

    # Cargar catálogo de bots.
    all_bots = {b["id"]: b for b in _list_hermes_bots() + _list_external_bots()}

    for turn, bot_id in enumerate(bot_ids, start=1):
        bot = all_bots.get(bot_id)
        if bot is None:
            send_to_repociv({
                "type": "chat_chunk",
                "unit": "system",
                "missionId": f"{round_id}-turn{turn}",
                "text": f"[bot desconocido: {bot_id}]\\n",
            })
            continue

        mission = (
            f"Eres el bot '{bot['label']}' ({bot['domain']}) en una mesa redonda de RepoCiv. "
            f"Tema de la ronda: {topic}\\n\\n"
            f"Responde como este bot, con su propia voz y dominio. "
            f"Mantén tu respuesta concisa y dirigida al tema. "
            f"Si hay respuestas previas de otros bots en esta ronda, puedes referirte a ellas."
        )
        try:
            _run_bot(bot, mission, round_id, turn)
        except Exception as exc:  # noqa: BLE001 — nunca detener la ronda por un bot
            error_text = f"[error en {bot['label']}: {exc}]\\n"
            send_to_repociv({
                "type": "chat_chunk",
                "unit": bot["unit_id"],
                "missionId": f"{round_id}-turn{turn}",
                "text": error_text,
            })
            _es.record_output_chunk(f"{round_id}-turn{turn}", bot["unit_id"], error_text)

    _es.record_event("RoundTabletRoundCompleted", {
        "roundId": round_id,
        "topic": topic,
        "botIds": bot_ids,
        "finishedAt": time.time(),
        "duration": time.time() - started_at,
    })

    return 200, {"ok": True, "roundId": round_id, "turns": len(bot_ids)}
