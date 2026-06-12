// ─── RepoCiv — Agent Capability Model (Fase 6) ────────────────────────────────
// Source of truth is the bridge snapshot at /api/agents/capabilities (see
// capabilitiesClient.ts). TS never hardcodes capability tables — that drift
// caused the PR 1+3 contract breakage. The mirror is now data-driven.

import type { CommandType } from './commandSchema.ts';
import { getCapabilitiesSnapshot, type CapabilitiesSnapshot } from './capabilitiesClient.ts';

/**
 * Normalize a profile name for lookup. The base of a unit id (the part
 * before any `-N` suffix) is the profile name the user registered. We
 * uppercase for case-insensitive matching; the snapshot may store names
 * in the case the user registered them, so we do a case-insensitive walk.
 */
function lookupAgent(agentId: string, snap: CapabilitiesSnapshot) {
  const base = agentId.split('-')[0] ?? '';
  if (snap.agents[base]) return snap.agents[base];
  const upper = base.toUpperCase();
  for (const [key, val] of Object.entries(snap.agents)) {
    if (key.toUpperCase() === upper) return val;
  }
  return undefined;
}

export function agentBase(agentId: string): string {
  return agentId.split('-')[0] ?? '';
}

export function agentCanDo(agentId: string, type: CommandType): boolean {
  const snap = getCapabilitiesSnapshot();
  if (snap.__testAnyAgent) return true;
  const entry = lookupAgent(agentId, snap);
  if (!entry) return false;
  return entry.capabilities.includes(type);
}

export function repoAllows(target: string, type: CommandType): boolean {
  const restrictions = getCapabilitiesSnapshot().repoRestrictions;
  for (const [fragment, allowed] of Object.entries(restrictions)) {
    if (target.toLowerCase().includes(fragment)) {
      return (allowed as string[]).includes(type);
    }
  }
  return true;
}

export function canExecute(agentId: string, type: CommandType, target: string): boolean {
  return agentCanDo(agentId, type) && repoAllows(target, type);
}

export interface SkillBadge {
  key: string;
  label: string;
  icon: string;
}

// Icons mirror server/capabilities.py:SKILL_LABELS shape; the snapshot only
// carries the label text. We add a small icon map here for UI rendering.
const SKILL_ICONS: Record<string, string> = {
  git_workflow: '⎇',
  test_runner: '🧪',
  code_editor: '✏',
  orchestration: '◈',
  messaging: '✉',
  inspection: '🔍',
  transport: '▶',
};

export function getSkillBadges(agentId: string): SkillBadge[] {
  const snap = getCapabilitiesSnapshot();
  if (snap.__testAnyAgent) return [];
  const entry = lookupAgent(agentId, snap);
  if (!entry) return [];
  return entry.skills.map((key) => ({
    key,
    label: entry.skillLabels[key] ?? key,
    icon: SKILL_ICONS[key] ?? '•',
  }));
}
