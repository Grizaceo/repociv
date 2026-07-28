import { describe, expect, it } from 'vitest';

import { findUnitForChatId, resolveChatDispatchUnitId } from './resolveChatDispatchUnit.ts';

describe('resolveChatDispatchUnitId', () => {
  it('prefers the active chip over board MAIN when the panel is open', () => {
    const state = {
      selectedUnit: { id: 'MAIN' },
    } as never;

    expect(
      resolveChatDispatchUnitId(state, {
        isPanelOpen: () => true,
        activeChipUnitId: () => 'SCOUT',
        activeChatUnitId: () => 'MAIN',
      }),
    ).toBe('SCOUT');
  });

  it('uses active chat unit when the panel is closed', () => {
    const state = {
      selectedUnit: { id: 'MAIN' },
    } as never;

    expect(
      resolveChatDispatchUnitId(state, {
        isPanelOpen: () => false,
        activeChatUnitId: () => 'WORKER',
      }),
    ).toBe('WORKER');
  });

  it('falls back to board selection last', () => {
    const state = {
      selectedUnit: { id: 'MAIN' },
    } as never;

    expect(
      resolveChatDispatchUnitId(state, {
        isPanelOpen: () => false,
        activeChatUnitId: () => null,
      }),
    ).toBe('MAIN');
  });
});

describe('findUnitForChatId', () => {
  it('matches SCOUT-1 when the chat tab is SCOUT', () => {
    const scout = { id: 'SCOUT-1', type: 'scout' };
    const state = {
      getUnit: (id: string) => (id === 'SCOUT-1' ? scout : undefined),
      getAllUnits: () => [scout],
    } as never;

    expect(findUnitForChatId(state, 'SCOUT')).toEqual(scout);
  });
});
