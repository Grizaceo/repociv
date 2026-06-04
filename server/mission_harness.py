"""Mission harness context for Swarm Civ passive subagent tracking."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Callable

# Passive Task detection + mid-flight progress by resolved harness
SWARM_CAPABILITIES: dict[str, dict[str, bool]] = {
    "cursor": {"passive_task": True, "progress_mid_flight": True},
    "claude-code": {"passive_task": True, "progress_mid_flight": True},
    "hermes-cli": {"passive_task": False, "progress_mid_flight": False},
    "hermes": {"passive_task": False, "progress_mid_flight": False},
    "openclaw": {"passive_task": False, "progress_mid_flight": False},
    "codex": {"passive_task": False, "progress_mid_flight": False},
    "container": {"passive_task": False, "progress_mid_flight": False},
}


@dataclass
class MissionHarnessContext:
    mission_id: str
    unit_id: str
    city_id: str
    resolved_harness: str
    provider: str = ""
    model: str = ""
    working_dir: str | None = None


def swarm_track_enabled() -> bool:
    """True unless REPOCIV_SWARM_TRACK=0 (alpha defaults on)."""
    return os.environ.get("REPOCIV_SWARM_TRACK", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def is_swarm_tracking_available(harness: str) -> bool:
    cap = SWARM_CAPABILITIES.get(harness, {})
    return bool(cap.get("passive_task"))


def swarm_tracking_label(harness: str) -> str:
    if is_swarm_tracking_available(harness):
        return "full"
    if harness in ("hermes-cli", "hermes"):
        return "limited"
    return "off"


def log_swarm_tracking_capability(
    send: Callable[[dict[str, Any]], None],
    harness: str,
) -> None:
    label = swarm_tracking_label(harness)
    if label == "full":
        return
    if label == "limited":
        send({
            "type": "log",
            "msg": (
                f"[swarm] tracking limitado para '{harness}' — "
                "subagentes internos pueden no ser visibles en Orden de batalla"
            ),
            "level": "info",
        })
        return
    send({
        "type": "log",
        "msg": (
            f"[swarm] tracking limitado para '{harness}' — "
            "sin parser Task pasivo"
        ),
        "level": "info",
    })
