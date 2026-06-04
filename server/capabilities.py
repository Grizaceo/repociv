"""RepoCiv — Agent Capability Model (Fase 6).

Agents are contracts, not names.
  - Every agent has a declared set of CommandTypes it may execute.
  - Every repo can impose additional restrictions (e.g. legal/ = read-only).
  - Policy uses this to block commands before type-level decisions.
"""
from __future__ import annotations

from typing import Any

# ─── Agent capability declarations ───────────────────────────────────────────
# Ordered from broadest to most restricted.
AGENT_CAPABILITIES: dict[str, list[str]] = {
    # Orchestrator — can do everything policy allows
    "DAVI": [
        "inspect_repo", "read_file", "run_tests", "run_build",
        "edit_file", "create_branch", "git_commit",
        "execute_agent", "quest_add", "unit_command", "e2e_probe", "send_message",
    ],
    # Advisor — code-level ops only; no orchestration, no messaging
    "LEXO": [
        "inspect_repo", "read_file", "run_tests", "run_build",
        "edit_file", "create_branch", "git_commit",
    ],
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
SKILL_LABELS: dict[str, dict[str, str]] = {
    "DAVI": {
        "orchestration": "Orquestación",
        "git_workflow":  "Git completo",
        "test_runner":   "Tests",
        "code_editor":   "Edición",
        "messaging":     "Mensajería",
    },
    "LEXO": {
        "git_workflow": "Git completo",
        "test_runner":  "Tests",
        "code_editor":  "Edición",
    },
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
    """Normalize 'DAVI-2' -> 'DAVI', matching frontend agentBase()."""
    return agent_id.split("-")[0].upper()


_AGENT_BASE_ALIASES = {
    "DAVI": "DAVI",
    "LEXO": "LEXO",
    "WORKER": "WORKER",
    "SCOUT": "SCOUT",
    "OPENCLAW": "OPENCLAW",
    "CLAUDE": "CLAUDE",
    "CODEX": "CODEX",
    "CURSOR": "CURSOR",
}


def _normalize_agent_base(raw: str) -> str:
    upper = raw.upper()
    return _AGENT_BASE_ALIASES.get(upper, "DAVI")


def agent_capabilities(agent_id: str) -> list[str]:
    """Return capability list for an agent (falls back to DAVI if unknown)."""
    base = _normalize_agent_base(agent_id.split("-")[0])
    return AGENT_CAPABILITIES.get(base, AGENT_CAPABILITIES["DAVI"])


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
    return {
        "agents": {
            agent: {
                "capabilities": caps,
                "skills": list(SKILL_LABELS.get(agent, {}).keys()),
                "skillLabels": SKILL_LABELS.get(agent, {}),
            }
            for agent, caps in AGENT_CAPABILITIES.items()
        },
        "repoRestrictions": REPO_RESTRICTIONS,
        "skillRequirements": SKILL_REQUIREMENTS,
    }
