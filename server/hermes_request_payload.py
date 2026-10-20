"""Assemble the existing Hermes HTTP request body, without transport or sessions."""

from collections.abc import Callable
from typing import Any


def build_payload(
    mission: str, cfg: dict[str, Any], working_dir: str | None, city_id: str,
    eff_model: str, eff_provider: str, *,
    is_quick_chat_message: Callable[[str], bool],
    spatial_context_block: Callable[[str, str | None], str],
) -> dict[str, Any]:
    quick_chat = is_quick_chat_message(mission)
    spatial = spatial_context_block(city_id, working_dir)
    system_content = cfg.get("system", "Eres un agente util.") + spatial
    if quick_chat:
        system_content += (
            "\nRespuesta rápida de chat: responde de forma directa y breve sin invocar "
            "herramientas salvo que el usuario lo pida explícitamente."
        )
    user_content: str
    if working_dir and not quick_chat:
        user_content = f"cd {working_dir}\n\n{mission}"
    else:
        user_content = mission
    payload: dict[str, Any] = {
        "model": eff_model,
        "messages": [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ],
        "stream": False,
        "max_tokens": 1024 if quick_chat else 4096,
    }
    if quick_chat:
        payload["model_options"] = {"reasoning_effort": "low"}
    # Hermes gateway ignores bare `model` unless `provider` is also set (or
    # direct_model_requests is enabled upstream). Pair them when selected.
    if eff_provider:
        payload["provider"] = eff_provider
    if working_dir:
        payload["working_directory"] = working_dir
    return payload
