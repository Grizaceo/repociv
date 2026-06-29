// ─── RepoCiv — Bridge Events ──────────────────────────────────────────────────
// Listens for events from bridge.py via WebSocket (primary) or SSE (fallback).
// Sends user commands to bridge.py at http://localhost:5274.
// Handles reconnect with exponential backoff + demo mode fallback.

import { type GameState } from './game.ts';
import { type BridgeEvent, type CDailyArticle } from './types.ts';
import type { SuggestionRelation as WonderSuggestionRelation } from './wonders/types.ts';
import { logger } from './logger.ts';
import { parseBridgeEvent, describeBridgeEventError } from './bridgeSchema.ts';
import {
  logEvent,
  appendChatChunk,
  appendApprovalCard,
  setBridgeStatus,
  setOperationTicker,
  showNotification,
  updateGpuBar,
} from './ui/index.ts';
import { cfg } from './gameConfig.ts';
import { approveCommand } from './commandBus.ts';
import { terminalPanel } from './terminalPanel.ts';
import { bridgeHeaders, bridgeUrl, BRIDGE_URL, BRIDGE_TOKEN } from './bridgeEnv.ts';
import { RepoCivWebSocket } from './websocket.ts';
import { dispatchBridgeEvent, type MessageContext } from './bridgeMessageHandlers.ts';
import { registerPoll, type PollUnregister } from './ui/pollScheduler.ts';

const DEMO_INTERVAL_MS = 30_000;
const OFFLINE_DEMO_THRESHOLD_MS = 10_000;

export class BridgeEvents {
  private state: GameState;
  private stopHealthPoll: PollUnregister | null = null;
  private stopGpuPoll: PollUnregister | null = null;
  private reconnectDelay = 1000;
  private offlineSince: number | null = null;
  private demoInterval: ReturnType<typeof setInterval> | null = null;
  private lastHealthFlags: { cursor?: boolean } = {};
  rendererRef: { panTo: (x: number, y: number) => void } | null = null;

  // ─── Transports ──────────────────────────────────────────────────────────
  private ws: RepoCivWebSocket | null = null;
  private sse: EventSource | null = null;
  private sseConnected = false;
  private sseReconnectTimer = 0;
  private wsConnected = false;
  private wsEnabled = true; // Set false after WS connection fails
  private stopped = false;
  bridgeOnline = false;

  // Resolved WS URL — discovered by fetching /ws endpoint or configured
  private wsUrl = '';

  constructor(state: GameState) {
    this.state = state;
  }

  start() {
    this.stopped = false;
    // Try to discover WS endpoint first, fall back to SSE
    this._discoverWs();
    if (import.meta.hot) {
      import.meta.hot.on('bridge:event', (data: unknown) => {
        if (!this.wsConnected && !this.sseConnected) this.handleRaw(data);
      });
    }
    this.checkHealth();
    this.stopHealthPoll = registerPoll('bridge:health', () => void this.checkHealth(), 5_000, {
      immediate: false,
    });
    this.stopGpuPoll = registerPoll('bridge:gpu', () => void this.fetchGpu(), 5_000, {
      immediate: false,
      phaseMs: 2_500,
    });
  }

  /** Discover the WebSocket URL from the bridge /ws endpoint */
  private async _discoverWs() {
    try {
      const BRIDGE_WS_PORT = 5275; // Matches BRIDGE_WS_PORT default in Python
      // Try to fetch /ws endpoint for the port; fall back to default
      const res = await fetch(bridgeUrl('/ws'), {
        method: 'GET',
        headers: bridgeHeaders(),
      });
      if (res.ok) {
        const info = (await res.json()) as {
          wsUrl?: string;
          wsPort?: number;
        };
        this.wsUrl = info.wsUrl ?? `ws://localhost:${BRIDGE_WS_PORT}`;
      } else {
        // Use configured BRIDGE_URL + default WS port
        const base = BRIDGE_URL || `http://localhost:${BRIDGE_WS_PORT}`;
        this.wsUrl = base.replace(/^http/, 'ws');
      }
    } catch {
      this.wsUrl = `ws://localhost:5275`;
    }

    // Try WS first
    this._connectWs();
  }

  private handleRaw(data: unknown) {
    const evt = parseBridgeEvent(data);
    if (!evt) {
      const reason = describeBridgeEventError(data);
      const summary = JSON.stringify(data).slice(0, 120);
      logger.warn('[bridge] descartando evento inválido:', reason, summary);
      logEvent(`Evento inválido descartado (${reason})`, 'warn');
      return;
    }
    this.handleBridgeEvent(evt);
  }

  // ─── WebSocket transport (primary) ──────────────────────────────────────

  private _connectWs() {
    if (!this.wsEnabled) return;
    if (this.ws) this.ws.close();

    const token = BRIDGE_URL ? '' : (bridgeHeaders()['X-RepoCiv-Token'] ?? '');
    this.ws = new RepoCivWebSocket({
      url: this.wsUrl,
      token,
    });

    this.ws.onMessage((data) => {
      this.handleRaw(data);
    });

    this.ws.onStatusChange((status) => {
      if (status === 'connected') {
        this.wsConnected = true;
        this.sseConnected = false;
        this.reconnectDelay = 1000;
        this.onBridgeOnline('hermes');
      } else if (status === 'disconnected' || status === 'auth_failed') {
        this.wsConnected = false;
        // Fall back to SSE after WS fails
        if (this.wsEnabled) {
          this.wsEnabled = false;
          logger.log('[bridge] WS falló — cambiando a SSE');
          this.connectSSE();
        }
      }
    });

    this.ws.connect();
  }

  private _sendViaWs(type: string, payload: Record<string, unknown>): boolean {
    return this.ws?.send({ type, ...payload }) ?? false;
  }

  // ─── SSE transport (fallback) ───────────────────────────────────────────

  private connectSSE() {
    if (this.stopped) return;
    if (this.sse) this.sse.close();
    try {
      // EventSource cannot send custom headers — bridge accepts the token
      // via query param for the SSE stream only. Limitation: the token may
      // appear in browser history, proxy logs, and Referer headers; a
      // short-lived ticket would require server support (not available yet).
      const tokenQs = BRIDGE_TOKEN ? `?token=${encodeURIComponent(BRIDGE_TOKEN)}` : '';
      const src = new EventSource(bridgeUrl('/events') + tokenQs);
      this.sse = src;
      src.onopen = () => {
        this.sseConnected = true;
        this.reconnectDelay = 1000;
      };
      src.onmessage = (e: MessageEvent<string>) => {
        try {
          const data = JSON.parse(e.data) as unknown;
          if (
            typeof data === 'object' &&
            data !== null &&
            (data as { type?: unknown }).type === 'ping'
          )
            return;
          this.handleRaw(data);
        } catch (err) {
          logger.warn('[bridge] SSE payload inválido:', err);
        }
      };
      src.onerror = () => {
        this.sseConnected = false;
        src.close();
        if (this.sse === src) this.sse = null;
        if (this.stopped) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        this.sseReconnectTimer = window.setTimeout(() => {
          this.sseReconnectTimer = 0;
          this.connectSSE();
        }, delay);
      };
    } catch (err) {
      this.sseConnected = false;
      logger.warn('[bridge] SSE no disponible:', err);
    }
  }

  private _authHeaders(): Record<string, string> {
    return bridgeHeaders();
  }

  private async checkHealth() {
    try {
      // If WS is connected, bridge is healthy — no need to hit HTTP
      if (this.wsConnected) {
        if (!this.bridgeOnline) this.onBridgeOnline('hermes');
        return;
      }
      const res = await fetch(bridgeUrl('/health'), {
        method: 'GET',
        headers: this._authHeaders(),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          ok: boolean;
          openclaw: boolean;
          claudeCode: boolean;
          cursor: boolean;
          defaultTransport?: string;
        };
        const dt = data.defaultTransport ?? 'hermes';
        const mode: 'claude-code' | 'openclaw' | 'hermes' =
          dt === 'claude-code' && data.claudeCode
            ? 'claude-code'
            : dt === 'openclaw' && data.openclaw
              ? 'openclaw'
              : 'hermes';
        this.lastHealthFlags = { cursor: data.cursor };
        // Bridge recovered over HTTP — retry WS if we previously fell back to SSE.
        if (!this.wsEnabled && !this.stopped) {
          this.wsEnabled = true;
          this._connectWs();
        }
        this.onBridgeOnline(mode);
        return;
      }
    } catch {
      // fall through
    }
    this.onBridgeOffline();
  }

  private onBridgeOnline(mode: 'claude-code' | 'openclaw' | 'hermes') {
    this.bridgeOnline = true;
    this.offlineSince = null;
    this.reconnectDelay = 1000;
    this.stopDemo();
    setBridgeStatus(true, mode, this.lastHealthFlags);
  }

  private onBridgeOffline() {
    if (this.bridgeOnline) {
      this.offlineSince = Date.now();
      logEvent('Bridge offline — reintentando…', 'warn');
    }
    this.bridgeOnline = false;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    setBridgeStatus(false);

    if (this.offlineSince && Date.now() - this.offlineSince > OFFLINE_DEMO_THRESHOLD_MS) {
      this.startDemo();
    }
  }

  private startDemo() {
    if (this.demoInterval) return;
    setBridgeStatus(false, 'demo' as never);
    logEvent('⚠ DEMO — bridge offline. Datos simulados, sin ejecución real.', 'warn');
    this.demoInterval = setInterval(() => {
      logEvent('[DEMO] Pulso simulado — bridge sigue offline', 'warn');
    }, DEMO_INTERVAL_MS);
  }

  private stopDemo() {
    if (this.demoInterval) {
      clearInterval(this.demoInterval);
      this.demoInterval = null;
    }
  }

  private async fetchGpu() {
    if (!this.bridgeOnline) return;
    try {
      const res = await fetch(bridgeUrl('/gpu'), { headers: this._authHeaders() });
      if (res.ok) {
        const data = (await res.json()) as {
          vramUsed?: number;
          vramTotal?: number;
          temp?: number;
        } | null;
        updateGpuBar(data);
      }
    } catch {
      // GPU endpoint optional
    }
  }

  handleBridgeEvent(evt: BridgeEvent) {
    // Pure dispatch — all per-event logic lives in bridgeMessageHandlers.ts.
    // The BridgeEvents class only owns transport, health, and demo mode;
    // event interpretation is its own concern.
    dispatchBridgeEvent(this.getMessageContext(), evt);
  }

  /**
   * Builds the context object that bridgeMessageHandlers.ts receives on
   * every dispatch. Built once and cached — the captured references are
   * top-level functions and the same GameState instance, so the
   * context never changes after start().
   */
  private _ctx: MessageContext | null = null;
  private getMessageContext(): MessageContext {
    if (this._ctx === null) {
      const ctx: MessageContext = {
        state: this.state,
        logEvent,
        setOperationTicker,
        appendChatChunk,
        appendApprovalCard,
        showNotification,
        terminalPanel,
        playSound,
        approveCommand,
        cfg,
      };
      this._ctx = ctx;
      return ctx;
    }
    return this._ctx;
  }

  async sendApproval(commandId: string, approved: boolean) {
    // Prefer WS for approvals
    if (this.wsConnected) {
      this._sendViaWs('approval', { id: commandId, approved });
      return;
    }
    const res = await fetch(bridgeUrl(`/approvals/${encodeURIComponent(commandId)}/approve`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify({ approved }),
    });
    if (!res.ok) {
      logEvent(`Error al ${approved ? 'aprobar' : 'rechazar'} comando ${commandId}`, 'warn');
    }
  }

  // ─── Send legacy command to bridge.py root POST ───────────────────────────
  send(type: string, payload: Record<string, unknown>) {
    if (!this.bridgeOnline) return;
    // Prefer WS for commands
    if (this.wsConnected) {
      this._sendViaWs('command', { data: { type, ...payload } });
      return;
    }
    fetch(bridgeUrl(''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify({ type, ...payload }),
    }).catch(() => {});
  }

  stop() {
    this.stopped = true;
    if (this.stopHealthPoll) {
      this.stopHealthPoll();
      this.stopHealthPoll = null;
    }
    if (this.stopGpuPoll) {
      this.stopGpuPoll();
      this.stopGpuPoll = null;
    }
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = 0;
    }
    this.ws?.close();
    this.ws = null;
    this.wsConnected = false;
    this.sse?.close();
    this.sse = null;
    this.sseConnected = false;
    this.stopDemo();
  }
}

// ─── Web Audio sound effects ─────────────────────────────────────────────────
type SoundType = 'move' | 'complete' | 'mission';

let _audioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (!_audioCtx) _audioCtx = new AudioContext();
  return _audioCtx;
}

function playSound(type: SoundType) {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'move') {
      osc.frequency.value = 550;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    } else if (type === 'complete') {
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } else if (type === 'mission') {
      // Cascade ascendente
      const freqs = [440, 550, 660, 880];
      freqs.forEach((f, i) => {
        const o2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        o2.connect(g2);
        g2.connect(ctx.destination);
        o2.frequency.value = f;
        const t = ctx.currentTime + i * 0.08;
        g2.gain.setValueAtTime(0.18, t);
        g2.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        o2.start(t);
        o2.stop(t + 0.2);
      });
    }
  } catch {
    // AudioContext not available
  }
}

// ─── CDaily Integration helpers ───────────────────────────────────────────────
export async function getLatestNews(): Promise<CDailyArticle[]> {
  try {
    const res = await fetch(bridgeUrl('/api/news/latest'), {
      headers: bridgeHeaders(),
    });
    if (!res.ok) return [];
    return (await res.json()) as CDailyArticle[];
  } catch {
    return [];
  }
}

export async function markNewsAsRead(id: number): Promise<boolean> {
  try {
    const res = await fetch(bridgeUrl('/api/news/read'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      body: JSON.stringify({ id }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function scanNews(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(bridgeUrl('/api/news/scan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      body: JSON.stringify({}),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    return { ok: data.ok ?? res.ok, error: data.error };
  } catch (e) {
    // scan error logged silently in production
    return { ok: false, error: String(e) };
  }
}

export interface NewsSource {
  id: number;
  name: string;
  url: string;
}

export async function getNewsSources(): Promise<NewsSource[]> {
  try {
    const res = await fetch(bridgeUrl('/api/news/sources'), { headers: bridgeHeaders() });
    if (!res.ok) return [];
    return (await res.json()) as NewsSource[];
  } catch {
    return [];
  }
}

export async function addNewsSource(
  name: string,
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(bridgeUrl('/api/news/sources/add'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      body: JSON.stringify({ name, url }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    return { ok: data.ok ?? res.ok, error: data.error };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function removeNewsSource(name: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(bridgeUrl('/api/news/sources/remove'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      body: JSON.stringify({ name }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    return { ok: data.ok ?? res.ok, error: data.error };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ─── Foreign Relations API ─────────────────────────────────────────────────────
// (getRepoProfile / scoreArticleRepo wrappers removed — no frontend callers;
//  the backend endpoints remain reachable via MCP and HTTP.)

export async function generateForeignReport(
  articleOrArticles: import('./types.ts').CDailyArticle | import('./types.ts').CDailyArticle[],
  repoPath: string,
  targetCityId?: string,
  agentId?: string,
): Promise<import('./types.ts').ForeignRelationsReport | null> {
  try {
    const articles = Array.isArray(articleOrArticles) ? articleOrArticles : [articleOrArticles];
    const res = await fetch(bridgeUrl('/api/foreign/report'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      body: JSON.stringify({
        article: articles[0],
        articles,
        repoPath,
        targetCityId: targetCityId ?? '',
        agentId: agentId ?? 'diplomat',
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as import('./types.ts').ForeignRelationsReport;
  } catch {
    return null;
  }
}

export async function listForeignReports(
  cityId?: string,
  articleId?: string,
): Promise<import('./types.ts').ForeignRelationsReport[]> {
  try {
    const params = new URLSearchParams();
    if (cityId) params.set('cityId', cityId);
    if (articleId) params.set('articleId', articleId);
    const qs = params.toString();
    const res = await fetch(bridgeUrl(`/api/foreign/reports${qs ? '?' + qs : ''}`), {
      headers: bridgeHeaders(),
    });
    if (!res.ok) return [];
    return (await res.json()) as import('./types.ts').ForeignRelationsReport[];
  } catch {
    return [];
  }
}

export async function getForeignReport(
  reportId: string,
): Promise<import('./types.ts').ForeignRelationsReport | null> {
  try {
    const res = await fetch(bridgeUrl(`/api/foreign/reports/${encodeURIComponent(reportId)}`), {
      headers: bridgeHeaders(),
    });
    if (!res.ok) return null;
    return (await res.json()) as import('./types.ts').ForeignRelationsReport;
  } catch {
    return null;
  }
}

// ─── Graph Relations API ──────────────────────────────────────────────────────

export interface GraphRelationCandidate extends WonderSuggestionRelation {
  toCityId?: string;
}

interface GraphRelationsResponse {
  cityId: string;
  count: number;
  relations: GraphRelationCandidate[];
}

export interface GraphRelationStats {
  nodes: number;
  edges: number;
  last_updated: number;
  flags: { graphSuggestions: boolean; aiRelationDiscovery: boolean };
}

export async function fetchGraphRelations(
  cityId: string,
  cities: Array<{ id: string; name: string; repoPath?: string }>,
  limit = 10,
): Promise<GraphRelationCandidate[]> {
  try {
    const params = new URLSearchParams({ cityId, limit: String(limit) });
    if (cities.length > 0) {
      params.set('cities', JSON.stringify(cities));
    }
    const res = await fetch(bridgeUrl(`/api/graph-relations?${params.toString()}`), {
      headers: bridgeHeaders(),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as GraphRelationsResponse;
    return data.relations ?? [];
  } catch {
    return [];
  }
}

export async function syncGraphRelationFlags(payload: {
  graphSuggestions?: boolean;
  aiRelationDiscovery?: boolean;
}): Promise<{ ok: boolean; flags?: GraphRelationStats['flags']; error?: string }> {
  try {
    const res = await fetch(bridgeUrl('/api/graph-relations/flags'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return (await res.json()) as {
      ok: boolean;
      flags?: GraphRelationStats['flags'];
      error?: string;
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// (fetchGraphRelationEvidence / fetchGraphRelationStats / refreshGraphRelationIndex
// wrappers removed — no frontend callers; the backend endpoints remain.)
