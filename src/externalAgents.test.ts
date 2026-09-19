import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  externalAgentEvents,
  fetchExternalAgents,
  isExternalAgentUnit,
  type ExternalAgentRow,
} from './externalAgents.ts';
import { GameState } from './game.ts';
import { dispatchBridgeEvent, type MessageContext } from './bridgeMessageHandlers.ts';
import { axialDistance } from './hex.ts';
import type { City, World } from './types.ts';

// ─── Minimal mocks (same seams as game.test.ts / bridge.test.ts) ─────────────
vi.mock('./ui/index.ts', () => ({
  logEvent: vi.fn(),
  appendChatChunk: vi.fn(),
  appendApprovalCard: vi.fn(),
  setBridgeStatus: vi.fn(),
  setOperationTicker: vi.fn(),
  updateGpuBar: vi.fn(),
  showNotification: vi.fn(),
}));
vi.mock('./pathfinding.ts', () => ({ aStarPath: vi.fn(() => []), invalidatePathCache: vi.fn() }));
vi.mock('./localPathfinding.ts', () => ({ findLocalPath: vi.fn(() => []) }));
vi.mock('./localWorldManager.ts', () => ({
  LocalWorldManager: class {
    viewMode = 'macro';
    getLocalUnits() {
      return [];
    }
    syncSubagentSpawn() {}
    removeSubagentUnit() {}
  },
}));

const REPOCIV = 'repo:L3cvcmVwb2Npdg';

function row(unit: string, extra: Partial<ExternalAgentRow> = {}): ExternalAgentRow {
  return {
    unit,
    unitType: 'claude',
    cityId: REPOCIV,
    state: 'working',
    mission: 'claude-code · claude-opus-5',
    ...extra,
  };
}

describe('externalAgentEvents', () => {
  it('spawns missing ext units and re-asserts state', () => {
    const events = externalAgentEvents(['MAIN'], [row('ext-claude-code-aaaaaaaa')]);
    expect(events).toEqual([
      {
        type: 'unit_spawn',
        unit: 'ext-claude-code-aaaaaaaa',
        civ: 'capital',
        hex: [0, 0],
        unitType: 'claude',
        mission: 'claude-code · claude-opus-5',
        cityId: REPOCIV,
        ephemeral: true,
      },
      { type: 'unit_state', unit: 'ext-claude-code-aaaaaaaa', state: 'working' },
    ]);
  });

  it('does not respawn units already on the map', () => {
    const events = externalAgentEvents(
      ['ext-codex-bbbbbbbb'],
      [row('ext-codex-bbbbbbbb', { unitType: 'codex', state: 'idle' })],
    );
    expect(events).toEqual([{ type: 'unit_state', unit: 'ext-codex-bbbbbbbb', state: 'idle' }]);
  });

  it('despawns ext units the tracker dropped, never touching other units', () => {
    const events = externalAgentEvents(['MAIN', 'SCOUT-sub-1', 'ext-cursor-cccccccc'], []);
    expect(events).toEqual([{ type: 'unit_despawn', unit: 'ext-cursor-cccccccc' }]);
  });

  it('ignores rows that are not ext units or do not validate', () => {
    const events = externalAgentEvents(
      [],
      [
        row('MAIN'),
        row('ext-x-1', { unitType: 'cursor' }), // not in the unitType picklist
        row('ext-x-2', { state: 'dancing' }),
        { unit: 42 } as unknown as ExternalAgentRow,
      ],
    );
    // ext-x-1's spawn fails validation, its state event is still valid; ext-x-2 spawns
    // but its bogus state is dropped.
    expect(events.map((e) => `${e.type}:${'unit' in e ? e.unit : ''}`)).toEqual([
      'unit_state:ext-x-1',
      'unit_spawn:ext-x-2',
    ]);
  });

  it('isExternalAgentUnit', () => {
    expect(isExternalAgentUnit('ext-claude-code-1')).toBe(true);
    expect(isExternalAgentUnit('MAIN')).toBe(false);
  });
});

describe('fetchExternalAgents', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the agents array from the bridge snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: { ok: true }, agents: [row('ext-a-1')] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchExternalAgents()).toEqual([row('ext-a-1')]);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/api\/external-agents$/);
  });

  it('returns null on HTTP error, network error or odd body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchExternalAgents()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    expect(await fetchExternalAgents()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ agents: 'x' }) }),
    );
    expect(await fetchExternalAgents()).toBeNull();
  });
});

// ─── Handler integration: placement + operation ticker ───────────────────────
function city(id: string, q: number, r: number, isCapital = false): City {
  return {
    id,
    name: id,
    coord: { q, r },
    repoPath: isCapital ? undefined : '/w/repociv',
    population: 1,
    territory: [],
    districts: [],
    buildings: [],
    isCapital,
    color: [0, 0, 0],
  } as City;
}

function makeCtx() {
  const world: World = {
    tiles: new Map(),
    cities: [city('capital', 0, 0, true), city(REPOCIV, 6, -2)],
    units: [],
    buildings: [],
    resources: { gold: 0, science: 0, production: 0, culture: 0 } as World['resources'],
    generatedAt: Date.now(),
    restAreas: [],
  } as World;
  const state = new GameState(world);
  const ctx = {
    state,
    logEvent: vi.fn(),
    showNotification: vi.fn(),
    setOperationTicker: vi.fn(),
    appendChatChunk: vi.fn(),
    appendApprovalCard: vi.fn(),
    terminalPanel: {},
  } as unknown as MessageContext;
  return { state, ctx };
}

describe('unit_spawn / unit_state for ext units', () => {
  it('places an ext unit next to its city and keeps that cityId', () => {
    const { state, ctx } = makeCtx();
    for (const evt of externalAgentEvents([], [row('ext-claude-code-aaaaaaaa')])) {
      dispatchBridgeEvent(ctx, evt);
    }
    const unit = state.getUnit('ext-claude-code-aaaaaaaa')!;
    expect(unit.cityId).toBe(REPOCIV);
    expect(axialDistance(unit.coord, { q: 6, r: -2 })).toBe(1);
    expect(unit.ephemeral).toBe(true);
    expect(unit.state).toBe('working');
  });

  it('falls back to the capital when the repo is not on this map', () => {
    const { state, ctx } = makeCtx();
    for (const evt of externalAgentEvents([], [row('ext-codex-1', { cityId: 'repo:unknown' })])) {
      dispatchBridgeEvent(ctx, evt);
    }
    const unit = state.getUnit('ext-codex-1')!;
    expect(unit.cityId).toBe('capital');
    expect(axialDistance(unit.coord, { q: 0, r: 0 })).toBe(1);
  });

  it('spreads several agents of the same city over distinct hexes', () => {
    const { state, ctx } = makeCtx();
    const rows = [row('ext-a-1'), row('ext-a-2'), row('ext-a-3')];
    for (const evt of externalAgentEvents([], rows)) dispatchBridgeEvent(ctx, evt);
    const keys = rows.map((r) => {
      const c = state.getUnit(r.unit)!.coord;
      return `${c.q},${c.r}`;
    });
    expect(new Set(keys).size).toBe(3);
  });

  it('ext unit state changes never drive the global operation ticker', () => {
    const { ctx } = makeCtx();
    dispatchBridgeEvent(ctx, { type: 'unit_state', unit: 'ext-a-1', state: 'working' });
    dispatchBridgeEvent(ctx, { type: 'unit_state', unit: 'ext-a-1', state: 'idle' });
    expect(ctx.setOperationTicker).not.toHaveBeenCalled();
    dispatchBridgeEvent(ctx, { type: 'unit_state', unit: 'MAIN', state: 'working' });
    expect(ctx.setOperationTicker).toHaveBeenCalledWith(true, 'MAIN trabajando…');
  });

  it('a spawn with an explicit hex keeps it (LexO scanner path unchanged)', () => {
    const { state, ctx } = makeCtx();
    dispatchBridgeEvent(ctx, {
      type: 'unit_spawn',
      unit: 'LEXO-1',
      civ: 'capital',
      hex: [3, 1],
      unitType: 'lexo',
    });
    expect(state.getUnit('LEXO-1')!.coord).toEqual({ q: 3, r: 1 });
  });
});
