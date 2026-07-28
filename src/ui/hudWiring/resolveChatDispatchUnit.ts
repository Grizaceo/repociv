import type { GameState } from '../../game.ts';
import type { Unit } from '../../types.ts';
import { getActiveChatUnit } from '../chat/state.ts';
import { isSidePanelOpen } from '../chat/panel.ts';

export interface ChatDispatchLookup {
  isPanelOpen?: () => boolean;
  activeChipUnitId?: () => string | null | undefined;
  activeChatUnitId?: () => string | null | undefined;
}

function readActiveChipUnitId(): string | null {
  const chip = document.querySelector<HTMLElement>('.chat-agent-chip.active');
  return chip?.dataset['unit']?.trim() || null;
}

/**
 * Resolve which unit chat should dispatch to.
 *
 * Priority (never silently collapse to board MAIN while a SCOUT chip is active):
 *  1. Active chip in the open side panel
 *  2. In-memory / persisted active chat unit
 *  3. Board-selected unit
 */
export function resolveChatDispatchUnitId(
  state: GameState,
  lookup: ChatDispatchLookup = {},
): string | null {
  const panelOpen = (lookup.isPanelOpen ?? isSidePanelOpen)();
  if (panelOpen) {
    const chipId = (lookup.activeChipUnitId ?? readActiveChipUnitId)()?.trim();
    if (chipId) return chipId;
  }

  const active = (lookup.activeChatUnitId ?? getActiveChatUnit)()?.trim();
  if (active) return active;

  return state.selectedUnit?.id ?? null;
}

/** Map a chat tab id (SCOUT) onto a living board unit (SCOUT / SCOUT-1 / type). */
export function findUnitForChatId(state: GameState, chatUnitId: string): Unit | undefined {
  const exact = state.getUnit(chatUnitId);
  if (exact) return exact;

  const upper = chatUnitId.toUpperCase();
  const all = state.getAllUnits();
  return (
    all.find((u) => u.id.toUpperCase() === upper) ??
    all.find((u) => u.id.toUpperCase().startsWith(`${upper}-`)) ??
    all.find((u) => u.type.toLowerCase() === chatUnitId.toLowerCase())
  );
}
