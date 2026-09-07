// ─── Hero bar roster — single source of truth ────────────────────────────────
// The bar draws these units, the number badges label these units, and the 1–9 /
// Tab / Space hotkeys select from these units. Keeping two different lists is
// exactly how the badge on chip 3 ends up selecting a different agent than
// pressing "3" does: renderHeroBar filtered out ephemeral detachments while the
// hotkey handler indexed the unfiltered world, so one detached subagent shifted
// every number by one.
import type { GameState } from '../game.ts';
import type { Unit } from '../types.ts';

/** Chips drawn in the bar before the overflow chip takes over. Matches the 1–9
 *  selection hotkeys: every drawn chip has a reachable number. */
export const HERO_BAR_LIMIT = 9;

/** Every unit the hero bar represents. Ephemeral subagent detachments are drawn
 *  on the map and in the orden de batalla, never as their own hero chip. */
export function heroBarRoster(state: GameState): Unit[] {
  return state.getAllUnits().filter((u) => !u.ephemeral);
}

/** The slice actually drawn as chips — index i carries the badge `i + 1`. */
export function heroBarVisible(state: GameState): Unit[] {
  return heroBarRoster(state).slice(0, HERO_BAR_LIMIT);
}

/** How many roster units the overflow chip stands for (0 = no overflow chip). */
export function heroBarOverflowCount(state: GameState): number {
  return Math.max(0, heroBarRoster(state).length - HERO_BAR_LIMIT);
}
