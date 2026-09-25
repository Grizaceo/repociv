import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentLabel,
  decodeRepoCityId,
  findCityByRef,
  chatMessagesHtml,
  externalAgentEvents,
  fetchExternalAgents,
  fetchExternalChat,
  fetchExternalResume,
  fetchExternalSessions,
  formatTokens,
  isExternalAgentUnit,
  partitionSessions,
  placeOnMap,
  relativeTime,
  replyErrorText,
  sendExternalChat,
  sendExternalReply,
  sessionLabel,
  shortModel,
  stateBadge,
  summarizeTools,
  type ExternalAgentRow,
  type ExternalSessionRow,
} from './externalAgents.ts';
import { GameState } from './game.ts';
import { dispatchBridgeEvent, type MessageContext } from './bridgeMessageHandlers.ts';
import { aStarPath } from './pathfinding.ts';
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

function onMap(...ids: string[]): { id: string }[] {
  return ids.map((id) => ({ id }));
}

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
    const events = externalAgentEvents(onMap('MAIN'), [row('ext-claude-code-aaaaaaaa')]);
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
    const events = externalAgentEvents(onMap('ext-codex-bbbbbbbb'), [
      row('ext-codex-bbbbbbbb', { unitType: 'codex', state: 'idle' }),
    ]);
    expect(events).toEqual([{ type: 'unit_state', unit: 'ext-codex-bbbbbbbb', state: 'idle' }]);
  });

  it('does not re-assert a state the unit already shows (the replay runs on a timer)', () => {
    const events = externalAgentEvents(
      [
        { id: 'ext-a-1', state: 'working' },
        { id: 'ext-a-2', state: 'moving' },
      ],
      [row('ext-a-1'), row('ext-a-2')],
    );
    expect(events).toEqual([{ type: 'unit_state', unit: 'ext-a-2', state: 'working' }]);
  });

  it('despawns ext units the tracker dropped, never touching other units', () => {
    const events = externalAgentEvents(onMap('MAIN', 'SCOUT-sub-1', 'ext-cursor-cccccccc'), []);
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

  it('moves a unit whose session changed city while this client was away', () => {
    const cities = [city('capital', 0, 0, true), city(REPOCIV, 6, -2)];
    const events = externalAgentEvents(
      [{ id: 'ext-hermes-aaaaaaaa', cityId: 'capital' }],
      [row('ext-hermes-aaaaaaaa', { unitType: 'hero' })],
      cities,
    );
    expect(events.map((e) => e.type)).toEqual(['unit_relocate', 'unit_state']);
    expect(events[0]).toEqual({
      type: 'unit_relocate',
      unit: 'ext-hermes-aaaaaaaa',
      cityId: REPOCIV,
    });
  });

  it('leaves a unit that already stands at its city (or at the capital for an off-map repo)', () => {
    const cities = [city('capital', 0, 0, true), city(REPOCIV, 6, -2)];
    const events = externalAgentEvents(
      [
        { id: 'ext-a-1', cityId: REPOCIV },
        { id: 'ext-a-2', cityId: 'capital' },
      ],
      [row('ext-a-1'), row('ext-a-2', { cityId: 'repo:unknown' })],
      cities,
    );
    expect(events.map((e) => e.type)).toEqual(['unit_state', 'unit_state']);
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
  it('places an ext unit in its city and keeps that cityId', () => {
    const { state, ctx } = makeCtx();
    for (const evt of externalAgentEvents([], [row('ext-claude-code-aaaaaaaa')])) {
      dispatchBridgeEvent(ctx, evt);
    }
    const unit = state.getUnit('ext-claude-code-aaaaaaaa')!;
    expect(unit.cityId).toBe(REPOCIV);
    expect(unit.coord).toEqual({ q: 6, r: -2 }); // on the city hex, not beside it
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
    expect(unit.coord).toEqual({ q: 0, r: 0 });
  });

  it('a reconnect replay puts a unit at its new city even when no path leads there', () => {
    const { state, ctx } = makeCtx();
    for (const evt of externalAgentEvents([], [row('ext-hermes-1', { cityId: 'capital' })])) {
      dispatchBridgeEvent(ctx, evt);
    }
    expect(state.getUnit('ext-hermes-1')!.cityId).toBe('capital');
    const replay = externalAgentEvents(
      state.getAllUnits(),
      [row('ext-hermes-1')],
      state.world.cities,
    );
    for (const evt of replay) dispatchBridgeEvent(ctx, evt);
    const unit = state.getUnit('ext-hermes-1')!;
    expect(unit.cityId).toBe(REPOCIV);
    expect(unit.coord).toEqual({ q: 6, r: -2 }); // on the city hex, not beside it
  });

  it('unit_relocate walks the unit over; a state change on the way waits for the arrival', () => {
    const { state, ctx } = makeCtx();
    for (const evt of externalAgentEvents([], [row('ext-hermes-2', { cityId: 'capital' })])) {
      dispatchBridgeEvent(ctx, evt);
    }
    const unit = state.getUnit('ext-hermes-2')!;
    vi.mocked(aStarPath).mockImplementationOnce((from, to) => [from, to]);
    dispatchBridgeEvent(ctx, { type: 'unit_relocate', unit: 'ext-hermes-2', cityId: REPOCIV });
    expect(unit.cityId).toBe(REPOCIV);
    expect(unit.state).toBe('moving');
    const dest = unit.targetCoord!;
    expect(dest).toEqual({ q: 6, r: -2 });
    dispatchBridgeEvent(ctx, { type: 'unit_state', unit: 'ext-hermes-2', state: 'idle' });
    expect(unit.state).toBe('moving'); // still walking
    (state as unknown as { updateUnits(dt: number): void }).updateUnits(1000);
    expect(unit.coord).toEqual(dest);
    expect(unit.state).toBe('idle');
  });

  it('unit_relocate ignores units this map lacks and moves within the same city', () => {
    const { state, ctx } = makeCtx();
    dispatchBridgeEvent(ctx, { type: 'unit_relocate', unit: 'ext-ghost-1', cityId: REPOCIV });
    expect(state.getUnit('ext-ghost-1')).toBeUndefined();
    for (const evt of externalAgentEvents([], [row('ext-a-9')])) dispatchBridgeEvent(ctx, evt);
    const unit = state.getUnit('ext-a-9')!;
    const before = { ...unit.coord };
    dispatchBridgeEvent(ctx, { type: 'unit_relocate', unit: 'ext-a-9', cityId: REPOCIV });
    expect(unit.coord).toEqual(before);
    expect(unit.state).toBe('working');
  });

  it('several agents of one city all stand in it (the renderers fan them out, unitStack.ts)', () => {
    const { state, ctx } = makeCtx();
    const rows = [row('ext-a-1'), row('ext-a-2'), row('ext-a-3')];
    for (const evt of externalAgentEvents([], rows)) dispatchBridgeEvent(ctx, evt);
    for (const r of rows) expect(state.getUnit(r.unit)!.coord).toEqual({ q: 6, r: -2 });
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

// ─── Agents panel helpers ────────────────────────────────────────────────────

function session(id: string, extra: Partial<ExternalSessionRow> = {}): ExternalSessionRow {
  return {
    sessionId: id,
    agent: 'claude-code',
    model: 'claude-opus-5',
    repo: 'repociv',
    cityId: 'capital',
    active: true,
    state: 'working',
    unit: `ext-claude-code-${id.slice(0, 8)}`,
    unitType: 'claude',
    firstActivityAt: 0,
    lastActivityAt: 0,
    commandCount: 0,
    eventCount: 0,
    totalTokens: null,
    subagent: false,
    imported: true,
    liveChat: { state: 'unavailable', transport: null, reason: 'unsupported_session_source' },
    ...extra,
  };
}

describe('placeOnMap', () => {
  const cities = [city('capital', 0, 0, true), city(REPOCIV, 6, -2)];

  it('finds the city of a repo on this map (by id or repoPath)', () => {
    const byId = placeOnMap({ cityId: REPOCIV }, cities);
    expect(byId.kind).toBe('city');
    expect(byId.city?.id).toBe(REPOCIV);
    expect(placeOnMap({ cityId: '/w/repociv' }, cities).kind).toBe('city');
  });

  it('capital for RepoCiv itself; off-map (standing at the capital) otherwise', () => {
    expect(placeOnMap({ cityId: 'capital' }, cities)).toMatchObject({
      kind: 'capital',
      city: { id: 'capital' },
    });
    expect(placeOnMap({ cityId: 'repo:elsewhere' }, cities)).toMatchObject({
      kind: 'off-map',
      city: { id: 'capital' },
    });
    expect(placeOnMap({ cityId: 'repo:x' }, []).kind).toBe('off-map');
  });
});

describe('panel formatting', () => {
  it('partitions active vs recent, newest first', () => {
    const rows = [
      session('a', { active: false, state: 'inactive', lastActivityAt: 5 }),
      session('b', { lastActivityAt: 1 }),
      session('c', { lastActivityAt: 9 }),
      session('d', { active: false, state: 'inactive', lastActivityAt: 7 }),
    ];
    const { active, recent } = partitionSessions(rows);
    expect(active.map((r) => r.sessionId)).toEqual(['c', 'b']);
    expect(recent.map((r) => r.sessionId)).toEqual(['d', 'a']);
  });

  it('badges the two states you should not interrupt, and only those', () => {
    expect(stateBadge('working')?.text).toBe('trabajando');
    expect(stateBadge('thinking')?.text).toBe('pensando…');
    // A thinking agent may also just be waiting for its own user: the badge
    // must say "no lo interrumpas", never claim to know which it is.
    expect(stateBadge('thinking')?.title).toMatch(/esperando/);
    expect(stateBadge('idle')).toBeNull();
    expect(stateBadge('inactive')).toBeNull();
    expect(stateBadge('dancing')).toBeNull();
  });

  it('keeps thinking sessions in Activos', () => {
    const { active } = partitionSessions([session('t', { state: 'thinking' })]);
    expect(active.map((r) => r.sessionId)).toEqual(['t']);
  });

  it('labels, models, times and tokens', () => {
    expect(agentLabel('claude-code')).toBe('Claude Code');
    expect(agentLabel('mystery')).toBe('mystery');
    expect(shortModel('claude-opus-5')).toBe('opus-5');
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5');
    expect(shortModel('gpt-5-codex')).toBe('gpt-5-codex');
    const now = 10_000_000;
    expect(relativeTime(now - 12_000, now)).toBe('hace 12 s');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('hace 5 min');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('hace 3 h');
    expect(relativeTime(now + 5_000, now)).toBe('hace 0 s');
    expect(formatTokens(54_131_818)).toBe('54M tok');
    expect(formatTokens(3_200)).toBe('3.2k tok');
    expect(formatTokens(512)).toBe('512 tok');
    expect(formatTokens(null)).toBe('');
  });

  it('chat HTML escapes agent text and marks truncation', () => {
    const html = chatMessagesHtml(
      [
        {
          role: 'user',
          text: '<img src=x onerror=alert(1)>',
          at: null,
          truncated: false,
          turn: null,
        },
        { role: 'assistant', text: 'ok & done', at: null, truncated: true, turn: 't1' },
      ],
      'codex',
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('ok &amp; done');
    expect(html).toContain('agents-msg--user');
    expect(html).toContain('Codex');
    expect(html).toContain('recortado');
  });

  it('keeps Hermes cron and gateway sessions out of Activos / Últimas 24 h', () => {
    const rows = [
      session('map', { source: 'hermes', section: '', lastActivityAt: 3 }),
      session('cron1', { source: 'hermes', section: 'cron', unit: null, lastActivityAt: 9 }),
      session('cron2', { source: 'hermes', section: 'cron', active: false, lastActivityAt: 1 }),
      session('tele', { source: 'hermes', section: 'gateway', unit: null, lastActivityAt: 5 }),
      session('old', { active: false, state: 'inactive', lastActivityAt: 2 }),
    ];
    const { active, recent, cron, gateway } = partitionSessions(rows);
    expect(active.map((r) => r.sessionId)).toEqual(['map']);
    expect(recent.map((r) => r.sessionId)).toEqual(['old']);
    expect(cron.map((r) => r.sessionId)).toEqual(['cron1', 'cron2']);
    expect(gateway.map((r) => r.sessionId)).toEqual(['tele']);
  });

  it('labels Hermes sessions by profile and strips model providers', () => {
    expect(sessionLabel({ agent: 'hermes', profile: 'cobalt' })).toBe('Hermes · cobalt');
    expect(sessionLabel({ agent: 'codex' })).toBe('Codex');
    expect(shortModel('meituan/longcat-2.0:free')).toBe('longcat-2.0:free');
    expect(shortModel('anthropic/claude-opus-5')).toBe('opus-5');
  });

  it('renders tool runs as names only, counted and escaped', () => {
    expect(summarizeTools(['terminal', 'read_file', 'terminal', 'terminal'])).toBe(
      'terminal ×3 · read_file',
    );
    expect(summarizeTools([])).toBe('');
    const html = chatMessagesHtml(
      [
        {
          role: 'tool',
          text: '',
          tools: ['terminal', '<b>x</b>'],
          at: null,
          truncated: false,
          turn: null,
        },
      ],
      'hermes',
    );
    expect(html).toContain('agents-msg--tool');
    expect(html).toContain('terminal · &lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });
});

describe('sessions / chat fetchers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists sessions and encodes the session id in the chat URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ sessions: [session('a')] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ session: session('a'), messages: [], available: true }),
      });
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchExternalSessions())?.[0]?.sessionId).toBe('a');
    const chat = await fetchExternalChat('claude-a/../x', { refresh: true, limit: 5 });
    expect(chat?.available).toBe(true);
    const url = String(fetchMock.mock.calls[1]![0]);
    expect(url).toContain('/api/external-agents/claude-a%2F..%2Fx/chat?');
    expect(url).toContain('limit=5');
    expect(url).toContain('refresh=1');
  });

  it('fetches the resume plan and encodes the session id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ mode: 'resume', command: 'cd /w && claude --resume a', note: '' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const plan = await fetchExternalResume('claude-a/../x');
    expect(plan?.command).toBe('cd /w && claude --resume a');
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      '/api/external-agents/claude-a%2F..%2Fx/resume',
    );
  });

  it('posts a reply and surfaces the refusal code as text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ state: 'running', startedAt: 1, finishedAt: null, error: '' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'session_is_live' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await sendExternalReply('claude-a', 'seguí');
    expect(ok).toMatchObject({ state: 'running' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/external-agents/claude-a/reply');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ text: 'seguí' });

    expect(await sendExternalReply('claude-a', 'hola')).toEqual({ error: 'session_is_live' });
    expect(replyErrorText('session_is_live')).toMatch(/no le escribo encima/);
    expect(replyErrorText('weird_code')).toContain('weird_code');
  });

  it('posts live chat text to the encoded session route and preserves results and errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ state: 'accepted', transport: 'codex-queue', requestId: 'req-1' }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: () => Promise.resolve({ error: 'transport_failed', detail: 'queue rejected' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    expect(await sendExternalChat('codex-a/../x', 'seguí')).toEqual({
      state: 'accepted',
      transport: 'codex-queue',
      requestId: 'req-1',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/external-agents/codex-a%2F..%2Fx/chat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ text: 'seguí' });

    expect(await sendExternalChat('codex-a', 'otra')).toEqual({
      error: 'transport_failed',
      detail: 'queue rejected',
    });
  });

  it('returns null when the bridge fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    expect(await fetchExternalSessions()).toBeNull();
    expect(await fetchExternalChat('x')).toBeNull();
    expect(await fetchExternalResume('x')).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchExternalChat('x')).toBeNull();
    expect(await fetchExternalResume('x')).toBeNull();
  });
});

describe('city refs (both id forms)', () => {
  it('decodes repo:<base64url> ids like the Vite plugin encodes them', () => {
    expect(decodeRepoCityId('repo:L3cvcmVwb2Npdg')).toBe('/w/repociv');
    expect(decodeRepoCityId('repo:L2hvbWUveC_DsWFuZMO6LXJlcG8vYSBi')).toBe(
      '/home/x/ñandú-repo/a b',
    );
    expect(decodeRepoCityId('repociv')).toBeNull();
    expect(decodeRepoCityId('repo:%%%')).toBeNull();
  });

  it('finds world-generated cities (id = repo name) from a repo: ref', () => {
    // generateWorld builds `id: repo.name`, addCityToWorld `id: repo.path` (repo:<b64>).
    const named = { ...city('repociv', 6, -2), repoPath: '/w/repociv/' };
    expect(findCityByRef([named], REPOCIV)?.id).toBe('repociv');
    expect(findCityByRef([named], '/w/repociv')?.id).toBe('repociv');
    expect(findCityByRef([named], 'repociv')?.id).toBe('repociv');
    expect(findCityByRef([named], 'repo:L3cvcmVwb2Npdi1vbGQ')).toBeUndefined(); // /w/repociv-old
  });

  it('places an ext unit in a name-id city (regression: it fell to the capital)', () => {
    const { state, ctx } = makeCtx();
    state.world.cities[1] = { ...state.world.cities[1]!, id: 'repociv', repoPath: '/w/repociv' };
    for (const evt of externalAgentEvents([], [row('ext-claude-code-bbbbbbbb')])) {
      dispatchBridgeEvent(ctx, evt);
    }
    const unit = state.getUnit('ext-claude-code-bbbbbbbb')!;
    expect(unit.cityId).toBe('repociv');
    expect(unit.coord).toEqual({ q: 6, r: -2 }); // on the city hex, not beside it
    expect(placeOnMap({ cityId: REPOCIV }, state.world.cities)).toMatchObject({
      kind: 'city',
      city: { id: 'repociv' },
    });
  });
});
