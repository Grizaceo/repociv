// ─── RepoCiv — Capability Badges (Fase 6) ─────────────────────────────────────
// Renders skill badges for the selected unit in the unit panel.

import { getSkillBadges } from '../agentCapabilities.ts';
import type { Unit } from '../types.ts';

const CONTAINER_ID = 'unit-capability-badges';

export function renderCapabilityBadges(unit: Unit): void {
  const container = document.getElementById(CONTAINER_ID);
  if (!container) return;

  const badges = getSkillBadges(unit.id);
  if (badges.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = badges
    .map((b) => `<span class="cap-badge" title="${b.label}">${b.icon} ${b.label}</span>`)
    .join('');
}

export function clearCapabilityBadges(): void {
  const container = document.getElementById(CONTAINER_ID);
  if (container) container.innerHTML = '';
}
