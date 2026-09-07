import { describe, it, expect } from 'vitest';
import {
  HERO_BAR_LIMIT,
  heroBarRoster,
  heroBarVisible,
  heroBarOverflowCount,
} from './heroBarUnits.ts';
import type { GameState } from '../game.ts';
import type { Unit } from '../types.ts';

function unit(id: string, extra: Partial<Unit> = {}): Unit {
  return { id, name: id, ephemeral: false, ...extra } as Unit;
}

/** The selectors only ever read getAllUnits(), so a stub is the whole surface. */
function stateWith(units: Unit[]): GameState {
  return { getAllUnits: () => units } as unknown as GameState;
}

describe('heroBarUnits', () => {
  it('drops ephemeral subagent detachments from the roster', () => {
    const state = stateWith([unit('MAIN'), unit('sub-1', { ephemeral: true }), unit('WORKER-1')]);
    expect(heroBarRoster(state).map((u) => u.id)).toEqual(['MAIN', 'WORKER-1']);
  });

  // The regression this file exists for: renderHeroBar numbered a filtered list
  // while the 1–9 hotkeys indexed the unfiltered world, so one detachment made
  // the badge on a chip select the agent next to it.
  it('numbers chips the same way the hotkeys index them', () => {
    const state = stateWith([
      unit('MAIN'),
      unit('sub-1', { ephemeral: true }),
      unit('WORKER-1'),
      unit('sub-2', { ephemeral: true }),
      unit('SCOUT-1'),
    ]);
    const visible = heroBarVisible(state);
    // Badge "3" is index 2 for both the renderer and the hotkey handler.
    expect(visible[2]?.id).toBe('SCOUT-1');
    expect(visible.map((u) => u.id)).toEqual(['MAIN', 'WORKER-1', 'SCOUT-1']);
  });

  it('caps the drawn chips at the limit and counts the rest as overflow', () => {
    const many = Array.from({ length: HERO_BAR_LIMIT + 3 }, (_, i) => unit(`U${i}`));
    const state = stateWith(many);
    expect(heroBarVisible(state)).toHaveLength(HERO_BAR_LIMIT);
    expect(heroBarOverflowCount(state)).toBe(3);
  });

  it('reports no overflow while everyone fits', () => {
    const state = stateWith([unit('MAIN'), unit('WORKER-1')]);
    expect(heroBarOverflowCount(state)).toBe(0);
  });

  it('does not count ephemeral units toward overflow', () => {
    const units = [
      ...Array.from({ length: HERO_BAR_LIMIT }, (_, i) => unit(`U${i}`)),
      ...Array.from({ length: 4 }, (_, i) => unit(`sub-${i}`, { ephemeral: true })),
    ];
    expect(heroBarOverflowCount(stateWith(units))).toBe(0);
  });

  it('gives every drawn chip a reachable 1–9 number', () => {
    expect(HERO_BAR_LIMIT).toBeLessThanOrEqual(9);
  });
});
