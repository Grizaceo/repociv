import type { AgentDockItem } from './agentDock.ts';

export interface SessionLauncherSummary {
  total: number;
  active: number;
  focus: AgentDockItem | null;
}

const isActive = (item: AgentDockItem): boolean =>
  item.kind === 'external' || ['working', 'moving', 'building'].includes(item.state);

/**
 * Reduce the complete session dock to the one context a compact launcher can
 * show without competing with F8's canonical list.
 */
export const sessionLauncherSummary = (
  items: readonly AgentDockItem[],
  selectedOwnUnitId: string | null,
): SessionLauncherSummary => {
  const selected = selectedOwnUnitId
    ? items.find((item) => item.kind === 'own' && item.key === selectedOwnUnitId) ?? null
    : null;
  const activeItems = items.filter(isActive);

  return {
    total: items.length,
    active: activeItems.length,
    focus: selected ?? activeItems[0] ?? items[0] ?? null,
  };
};
