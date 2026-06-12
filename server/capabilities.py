"""RepoCiv — Agent Capability Model (Fase 6).

Capability is keyed by HARNESS, not by user-chosen profile name. A
profile's name is just a label; the harness is the engine that decides
what command types it can execute. The user's MAIN profile inherits
its capabilities from its configured harness (see server/agent_runner).

This module is the shipped capability table. Per-profile overrides
(personality, system_prompt) live in config_store and are merged in
at runtime by _get_agent_config().
"""
from __future__ import annotations

from typing import Any

# ─── Agent capability declarations (keyed by harness) ───────────────────────
#
# The harness name is the key, NOT a user-chosen profile name. A user
# can register any number of profiles against the same harness; all of
# them share this capability set.
#
# To add a new capability: add it to the relevant harness entry AND
# to CommandType in commandSchema.ts (if it's a new command type).
AGENT_CAPABILITIES: dict[str, list[str]] = {
    "hermes": [
        # Hermes is the orchestrator: full coding agent via hermes CLI,
        # all the bells and whistles.
        "inspect_repo", "read_file", "run_tests", "run_build",
        "edit_file", "create_branch", "git_commit",
        "execute_agent", "quest_add", "unit_command", "e2e_probe",
        "send_message",
    ],
    "claude": [
        "inspect_repo", "read_file", "run_tests", "run_build",
        "edit_file", "create_branch", "git_commit", "execute_agent",
    ],
    "codex": [
        "inspect_repo", "read_file", "run_tests", "run_build",
        "edit_file", "create_branch",
    ],
    "cursor": [
        "inspect_repo", "read_file", "run_tests", "run_build",
        "edit_file", "create_branch", "git_commit", "execute_agent",
    ],
    "openclaw": [
        "inspect_repo", "read_file", "run_tests", "run_build",
        "execute_agent",
    ],
}

# ─── Skill labels (human-readable, shown in UI badges) ───────────────────────
SKILL_LABELS: dict[str, dict[str, str]] = {
    "hermes": {
        "orchestration": "Orquestación",
        "git_workflow":  "Git completo",
        "test_runner":   "Tests",
        "code_editor":   "Edición",
        "messaging":     "Mensajería",
    },
    "claude": {
        "git_workflow":  "Git completo",
        "test_runner":   "Tests",
        "code_editor":   "Edición",
        "orchestration": "Orquestación",
    },
    "codex": {
        "git_workflow": "Git completo",
        "test_runner":  "Tests",
        "code_editor":  "Edición",
    },
    "cursor": {
        "git_workflow":  "Git completo",
        "test_runner":   "Tests",
        "code_editor":   "Edición",
        "orchestration": "Orquestación",
    },
    "openclaw": {
        "transport":     "Transporte",
        "orchestration": "Orquestación",
        "test_runner":    "Tests",
    },
}

# ─── Repo-level restrictions (path fragment → allowed types only) ─────────────
# Keys are substrings matched against the command target / city id.
REPO_RESTRICTIONS: dict[str, list[str]] = {
    "legal":  ["inspect_repo", "read_file"],
    "vault":  ["inspect_repo", "read_file"],
    "secrets": ["inspect_repo", "read_file"],
}

# ─── Skill → required command type ───────────────────────────────────────────
SKILL_REQUIREMENTS: dict[str, str] = {
    "git_workflow":  "git_commit",
    "test_runner":   "run_tests",
    "code_editor":   "edit_file",
    "orchestration": "execute_agent",
    "messaging":     "send_message",
    "inspection":    "inspect_repo",
    "transport":     "execute_agent",
}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _harness_for_profile(profile_name: str) -> str:
    """Look up the harness for a profile name. Falls back to the profile
    name itself (assumed to be a harness id) if no profile is registered.
    """
    try:
        from . import config_store as _cs  # local import — avoid cycles
        profile = _cs.get_profile(profile_name.upper())
        if profile is not None and "harness" in profile:
            return profile["harness"].lower()
    except Exception:
        pass
    return profile_name.lower()


def agent_capabilities(agent_id: str) -> list[str]:
    """Return capability list for an agent, looked up by harness.

    agent_id is the unit's full id (e.g. "H-1", "claude-2", or
    "WORKER" if a legacy caller passes a plain base). The function
    strips the suffix and resolves to a harness via the profile
    registry.
    """
    base = agent_id.split("-")[0].upper()
    harness = _harness_for_profile(base)
    return list(AGENT_CAPABILITIES.get(harness, []))


def can_execute(agent_id: str, cmd_type: str) -> bool:
    """Return True if the agent can execute the given command type."""
    return cmd_type in agent_capabilities(agent_id)


def repo_allows(target: str, cmd_type: str) -> bool:
    """Return True if the repo target does not restrict the command type."""
    for fragment, allowed in REPO_RESTRICTIONS.items():
        if fragment in target.lower():
            return cmd_type in allowed
    return True


def check_capability(agent_id: str, cmd_type: str, target: str) -> tuple[bool, str]:
    """
    Return (allowed: bool, reason: str).
    Checks agent capability then repo restrictions.
    """
    if not can_execute(agent_id, cmd_type):
        caps = agent_capabilities(agent_id)
        return False, (
            f"Agente {agent_id} no tiene capacidad '{cmd_type}'. "
            f"Capacidades: {', '.join(caps)}"
        )
    if not repo_allows(target, cmd_type):
        for fragment, allowed in REPO_RESTRICTIONS.items():
            if fragment in target.lower():
                return False, (
                    f"Repo '{target}' restringido: solo permite {', '.join(allowed)}"
                )
    return True, ""


def capabilities_snapshot() -> dict[str, Any]:
    """Full capability model for GET /agents/capabilities.

    Returns one entry per built-in harness. The "MAIN" entry is the
    user's first profile's capabilities (resolved from the registry);
    other profiles are listed separately if they exist.
    """
    agents_out: dict[str, dict[str, Any]] = {}
    for harness, caps in AGENT_CAPABILITIES.items():
        agents_out[harness] = {
            "capabilities": caps,
            "skills": list(SKILL_LABELS.get(harness, {}).keys()),
            "skillLabels": SKILL_LABELS.get(harness, {}),
        }
    # Surface the user's registered profiles so the UI can show each
    # profile's effective capabilities (per-profile overrides merged on top).
    try:
        from . import config_store as _cs
        for name, profile in _cs.list_profiles().items():
            harness = profile.get("harness", name).lower()
            base_caps = list(AGENT_CAPABILITIES.get(harness, []))
            agents_out[name] = {
                "capabilities": base_caps,
                "skills": list(SKILL_LABELS.get(harness, {}).keys()),
                "skillLabels": SKILL_LABELS.get(harness, {}),
                "harness": harness,
                "isProfile": True,
            }
    except Exception:
        pass
    return {
        "agents": agents_out,
        "repoRestrictions": REPO_RESTRICTIONS,
        "skillRequirements": SKILL_REQUIREMENTS,
    }
