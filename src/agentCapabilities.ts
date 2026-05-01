// ─── RepoCiv — Agent Capability Model (Fase 6) ────────────────────────────────
// Mirror of server/capabilities.py.
// UI uses this to filter context menus and show capability badges on units.

import type { CommandType } from './commandSchema.ts';

export type AgentBase = 'DAVI' | 'LEXO' | 'WORKER' | 'SCOUT' | 'OPENCLAW';

// ─── Per-agent allowed command types ─────────────────────────────────────────
export const AGENT_CAPABILITIES: Record<AgentBase, CommandType[]> = {
  DAVI: [
    'inspect_repo',
    'read_file',
    'run_tests',
    'run_build',
    'edit_file',
    'create_branch',
    'git_commit',
    'execute_agent',
    'quest_add',
    'unit_command',
    'e2e_probe',
    'send_message',
  ],
  LEXO: [
    'inspect_repo',
    'read_file',
    'run_tests',
    'run_build',
    'edit_file',
    'create_branch',
    'git_commit',
  ],
  WORKER: ['inspect_repo', 'read_file', 'run_tests', 'run_build', 'edit_file', 'create_branch'],
  SCOUT: ['inspect_repo', 'read_file'],
  OPENCLAW: ['inspect_repo', 'read_file', 'run_tests', 'run_build', 'execute_agent'],
};

// ─── Skill labels shown as badges ────────────────────────────────────────────
export interface SkillBadge {
  key: string;
  label: string;
  icon: string;
}

export const AGENT_SKILLS: Record<AgentBase, SkillBadge[]> = {
  DAVI: [
    { key: 'orchestration', label: 'Orquestación', icon: '◈' },
    { key: 'git_workflow', label: 'Git completo', icon: '⎇' },
    { key: 'test_runner', label: 'Tests', icon: '🧪' },
    { key: 'code_editor', label: 'Edición', icon: '✏' },
    { key: 'messaging', label: 'Mensajería', icon: '✉' },
  ],
  LEXO: [
    { key: 'git_workflow', label: 'Git completo', icon: '⎇' },
    { key: 'test_runner', label: 'Tests', icon: '🧪' },
    { key: 'code_editor', label: 'Edición', icon: '✏' },
  ],
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
  const b = agentId.split('-')[0]!.toUpperCase();
  return b in AGENT_CAPABILITIES ? (b as AgentBase) : 'DAVI';
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
