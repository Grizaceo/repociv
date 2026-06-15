"""RepoCiv — Agent Capability Model (Fase 6).

Agents are contracts, not names.
  - Every shipped built-in agent has a declared set of CommandTypes it may execute.
  - The user's first unit ("MAIN") has capabilities computed at runtime from
    the harness the user picked during onboarding — see config_store.get_default_harness.
  - Every repo can impose additional restrictions (e.g. legal/ = read-only).
  - Policy uses this to block commands before type-level decisions.
"""
from __future__ import annotations

from typing import Any

# ─── Agent capability declarations ───────────────────────────────────────────
# Ordered from broadest to most restricted.
#
# "MAIN" is the user's first unit. Its actual capabilities are not declared
# here; they are computed from the harness the user picked in onboarding.
# We expose it in the table as an empty list so the policy engine can still
# look it up without a KeyError before the user finishes onboarding.
AGENT_CAPABILITIES: dict[str, list[str]] = {
    "MAIN": [],  # populated at runtime from ~/.repociv/config.json::default_harness
    # Builder — edits and builds; no commit, no messaging, no orchestration
    "WORKER": [
        "inspect_repo", "read_file", "run_tests", "run_build",
        "edit_file", "create_branch",
    ],
    # Scout — read-only recon
    "SCOUT": [
        "inspect_repo", "read_file",
    ],
    # Transport / force — execution and transport, no editing
    "OPENCLAW": [
        "inspect_repo", "read_file", "run_tests", "run_build", "execute_agent",
    ],
    # Claude — full coding agent via claude-code CLI
    "CLAUDE": [
        "inspect_repo", "read_file", "run_tests", "run_build",
        "edit_file", "create_branch", "git_commit", "execute_agent",
    ],
    # Codex — coding agent via Codex CLI (initially conservative)
    "CODEX": [
        "inspect_repo", "read_file", "run_tests", "run_build",
        "edit_file", "create_branch",
    ],
    # Cursor — coding agent via cursor-agent CLI
    "CURSOR": [
        "inspect_repo", "read_file", "run_tests", "run_build",
        "edit_file", "create_branch", "git_commit", "execute_agent",
    ],
}

# ─── Skill labels (human-readable, shown in UI badges) ───────────────────────
# MAIN's skill labels are also empty until the harness is selected.
SKILL_LABELS: dict[str, dict[str, str]] = {
    "MAIN": {},
    "WORKER": {
        "test_runner": "Tests",
        "code_editor": "Edición",
    },
    "SCOUT": {
        "inspection": "Inspección",
    },
    "OPENCLAW": {
        "transport":    "Transporte",
        "orchestration": "Orquestación",
        "test_runner":   "Tests",
    },
    "CLAUDE": {
        "git_workflow":  "Git completo",
        "test_runner":   "Tests",
        "code_editor":   "Edición",
        "orchestration": "Orquestación",
    },
    "CODEX": {
        "git_workflow": "Git completo",
        "test_runner":  "Tests",
        "code_editor":  "Edición",
    },
    "CURSOR": {
        "git_workflow":  "Git completo",
        "test_runner":   "Tests",
        "code_editor":   "Edición",
        "orchestration": "Orquestación",
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


def _agent_base(agent_id: str) -> str:
    """Normalize 'MAIN-2' -> 'MAIN', matching frontend agentBase()."""
    return agent_id.split("-")[0].upper()


_AGENT_BASE_ALIASES = {
    "MAIN": "MAIN",
    "WORKER": "WORKER",
    "SCOUT": "SCOUT",
    "OPENCLAW": "OPENCLAW",
    "CLAUDE": "CLAUDE",
    "CODEX": "CODEX",
    "CURSOR": "CURSOR",
}


def _normalize_agent_base(raw: str) -> str:
    upper = raw.upper()
    return _AGENT_BASE_ALIASES.get(upper, "MAIN")


def _resolve_main_capabilities() -> list[str]:
    """Return MAIN's capabilities by reading the user's chosen harness.

    Falls back to an empty list if config_store is unavailable or the user
    hasn't picked a harness yet (i.e. onboarding not completed). PR 2 wires
    the onboarding step that writes default_harness to disk.
    """
    try:
        from . import config_store as _cs  # noqa: WPS433
        harness = _cs.get_default_harness()
    except Exception:
        return []
    if not harness:
        return []
    return list(AGENT_CAPABILITIES.get(harness.upper(), []))


def agent_capabilities(agent_id: str) -> list[str]:
    """Return capability list for an agent (falls back to MAIN if unknown)."""
    base = _normalize_agent_base(agent_id.split("-")[0])
    if base == "MAIN":
        return _resolve_main_capabilities()
    return AGENT_CAPABILITIES.get(base, AGENT_CAPABILITIES.get("MAIN", []))


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
    """Full capability model for GET /agents/capabilities."""
    # For MAIN, surface the live (harness-driven) capabilities so the UI
    # shows the right badges. If the user hasn't picked a harness yet, the
    # entry is exposed with empty arrays.
    agents_out: dict[str, dict[str, Any]] = {}
    for agent, caps in AGENT_CAPABILITIES.items():
        if agent == "MAIN":
            live_caps = _resolve_main_capabilities()
            agents_out[agent] = {
                "capabilities": live_caps,
                "skills": list(SKILL_LABELS.get(agent, {}).keys()),
                "skillLabels": SKILL_LABELS.get(agent, {}),
                "computedFromHarness": True,
            }
        else:
            agents_out[agent] = {
                "capabilities": caps,
                "skills": list(SKILL_LABELS.get(agent, {}).keys()),
                "skillLabels": SKILL_LABELS.get(agent, {}),
            }
    return {
        "agents": agents_out,
        "repoRestrictions": REPO_RESTRICTIONS,
        "skillRequirements": SKILL_REQUIREMENTS,
    }
