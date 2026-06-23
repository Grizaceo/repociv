// ─── RepoCiv — Agent Capability Model (Fase 6) ────────────────────────────────
// Mirror of server/capabilities.py.
// UI uses this to filter context menus and show capability badges on units.

import type { CommandType } from './commandSchema.ts';

export type AgentBase = 'MAIN' | 'WORKER' | 'SCOUT' | 'OPENCLAW' | 'CLAUDE' | 'CODEX' | 'CURSOR';

const AGENT_BASE_ALIASES: Record<string, AgentBase> = {
  MAIN: 'MAIN',
  WORKER: 'WORKER',
  SCOUT: 'SCOUT',
  OPENCLAW: 'OPENCLAW',
  CLAUDE: 'CLAUDE',
  CODEX: 'CODEX',
  CURSOR: 'CURSOR',
};

function normalizeAgentBase(raw: string): AgentBase {
  const upper = raw.toUpperCase();
  return AGENT_BASE_ALIASES[upper] ?? 'MAIN';
}

// ─── Per-agent allowed command types ─────────────────────────────────────────
// MAIN's capabilities are not declared here — they are computed at runtime from
// the harness the user picked during onboarding. We expose an empty list so
// the UI can still look it up without throwing before the user finishes
// onboarding. See server/capabilities.py:capabilities_snapshot for the live view.
export const AGENT_CAPABILITIES: Record<AgentBase, CommandType[]> = {
  MAIN: [],
  WORKER: ['inspect_repo', 'read_file', 'run_tests', 'run_build', 'edit_file', 'create_branch'],
  SCOUT: ['inspect_repo', 'read_file'],
  OPENCLAW: ['inspect_repo', 'read_file', 'run_tests', 'run_build', 'execute_agent'],
  CLAUDE: [
    'inspect_repo',
    'read_file',
    'run_tests',
    'run_build',
    'edit_file',
    'create_branch',
    'git_commit',
    'execute_agent',
  ],
  CODEX: ['inspect_repo', 'read_file', 'run_tests', 'run_build', 'edit_file', 'create_branch'],
  CURSOR: [
    'inspect_repo',
    'read_file',
    'run_tests',
    'run_build',
    'edit_file',
    'create_branch',
    'git_commit',
    'execute_agent',
  ],
};

// ─── Skill labels shown as badges ────────────────────────────────────────────
// MAIN's skills are also empty until the harness is selected and the
// capabilities_snapshot endpoint returns live data.
export interface SkillBadge {
  key: string;
  label: string;
  icon: string;
}

export const AGENT_SKILLS: Record<AgentBase, SkillBadge[]> = {
  MAIN: [],
  WORKER: [
    { key: 'test_runner', label: 'Tests', icon: '🧪' },
    { key: 'code_editor', label: 'Edición', icon: '✏' },
  ],
  SCOUT: [{ key: 'inspection', label: 'Inspección', icon: '🔍' }],
  OPENCLAW: [
    { key: 'transport', label: 'Transporte', icon: '▶' },
    { key: 'orchestration', label: 'Orquestación', icon: '◈' },
    { key: 'test_runner', label: 'Tests', icon: '🧪' },
  ],
  CLAUDE: [
    { key: 'git_workflow', label: 'Git completo', icon: '⎇' },
    { key: 'test_runner', label: 'Tests', icon: '🧪' },
    { key: 'code_editor', label: 'Edición', icon: '✏' },
    { key: 'orchestration', label: 'Orquestación', icon: '◈' },
  ],
  CODEX: [
    { key: 'git_workflow', label: 'Git completo', icon: '⎇' },
    { key: 'test_runner', label: 'Tests', icon: '🧪' },
    { key: 'code_editor', label: 'Edición', icon: '✏' },
  ],
  CURSOR: [
    { key: 'git_workflow', label: 'Git completo', icon: '⎇' },
    { key: 'test_runner', label: 'Tests', icon: '🧪' },
    { key: 'code_editor', label: 'Edición', icon: '✏' },
    { key: 'orchestration', label: 'Orquestación', icon: '◈' },
  ],
};

// ─── Repo restriction patterns ────────────────────────────────────────────────
// If target contains a key, only the listed types are allowed.
const REPO_RESTRICTIONS: Record<string, CommandType[]> = {
  legal: ['inspect_repo', 'read_file'],
  vault: ['inspect_repo', 'read_file'],
  secrets: ['inspect_repo', 'read_file'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function agentBase(agentId: string): AgentBase {
  const raw = agentId.split('-')[0] ?? '';
  return normalizeAgentBase(raw);
}

export function agentCanDo(agentId: string, type: CommandType): boolean {
  return AGENT_CAPABILITIES[agentBase(agentId)].includes(type);
}

export function repoAllows(target: string, type: CommandType): boolean {
  for (const [fragment, allowed] of Object.entries(REPO_RESTRICTIONS)) {
    if (target.toLowerCase().includes(fragment)) {
      return (allowed as string[]).includes(type);
    }
  }
  return true;
}

export function canExecute(agentId: string, type: CommandType, target: string): boolean {
  return agentCanDo(agentId, type) && repoAllows(target, type);
}

export function getSkillBadges(agentId: string): SkillBadge[] {
  return AGENT_SKILLS[agentBase(agentId)] ?? [];
}
