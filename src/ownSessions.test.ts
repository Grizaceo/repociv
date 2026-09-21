import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownSessionEvents, fetchOwnSessions, closeOwnSession, type OwnSessionRow } from './ownSessions.ts';
import { GameState } from './game.ts';
import { dispatchBridgeEvent, type MessageContext } from './bridgeMessageHandlers.ts';
import type { City, World } from './types.ts';

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

function row(unit: string, extra: Partial<OwnSessionRow> = {}): OwnSessionRow {
  return {
    unit,
    civ: 'capital',
    unitType: 'claude',
    cityId: 'formal-math-lab',
    mission: 'Dime Donde Estas',
    state: 'idle',
    ...extra,
  };
}

describe('ownSessionEvents', () => {
  it('spawns missing own units next to their repo city', () => {
    const events = ownSessionEvents(['MAIN'], [row('SESSION-01')]);
    expect(events).toEqual([
      {
        type: 'unit_spawn',
        unit: 'SESSION-01',
        civ: 'capital',
        hex: [0, 0],
        unitType: 'claude',
        mission: 'Dime Donde Estas',
        cityId: 'formal-math-lab',
      },
    ]);
  });

  it('does not respawn units already on the map', () => {
    const events = ownSessionEvents(['MAIN', 'SESSION-01'], [row('SESSION-01')]);
    expect(events).toEqual([]);
  });

  it('working sessions stay out of the way: the runner emits its own stream', () => {
    const events = ownSessionEvents(['MAIN'], [row('SESSION-02', { state: 'working' })]);
    expect(events).toEqual([]);
  });

  it('skips rows without a usable unit id', () => {
    const events = ownSessionEvents([], [
      row(''),
      { unit: 42 } as unknown as OwnSessionRow,
      row('SESSION-03'),
    ]);
    expect(events.map((e) => e.type)).toEqual(['unit_spawn']);
  });

  it('never despawns idle/unknown sessions (they keep their map anchor)', () => {
    const events = ownSessionEvents(['SESSION-01'], []);
    expect(events).toEqual([]);
  });

  it('despawns only sessions the store explicitly closed', () => {
    const events = ownSessionEvents(['SESSION-01', 'SESSION-02'], [
      row('SESSION-01', { state: 'closed' }),
      row('SESSION-02', { state: 'idle' }),
      row('SESSION-03', { state: 'closed' }), // not on the map: no event
    ]);
    expect(events).toEqual([{ type: 'unit_despawn', unit: 'SESSION-01' }]);
  });

  it('never spawns a closed session back onto the map', () => {
    const events = ownSessionEvents([], [row('SESSION-04', { state: 'closed' })]);
    expect(events).toEqual([]);
  });

  it('spawns validate and dispatch through the normal bridge path', () => {
    const city = {
      id: 'formal-math-lab',
      name: 'formal-math-lab',
      coord: { q: 0, r: 0 },
      population: 1,
      territory: [],
      districts: [],
      buildings: [],
      isCapital: false,
      color: [0, 0, 0],
    } as City;
    const world = {
      tiles: new Map(),
      cities: [city],
      units: [],
      buildings: [],
      resources: { gold: 0, science: 0, production: 0, culture: 0 },
      generatedAt: Date.now(),
      restAreas: [],
    } as World;
    const state = new GameState(world);
    const ctx: MessageContext = {
      state,
      renderer: null,
      rendererCallbacks: null,
      logEvent: vi.fn(),
      setBridgeStatus: vi.fn(),
      setOperationTicker: vi.fn(),
      updateGpuBar: vi.fn(),
      appendChatChunk: vi.fn(),
      appendApprovalCard: vi.fn(),
      showNotification: vi.fn(),
      world,
      chatLog: [],
      pendingApprovals: new Map(),
      log: [],
      localWorld: null,
      selectedUnitId: null,
      setSelectedUnit: vi.fn(),
    } as unknown as MessageContext;
    const events = ownSessionEvents([], [row('SESSION-01')]);
    for (const evt of events) dispatchBridgeEvent(ctx, evt);
    const unit = state.getUnit('SESSION-01');
    expect(unit).not.toBeUndefined();
    expect(unit!.type).toBe('claude');
    expect(unit!.civ).toBe('capital');
  });
});

describe('fetchOwnSessions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the agents array from the snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ agents: [row('SESSION-01')] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchOwnSessions()).toEqual([row('SESSION-01')]);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/api\/own-sessions$/);
  });

  it('returns null on HTTP error or unreachable bridge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await fetchOwnSessions()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    expect(await fetchOwnSessions()).toBeNull();
  });
});

describe('closeOwnSession', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to the close endpoint and returns ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    expect(await closeOwnSession('SESSION-01')).toBe(true);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toMatch(/\/api\/own-sessions\/SESSION-01\/close$/);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });

  it('returns false on HTTP error or unreachable bridge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    expect(await closeOwnSession('SESSION-01')).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    expect(await closeOwnSession('SESSION-01')).toBe(false);
  });
});