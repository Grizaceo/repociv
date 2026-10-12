"""Minimal, evidence-gated dispatch identity in the canonical Event Store.

A dispatch attempt is not proof of a spawned process or a successful execution.
Unit association comes from an exact canonical-session link, never a prefix.
Profile is the configured Hermes CLI home, not a provider/model/persona.
"""
from __future__ import annotations

import logging
import os
from typing import Any


def build_identity(*, command_id: str, command_type: str, harness: str,
                   unit_id: str = "", registry_profile: tuple[str, dict[str, Any]] | None = None,
                   config: dict[str, Any] | None = None,
                   canonical: dict[str, Any] | None = None,
                   provider: str = "", model: str = "") -> dict[str, Any]:
    data: dict[str, Any] = {"commandId": command_id, "commandType": command_type,
                            "harness": harness}
    # Registry entry was actually selected by _get_agent_config / identity overlay.
    # Generic routing slots and unknown prefixes are not agent identities.
    if registry_profile:
        display = registry_profile[1].get("display_name")
        if isinstance(display, str) and display.strip():
            data["agentName"] = display.strip()
    # Canonical sessions drive own-session re-materialization on the map.
    # MAIN is the generic slot; missing/mismatching records close conservatively.
    if unit_id and unit_id != "MAIN" and (canonical or {}).get("unitId") == unit_id:
        data["unitId"] = unit_id
        if data.get("agentName"):
            data["unitName"] = data["agentName"]
    # HTTP gateway, other CLIs and container execution do NOT load this Hermes home.
    if harness == "hermes-cli":
        path = (config or {}).get("profile")
        if isinstance(path, str) and path:
            name = os.path.basename(os.path.expanduser(path).rstrip("/"))
            if name:
                data["profileName"] = name
    for name, value in (("provider", provider), ("model", model)):
        if value and value.lower() != "auto":
            # Some runner branches pass the provider as the model fallback;
            # a model equal to the provider is not evidence of a chosen model.
            if name == "model" and value == provider:
                continue
            data[name] = value
    return data


def record(command_id: str, command_type: str, harness: str, unit_id: str,
           registry_profile: tuple[str, dict[str, Any]] | None, config: dict[str, Any] | None,
           provider: str = "", model: str = "", canonical: dict[str, Any] | None = None) -> None:
    from server import event_store
    data = build_identity(command_id=command_id, command_type=command_type, harness=harness,
                          unit_id=unit_id, registry_profile=registry_profile, config=config,
                          canonical=canonical, provider=provider, model=model)
    try:
        event_store.record_event("ExecutionIdentityRecorded", data, command_id=command_id)
    except OSError:
        logging.getLogger(__name__).warning("Execution identity unavailable")
