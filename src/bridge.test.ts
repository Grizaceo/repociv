import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeEvents } from './bridge.ts';

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

  close() { this.closed = true; }
  open() { this.onopen?.(); }
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
    moveUnit(id: string) { state.moved.push(id); },
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
  } as unknown as ConstructorParameters<typeof BridgeEvents>[0] & { spawned: string[]; moved: string[] };
  return state;
}

describe('BridgeEvents SSE transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, openclaw: false }) }));
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
