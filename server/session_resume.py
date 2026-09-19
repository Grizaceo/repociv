"""How do I get back into this session?

The Agents panel is read-only, so the honest answer to "quiero seguir esta
conversación" is a command the user runs in their own terminal. This module
builds it — it never runs anything, the way ``server/recovery.py`` hands back a
copy-command instead of acting.

Three answers, and which one you get is the whole point:

  * ``resume`` — nothing is holding the session, so it can be picked up:
    ``claude --resume``, ``codex resume`` or ``hermes chat --resume``.
  * ``attached`` — a process still holds it (``server/session_liveness.py``).
    Resuming would open a second turn over the same state, which is exactly
    what Hermes' lease registry exists to prevent, so no command is offered.
  * ``unavailable`` — that agent's CLI has no resume this bridge knows how to
    spell, or the session predates the id we would need.

The command carries the session's ``cwd``, which polls deliberately never
broadcast: ``claude`` and ``codex`` find a session only from its own project
directory. It is the same on-demand exception the chat endpoint already makes,
and it happens only when the user asks for this one session.
"""

from __future__ import annotations

import os
import shlex
from typing import Any

# What each agent's CLI calls "pick that conversation back up". Hermes restores
# the session's own working directory (hence no cd); the other two resolve a
# session against the directory they are started in, so the cd is load-bearing.
_CLAUDE = "claude"
_CODEX = "codex"
_HERMES = "hermes"


def agent_family(agent: str) -> str:
    """`claude-code`, `openai-codex`, `hermes`… → the CLI that resumes it."""
    name = (agent or "").lower()
    if "claude" in name:
        return _CLAUDE
    if "codex" in name:
        return _CODEX
    if name == _HERMES:
        return _HERMES
    return ""


def hermes_profile_home(home: str, profile: str) -> str:
    """HERMES_HOME for a profile: the root itself for `default`, else its dir."""
    root = os.path.abspath(os.path.expanduser(home))
    return root if profile in ("", "default") else os.path.join(root, "profiles", profile)


def _command(family: str, native_id: str, cwd: str, hermes_home: str) -> str:
    quoted_id = shlex.quote(native_id)
    if family == _HERMES:
        return f"HERMES_HOME={shlex.quote(hermes_home)} hermes chat --resume {quoted_id}"
    verb = f"claude --resume {quoted_id}" if family == _CLAUDE else f"codex resume {quoted_id}"
    return f"cd {shlex.quote(cwd)} && {verb}" if cwd else verb


def plan(
    *,
    agent: str,
    native_id: str,
    cwd: str,
    profile: str = "",
    live: bool | None = None,
    hermes_home: str = "~/.hermes",
    ended: bool = False,
) -> dict[str, Any]:
    """The resume plan for one observed session. Pure; never touches the disk."""
    family = agent_family(agent)
    if not family or not native_id:
        return {
            "mode": "unavailable",
            "command": "",
            "agent": agent,
            "live": live,
            "note": (
                f"No sé cómo retomar una sesión de «{agent}» desde acá."
                if family == "" and agent
                else "Esta sesión no tiene un id que el CLI pueda retomar."
            ),
        }

    if live and not ended:
        return {
            "mode": "attached",
            "command": "",
            "agent": agent,
            "live": True,
            "note": (
                "Su proceso sigue vivo: la sesión está abierta en su terminal. "
                "Retomarla desde acá abriría un segundo turno sobre el mismo "
                "estado, que es justo lo que el arriendo de sesión evita."
            ),
        }

    home = hermes_profile_home(hermes_home, profile) if family == _HERMES else ""
    return {
        "mode": "resume",
        "command": _command(family, native_id, cwd, home),
        "agent": agent,
        "live": bool(live),
        "note": (
            "Pegá esto en una terminal. Hermes vuelve solo al directorio de la sesión."
            if family == _HERMES
            else "Pegá esto en una terminal: el CLI encuentra la sesión desde su propio directorio."
        ),
    }
