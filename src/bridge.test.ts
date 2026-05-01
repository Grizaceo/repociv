import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeEvents } from './bridge.ts';
import * as loggerMod from './logger.ts';

// ─── Module mocks ─────────────────────────────────────────────────────────────
vi.mock('./ui/index.ts', () => ({
  logEvent: vi.fn(),
  appendChatChunk: vi.fn(),
  setBridgeStatus: vi.fn(),
  setOperationTicker: vi.fn(),
  updateGpuBar: vi.fn(),
  showNotification: vi.fn(),
}));

vi.mock('./ui/approvalPanel.ts', () => ({
  openApprovalPanel: vi.fn(),
}));

import * as uiMod from './ui/index.ts';
import * as approvalMod from './ui/approvalPanel.ts';

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
      return { id, name: id };
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
    updateUnitFatigue: vi.fn(),
    addRestArea: vi.fn(),
    setUnitResting: vi.fn(),
  } as unknown as ConstructorParameters<typeof BridgeEvents>[0] & {
    spawned: string[];
    moved: string[];
  };
  return state;
}

describe('BridgeEvents SSE transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, openclaw: false }) }),
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
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({ type: 'unit_spawn', unit: 'DAVI', civ: 'gris', hex: [0, 0] });
    src.message({ type: 'ping' });

    expect(src.url).toBe('http://localhost:5274/events');
    expect(state.spawned).toEqual(['DAVI']);

    bridge.stop();
    expect(src.closed).toBe(true);
  });

  it('reconnects SSE with backoff after transport error', () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();

    const first = FakeEventSource.instances[0]!;
    first.onerror?.();
    expect(first.closed).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);

    bridge.stop();
  });
});

describe('BridgeEvents checkHealth', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', {
      body: { innerHTML: '' },
      getElementById: vi.fn(() => null),
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => ({ className: '', innerHTML: '' })),
    });
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

  it('reports claude-code mode when claudeCode flag is true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, openclaw: false, claudeCode: true, cursor: false }),
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
    expect(setBridgeStatus).toHaveBeenCalledWith(true, 'claude-code');
    bridge.stop();
  });
});

describe('BridgeEvents handleBridgeEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, openclaw: false, claudeCode: false, cursor: false }),
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

  it('unit_spawn adds unit to game state', () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({ type: 'unit_spawn', unit: 'LEXO-1', civ: 'gris', hex: [2, 3] });
    expect(state.spawned).toContain('LEXO-1');
    bridge.stop();
  });

  it('mission_complete calls completeMission on state', () => {
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({
      type: 'mission_complete',
      missionId: 'abc',
      unit: 'DAVI',
      success: true,
      duration: 42,
    });
    expect(state.completeMission).toHaveBeenCalledWith('abc', true);
    bridge.stop();
  });

  it('chat_chunk calls appendChatChunk', () => {
    const appendChatChunk = vi.mocked(uiMod.appendChatChunk);
    appendChatChunk.mockClear();
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({ type: 'chat_chunk', unit: 'WORKER-1', text: 'hello world\n' });
    expect(appendChatChunk).toHaveBeenCalledWith('WORKER-1', 'hello world\n');
    bridge.stop();
  });

  it('waiting_approval opens approval panel', () => {
    const openApprovalPanel = vi.mocked(approvalMod.openApprovalPanel);
    openApprovalPanel.mockClear();
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
    const src = FakeEventSource.instances[0]!;
    src.open();
    src.message({
      type: 'waiting_approval',
      commandId: 'cmd-1',
      commandType: 'execute_agent',
      target: 'repociv',
      risk: 'high',
    });
    expect(openApprovalPanel).toHaveBeenCalled();
    bridge.stop();
  });

  it('discards and logs invalid bridge events', () => {
    const logEvent = vi.mocked(uiMod.logEvent);
    logEvent.mockClear();
    const warnSpy = vi.spyOn(loggerMod.logger, 'warn').mockImplementation(() => {});
    const state = makeState();
    const bridge = new BridgeEvents(state);
    bridge.start();
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
});
