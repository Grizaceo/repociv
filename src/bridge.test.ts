import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeEvents } from './bridge.ts';
import * as loggerMod from './logger.ts';

// ─── Module mocks ─────────────────────────────────────────────────────────────
vi.mock('./ui/index.ts', () => ({
  logEvent: vi.fn(),
  appendChatChunk: vi.fn(),
  appendApprovalCard: vi.fn(),
  setBridgeStatus: vi.fn(),
  setOperationTicker: vi.fn(),
  updateGpuBar: vi.fn(),
  showNotification: vi.fn(),
}));

import * as uiMod from './ui/index.ts';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

function makeState() {
  const state = {
    spawned: [] as string[],
    moved: [] as string[],
    spawnUnit(id: string) {
      state.spawned.push(id);
      return { id, name: id, coord: { q: 0, r: 0 } };
    },
    moveUnit(id: string) {
      state.moved.push(id);
    },
    setUnitState: vi.fn(),
    startBuilding: vi.fn(),
    completeBuilding: vi.fn(),
    failBuilding: vi.fn(),
    invalidatePathCache: vi.fn(),
    startMission: vi.fn(),
    completeMission: vi.fn(),
    getUnit: vi.fn(() => null),
    getUnitAt: vi.fn(() => null),
    getChildrenOfUnit: vi.fn(() => []),
    subagents: new Map(),
    registerSubagent: vi.fn(function (run: import('./types.ts').SubagentRun) {
      state.subagents.set(run.id, run);
    }),
    updateSubagent: vi.fn(function (id: string, patch: Record<string, unknown>) {
      const existing = state.subagents.get(id);
      if (existing) state.subagents.set(id, { ...existing, ...patch });
    }),
    appendSubagentProgress: vi.fn(),
    syncSubagentSpawn: vi.fn(),
    updateUnitFatigue: vi.fn(),
    addRestArea: vi.fn(),
    setUnitResting: vi.fn(),
  } as unknown as ConstructorParameters<typeof BridgeEvents>[0] & {
    spawned: string[];
    moved: string[];
  };
  return state;
}

/**
 * Failing WebSocket for SSE fallback testing.
 * Fires onclose synchronously via setter to trigger immediate WS failure.
 */
class FailWS {
  readyState = 3;
  private _onclose: ((evt: { code: number }) => void) | null = null;
  private _onerror: (() => void) | null = null;
  onopen: null = null;
  get onclose() {
    return this._onclose;
  }
  set onclose(handler) {
    this._onclose = handler;
    handler?.({ code: 1006 });
  }
  get onerror() {
    return this._onerror;
  }
  set onerror(handler) {
    this._onerror = handler;
    handler?.();
  }
  onmessage: null = null;
  close() {}
  send() {}
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(_url: string) {}
}

describe('BridgeEvents SSE transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    // Make WebSocket fail via FailWS → SSE fallback activates
    vi.stubGlobal('WebSocket', FailWS);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('no bridge')), // WS discovery fails → SSE fallback
    );
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', {
      body: { innerHTML: '' },
      getElementById: vi.fn(() => null),
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => ({ className: '', innerHTML: '' })),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('connects to /events and applies SSE bridge events', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);

    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({ type: 'unit_spawn', unit: 'MAIN', civ: 'gris', hex: [0, 0] });
    src.message({ type: 'ping' });

    // In dev/test mode, bridgeUrl('/events') resolves to '/bridge/events' (Vite proxy prefix).
    // In production with VITE_BRIDGE_URL set it would be the full absolute URL.
    // When a token is configured it travels as ?token= (EventSource can't send headers).
    expect(src.url).toMatch(/^\/bridge\/events(\?token=[A-Za-z0-9%._~-]+)?$/);
    expect(state.spawned).toEqual(['MAIN']);

    bridge.stop();
    expect(src.closed).toBe(true);
  });

  it('reconnects SSE with backoff after transport error', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();

    await vi.advanceTimersByTimeAsync(100);
    const first = FakeEventSource.instances[0]!;
    first.onerror?.();
    expect(first.closed).toBe(true);

    vi.advanceTimersByTime(2500);
    expect(FakeEventSource.instances).toHaveLength(2);

    bridge.stop();
  });
});

describe('BridgeEvents checkHealth', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('WebSocket', FailWS);
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', {
      body: { innerHTML: '' },
      getElementById: vi.fn(() => null),
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => ({ className: '', innerHTML: '' })),
    });
    // Make WS discovery fail → fallback to SSE
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no bridge')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks bridge online when /health returns ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, openclaw: false, claudeCode: false, cursor: false }),
      }),
    );
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    // flush two levels of async (fetch → json)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.bridgeOnline).toBe(true);
    bridge.stop();
  });

  it('marks bridge offline when /health fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.bridgeOnline).toBe(false);
    bridge.stop();
  });

  it('reports hermes mode when defaultTransport is hermes (even if claude is installed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          openclaw: false,
          claudeCode: true,
          cursor: false,
          defaultTransport: 'hermes',
        }),
      }),
    );
    const setBridgeStatus = vi.mocked(uiMod.setBridgeStatus);
    setBridgeStatus.mockClear();
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(setBridgeStatus).toHaveBeenCalledWith(true, 'hermes', { cursor: false });
    bridge.stop();
  });
});

describe('BridgeEvents handleBridgeEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('WebSocket', FailWS);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('no bridge')), // WS discovery fails → SSE fallback
    );
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', {
      body: { innerHTML: '' },
      getElementById: vi.fn(() => null),
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => ({ className: '', innerHTML: '' })),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('unit_spawn adds unit to game state', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({ type: 'unit_spawn', unit: 'LEXO-1', civ: 'gris', hex: [2, 3] });
    expect(state.spawned).toContain('LEXO-1');
    bridge.stop();
  });

  it('mission_complete calls completeMission on state', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({
      type: 'mission_complete',
      missionId: 'abc',
      unit: 'MAIN',
      success: true,
      duration: 42,
    });
    expect(state.completeMission).toHaveBeenCalledWith('abc', true);
    bridge.stop();
  });

  it('chat_chunk calls appendChatChunk', async () => {
    const appendChatChunk = vi.mocked(uiMod.appendChatChunk);
    appendChatChunk.mockClear();
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({ type: 'chat_chunk', unit: 'WORKER-1', text: 'hello world\n' });
    expect(appendChatChunk).toHaveBeenCalledWith('WORKER-1', 'hello world\n');
    bridge.stop();
  });

  it('waiting_approval shows inline approval card in chat', async () => {
    const appendApprovalCard = vi.mocked(uiMod.appendApprovalCard);
    appendApprovalCard.mockClear();
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({
      type: 'waiting_approval',
      commandId: 'cmd-1',
      commandType: 'run_tests',
      target: 'repociv',
      risk: 'high',
    });
    expect(appendApprovalCard).toHaveBeenCalledWith(
      'repociv',
      'cmd-1',
      'run_tests',
      'repociv',
      'high',
    );
    bridge.stop();
  });

  it('discards and logs invalid bridge events', async () => {
    const logEvent = vi.mocked(uiMod.logEvent);
    logEvent.mockClear();
    const warnSpy = vi.spyOn(loggerMod.logger, 'warn').mockImplementation(() => {});
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({ type: 'unknown_garbage', foo: 'bar' });
    const warnCalls = logEvent.mock.calls.filter(([, level]) => level === 'warn');
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[bridge]'),
      expect.anything(),
      expect.anything(),
    );
    warnSpy.mockRestore();
    bridge.stop();
  });

  it('building_start calls startBuilding on state', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({
      type: 'building_start',
      city: 'repo-1',
      building: 'ci-pipeline',
      buildingType: 'building',
      durationSeconds: 60,
      missionId: 'mis-1',
    });
    expect(state.startBuilding).toHaveBeenCalledWith(
      'repo-1',
      'ci-pipeline',
      'ci-pipeline',
      60,
      'building',
    );
    bridge.stop();
  });

  it('building_complete calls completeBuilding and invalidatePathCache', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({
      type: 'building_complete',
      city: 'repo-1',
      building: 'ci-pipeline',
      missionId: 'mis-1',
    });
    expect(state.completeBuilding).toHaveBeenCalledWith('repo-1', 'ci-pipeline');
    expect(state.invalidatePathCache).toHaveBeenCalled();
    bridge.stop();
  });

  it('building_failed calls failBuilding on state', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({
      type: 'building_failed',
      city: 'repo-1',
      building: 'ci-pipeline',
      missionId: 'mis-1',
    });
    expect(state.failBuilding).toHaveBeenCalledWith('repo-1', 'ci-pipeline');
    bridge.stop();
  });

  it('subagent_spawn proposed does not spawn ephemeral unit', async () => {
    const state = makeState();
    vi.mocked(state.getUnit).mockImplementation((id: string) =>
      id === 'MAIN'
        ? ({ id: 'MAIN', coord: { q: 0, r: 0 }, cityId: 'repociv' } as import('./types.ts').Unit)
        : undefined,
    );
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({
      type: 'subagent_spawn',
      subagentId: 'sub-prop',
      parentMissionId: 'm1',
      parentUnit: 'MAIN',
      kind: 'explore',
      label: 'scan repo',
      hex: [0, 0],
      unitType: 'scout',
      risk: 'high',
      ephemeralUnitId: 'SCOUT-sub-prop',
      status: 'proposed',
    });
    expect(state.spawned).not.toContain('SCOUT-sub-prop');
    expect(state.registerSubagent).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'proposed' }),
    );
    bridge.stop();
  });

  it('subagent_spawn running spawns ephemeral unit', async () => {
    const state = makeState();
    vi.mocked(state.getUnit).mockImplementation((id: string) =>
      id === 'MAIN'
        ? ({ id: 'MAIN', coord: { q: 0, r: 0 }, cityId: 'repociv' } as import('./types.ts').Unit)
        : undefined,
    );
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({
      type: 'subagent_spawn',
      subagentId: 'sub-run',
      parentMissionId: 'm1',
      parentUnit: 'MAIN',
      kind: 'explore',
      label: 'scan repo',
      hex: [0, 0],
      unitType: 'scout',
      risk: 'low',
      ephemeralUnitId: 'SCOUT-sub-run',
      status: 'running',
    });
    expect(state.spawned).toContain('SCOUT-sub-run');
    expect(state.setUnitState).toHaveBeenCalledWith('SCOUT-sub-run', 'working');
    bridge.stop();
  });

  it('subagent_progress promotes proposed to running and sets working', async () => {
    const state = makeState();
    vi.mocked(state.getUnit).mockImplementation((id: string) =>
      id === 'MAIN'
        ? ({ id: 'MAIN', coord: { q: 0, r: 0 }, cityId: 'repociv' } as import('./types.ts').Unit)
        : undefined,
    );
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({
      type: 'subagent_spawn',
      subagentId: 'sub-p',
      parentMissionId: 'm1',
      parentUnit: 'MAIN',
      kind: 'explore',
      label: 'scan',
      hex: [0, 0],
      unitType: 'scout',
      risk: 'low',
      ephemeralUnitId: 'SCOUT-sub-p',
      status: 'proposed',
    });
    src.message({
      type: 'subagent_progress',
      subagentId: 'sub-p',
      phase: 'working',
      text: 'exploring files',
    });
    expect(state.updateSubagent).toHaveBeenCalledWith(
      'sub-p',
      expect.objectContaining({ status: 'running' }),
    );
    expect(state.setUnitState).toHaveBeenCalledWith('SCOUT-sub-p', 'working');
    bridge.stop();
  });

  it('unit_move calls moveUnit on state', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({ type: 'unit_move', unit: 'MAIN', from: [0, 0], to: [3, 4] });
    expect(state.moved).toContain('MAIN');
    bridge.stop();
  });

  it('unit_state sets state on unit and operation ticker', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({ type: 'unit_state', unit: 'WORKER-1', state: 'working' });
    expect(state.setUnitState).toHaveBeenCalledWith('WORKER-1', 'working');
    bridge.stop();
  });

  it('unit_state idle clears operation ticker', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({ type: 'unit_state', unit: 'WORKER-1', state: 'idle' });
    expect(state.setUnitState).toHaveBeenCalledWith('WORKER-1', 'idle');
    bridge.stop();
  });

  it('mission_start calls startMission on state', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({
      type: 'mission_start',
      missionId: 'ms-10',
      unit: 'WORKER',
      questName: 'Analyze repo',
    });
    expect(state.startMission).toHaveBeenCalledWith('ms-10', 'WORKER', 'Analyze repo');
    bridge.stop();
  });

  it('mission_complete with failure calls completeMission with false', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({
      type: 'mission_complete',
      missionId: 'ms-fail',
      unit: 'WORKER',
      success: false,
      duration: 10,
    });
    expect(state.completeMission).toHaveBeenCalledWith('ms-fail', false);
    bridge.stop();
  });

  it('log event calls logEvent with correct level', async () => {
    const logEvent = vi.mocked(uiMod.logEvent);
    logEvent.mockClear();
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    await vi.advanceTimersByTimeAsync(100);
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({ type: 'log', msg: 'System up', level: 'info' });
    expect(logEvent).toHaveBeenCalledWith('System up', 'info');
    bridge.stop();
  });

  it('stop() clears health/gpu intervals and prevents SSE reconnect', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();

    await vi.advanceTimersByTimeAsync(3000);
    bridge.stop();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();

    const sseCountBefore = FakeEventSource.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances.length).toBe(sseCountBefore);

    clearIntervalSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});

// ─── WebSocket transport tests ───────────────────────────────────────────────

/**
 * Fake WebSocket implementation for testing RepoCivWebSocket and BridgeEvents
 * WS transport. Mocks the browser WebSocket API.
 * Auto-fires onclose to simulate connection failure for fallback testing.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState: number = WebSocket.CONNECTING;
  private _onopen: (() => void) | null = null;
  private _onclose: ((evt: { code: number }) => void) | null = null;
  private _onerror: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  closed = false;
  sentMessages: string[] = [];

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  get onopen() {
    return this._onopen;
  }
  set onopen(handler) {
    this._onopen = handler;
  }

  get onclose() {
    return this._onclose;
  }
  set onclose(handler) {
    this._onclose = handler;
  }

  get onerror() {
    return this._onerror;
  }
  set onerror(handler) {
    this._onerror = handler;
  }

  constructor(url: string) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    FakeWebSocket.instances.push(this);
    // Auto-close after microtask to simulate connection failure
    // This allows the fallback test to work
  }

  /** Simulate server opening the connection */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this._onopen?.();
  }

  /** Complete WS auth handshake (server sends auth_ok) */
  authenticate() {
    this.open();
    this.message({ type: 'auth_ok' });
  }

  /** Simulate server sending a message */
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  /** Simulate server closing */
  closeConnection(code = 1000) {
    this.readyState = FakeWebSocket.CLOSED;
    this._onclose?.({ code });
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    const idx = FakeWebSocket.instances.indexOf(this);
    if (idx >= 0) FakeWebSocket.instances.splice(idx, 1);
  }
}

describe('BridgeEvents WS transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    FakeEventSource.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          wsUrl: 'ws://localhost:5275',
          wsPort: 5275,
          authRequired: false,
        }),
      }),
    );
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', {
      body: { innerHTML: '' },
      getElementById: vi.fn(() => null),
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => ({ className: '', innerHTML: '' })),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('discovers WS endpoint via /ws and connects', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();

    // Advance timers enough for async /ws fetch to complete
    await vi.advanceTimersByTimeAsync(200);

    // WS connection should have been attempted
    expect(FakeWebSocket.instances.length).toBeGreaterThan(0);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toContain('ws://localhost:5275');

    bridge.stop();
  });

  it('prefers WS over SSE for event delivery', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();

    await vi.advanceTimersByTimeAsync(200);

    const ws = FakeWebSocket.instances[0]!;
    ws.authenticate();
    ws.message({ type: 'unit_spawn', unit: 'MAIN', civ: 'gris', hex: [0, 0] });

    expect(state.spawned).toEqual(['MAIN']);

    bridge.stop();
  });

  it('falls back to SSE when WS connection fails', async () => {
    // Make WS fail: fetch fails + WebSocket fails synchronously
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('bridge not reachable')));
    vi.stubGlobal('WebSocket', FailWS);

    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();

    // After WS discovery fails, it should try SSE
    await vi.advanceTimersByTimeAsync(500);

    // SSE EventSource should be created as fallback
    expect(FakeEventSource.instances.length).toBeGreaterThan(0);

    bridge.stop();
  });

  it('sends commands via WS when connected', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();

    await vi.advanceTimersByTimeAsync(200);

    const ws = FakeWebSocket.instances[0]!;
    ws.authenticate();

    // Clear the auth message sent on open
    ws.sentMessages = [];

    bridge.bridgeOnline = true;
    bridge.send('unit_command', { unit: 'MAIN', city: 'main', mission: 'test' });

    expect(ws.sentMessages.length).toBeGreaterThan(0);
    const sent = JSON.parse(ws.sentMessages[0]!);
    expect(sent.type).toBe('command');

    bridge.stop();
  });

  it('sends approvals via WS when connected', async () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();

    await vi.advanceTimersByTimeAsync(200);

    const ws = FakeWebSocket.instances[0]!;
    ws.authenticate();

    // Clear the auth message sent on open
    ws.sentMessages = [];

    bridge.sendApproval('cmd-42', true);

    expect(ws.sentMessages.length).toBeGreaterThan(0);
    const sent = JSON.parse(ws.sentMessages[0]!);
    expect(sent.type).toBe('approval');
    expect(sent.id).toBe('cmd-42');
    expect(sent.approved).toBe(true);

    bridge.stop();
  });
});
