// ─── RepoCiv — Bridge Events ──────────────────────────────────────────────────
// Listens for events from bridge.py via WebSocket (primary) or SSE (fallback).
// Sends user commands to bridge.py at http://localhost:5274.
// Handles reconnect with exponential backoff + demo mode fallback.

import { type GameState, pickDetachmentHex } from './game.ts';
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
  updateGpuBar,
  showNotification,
} from './ui/index.ts';
import { cfg } from './gameConfig.ts';
import { approveCommand } from './commandBus.ts';
import { terminalPanel } from './terminalPanel.ts';
import { bridgeHeaders, bridgeUrl, BRIDGE_URL } from './bridgeEnv.ts';
import { RepoCivWebSocket } from './websocket.ts';

const DEMO_INTERVAL_MS = 30_000;
const OFFLINE_DEMO_THRESHOLD_MS = 10_000;

export class BridgeEvents {
  private state: GameState;
  private healthInterval = 0;
  private reconnectDelay = 1000;
  private offlineSince: number | null = null;
  private demoInterval: ReturnType<typeof setInterval> | null = null;
  private lastHealthFlags: { cursor?: boolean } = {};
  private gpuInterval = 0;
  rendererRef: { panTo: (x: number, y: number) => void } | null = null;

  // ─── Transports ──────────────────────────────────────────────────────────
  private ws: RepoCivWebSocket | null = null;
  private sse: EventSource | null = null;
  private sseConnected = false;
  private wsConnected = false;
  private wsEnabled = true; // Set false after WS connection fails
  bridgeOnline = false;

  // Resolved WS URL — discovered by fetching /ws endpoint or configured
  private wsUrl = '';

  constructor(state: GameState) {
    this.state = state;
  }

  start() {
    // Try to discover WS endpoint first, fall back to SSE
    this._discoverWs();
    if (import.meta.hot) {
      import.meta.hot.on('bridge:event', (data: unknown) => {
        if (!this.wsConnected && !this.sseConnected) this.handleRaw(data);
      });
    }
    this.checkHealth();
    this.healthInterval = window.setInterval(() => this.checkHealth(), 5000);
    // Stagger GPU poll so both timers don't fire simultaneously
    window.setTimeout(() => {
      this.fetchGpu();
      this.gpuInterval = window.setInterval(() => this.fetchGpu(), 5000);
    }, 2500);
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
      if (!this.wsConnected) {
        this.wsConnected = true;
        this.sseConnected = false;
      }
      this.handleRaw(data);
    });

    this.ws.onStatusChange((status) => {
      if (status === 'connected') {
        this.wsConnected = true;
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
    if (this.sse) this.sse.close();
    try {
      const src = new EventSource(bridgeUrl('/events'));
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
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
        window.setTimeout(() => this.connectSSE(), delay);
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
    switch (evt.type) {
      case 'unit_spawn': {
        const parent = evt.parentUnit ? this.state.getUnit(evt.parentUnit) : undefined;
        let spawnCoord = { q: evt.hex[0], r: evt.hex[1] };
        if (parent && evt.hex[0] === 0 && evt.hex[1] === 0) {
          const childIndex = this.state
            .getChildrenOfUnit(parent.id)
            .filter((c) => c.ephemeral).length;
          spawnCoord = pickDetachmentHex(this.state, parent.coord, childIndex);
        }
        const unit = this.state.spawnUnit(
          evt.unit,
          evt.unit,
          evt.unitType ?? 'hero',
          evt.civ,
          spawnCoord,
          evt.mission,
          evt.cityId,
          {
            parentUnitId: evt.parentUnit,
            ephemeral: evt.ephemeral,
            subagentRunId: evt.subagentRunId,
          },
        );
        if (evt.ephemeral && evt.cityId && evt.unitType === 'caravan') {
          const targetCity = this.state.world.cities.find((c) => c.id === evt.cityId);
          if (targetCity) this.state.moveUnit(unit.id, targetCity.coord);
        }
        logEvent(`Unidad ${unit.name} apareció en el mapa`, 'success');
        break;
      }
      case 'unit_move':
        this.state.moveUnit(evt.unit, { q: evt.to[0], r: evt.to[1] });
        break;
      case 'unit_despawn': {
        const ok = this.state.removeUnit(evt.unit);
        if (ok) logEvent(`Unidad ${evt.unit} desapareció del mapa`, 'warn');
        break;
      }
      case 'unit_state':
        this.state.setUnitState(evt.unit, evt.state);
        if (evt.state === 'working') setOperationTicker(true, `${evt.unit} trabajando…`);
        else if (evt.state === 'idle') setOperationTicker(false);
        break;
      case 'unit_work':
        if (evt.cityId) this.state.setUnitCity(evt.unit, evt.cityId);
        this.state.setUnitWorkProgress(evt.unit, evt.progress);
        break;
      case 'building_start':
        this.state.startBuilding(
          evt.city,
          evt.building,
          evt.building,
          evt.durationSeconds,
          evt.buildingType ?? 'building',
        );
        logEvent(`◆ ${evt.building}`, 'info');
        break;
      case 'building_complete':
        this.state.completeBuilding(evt.city, evt.building);
        this.state.invalidatePathCache();
        logEvent(`✓ ${evt.building}`, 'success');
        showNotification({
          type: 'success',
          title: 'Construcción completada',
          body: `${evt.city} → ${evt.building}`,
        });
        playSound('complete');
        break;
      case 'building_failed':
        this.state.failBuilding(evt.city, evt.building);
        logEvent(`✗ ${evt.building}`, 'warn');
        showNotification({
          type: 'error',
          title: 'Construcción fallida',
          body: `${evt.city} → ${evt.building}`,
        });
        break;
      case 'mission_start':
        this.state.startMission(evt.missionId, evt.unit, evt.questName);
        logEvent(`▶ ${evt.questName}`, 'info');
        break;
      case 'mission_complete': {
        this.state.completeMission(evt.missionId, evt.success);
        setOperationTicker(false);
        const durLabel =
          evt.duration >= 60 ? `${Math.round(evt.duration / 60)}m` : `${evt.duration}s`;
        showNotification({
          type: evt.success ? 'success' : 'error',
          title: evt.success ? 'Misión completada' : 'Misión fallida',
          body: `${evt.unit} · ${durLabel}`,
          unit: evt.unit,
          ttl: evt.success ? 6000 : 8000,
        });
        if (evt.success) {
          playSound('mission');
          // Visual celebration — lazy import keeps payoffs out of the initial bundle
          const canvas = document.getElementById('main-canvas') as HTMLCanvasElement | null;
          if (canvas) {
            import('./ui/payoffs.ts').then(({ celebrateMission }) => {
              celebrateMission(canvas);
            });
          }
        }
        break;
      }
      case 'chat_chunk':
        appendChatChunk(evt.unit, evt.text);
        terminalPanel.write(`[${evt.unit}] ${evt.text}`);
        break;
      case 'log':
        logEvent(evt.msg, evt.level ?? 'info');
        break;
      case 'resource_update': {
        const el = document.querySelector<HTMLElement>(`#res-${evt.resource} .res-value`);
        if (el) {
          const prev = parseInt(el.textContent?.replace(/[^\d]/g, '') ?? '0', 10);
          el.textContent = (prev + evt.delta).toLocaleString();
        }
        break;
      }
      // Phase 9: XCOM Context Fatigue events
      case 'unit_fatigue_update': {
        this.state.updateUnitFatigue(
          evt.unit,
          evt.fatigue,
          evt.maxFatigue ?? 100,
          evt.atRest ?? false,
          evt.restAreaId ?? null,
        );
        break;
      }
      case 'unit_sent_to_rest': {
        this.state.updateUnitFatigue(
          evt.unit,
          evt.fatigue,
          evt.maxFatigue,
          evt.atRest,
          evt.restAreaId,
        );
        logEvent(`🛌 ${evt.unit} enviado a descanso`, 'info');
        break;
      }
      case 'rest_area_discovered': {
        const ra = evt.restArea;
        this.state.addRestArea({
          id: ra.id,
          roomId: ra.roomId,
          coord: { q: ra.coord[0], r: ra.coord[1] },
          recoveryRate: ra.recoveryRate,
          capacity: ra.capacity,
          unitsInside: ra.unitsInside,
        });
        logEvent(`☕ Área de descanso descubierta: ${ra.roomId}`, 'info');
        break;
      }
      case 'rest_area_entered': {
        this.state.setUnitResting(evt.unit, true, evt.restAreaId);
        logEvent(`${evt.unit} entró al área de descanso`, 'info');
        break;
      }
      case 'rest_area_exited': {
        this.state.setUnitResting(evt.unit, false);
        logEvent(`${evt.unit} salió del área de descanso`, 'info');
        break;
      }
      case 'waiting_approval': {
        // Auto-approve execute_agent (chat) when the setting is on — user already
        // expressed intent by typing and sending the message.
        if (evt.commandType === 'execute_agent' && cfg.trust.autoApproveChat) {
          void approveCommand(evt.commandId);
          break;
        }
        logEvent(
          `⏳ Aprobación requerida: ${evt.commandType} → ${evt.target} [${evt.risk}]`,
          'warn',
        );
        const approvalUnit = evt.target;
        appendApprovalCard(approvalUnit, evt.commandId, evt.commandType, evt.target, evt.risk);
        break;
      }
      case 'context_exhausted': {
        logEvent(`⚠ Contexto agotado para ${evt.unit}`, 'warn');
        break;
      }
      case 'fog_reveal':
        this.state.revealHexes(evt.hexes, evt.cityId);
        logEvent(`🌫 Niebla disipada (${evt.hexes.length} hexes)`, 'info');
        break;
      case 'subagent_spawn': {
        const parentUnit = this.state.getUnit(evt.parentUnit);
        const spawnStatus = evt.status ?? 'running';
        this.state.registerSubagent({
          id: evt.subagentId,
          parentMissionId: evt.parentMissionId,
          parentUnitId: evt.parentUnit,
          kind: evt.kind,
          label: evt.label,
          status: spawnStatus,
          risk: evt.risk as import('./types.ts').SubagentRisk,
          targetCityId: evt.targetCityId,
          ephemeralUnitId: evt.ephemeralUnitId,
          startedAt: Date.now(),
          unitType: evt.unitType,
          parentHarness: evt.parentHarness,
          harness: evt.harness ?? evt.parentHarness,
          lastProgressAt: Date.now(),
        });
        if (spawnStatus === 'running') {
          const childIndex = parentUnit
            ? this.state.getChildrenOfUnit(parentUnit.id).filter((c) => c.ephemeral).length
            : 0;
          const coord = parentUnit
            ? pickDetachmentHex(this.state, parentUnit.coord, childIndex)
            : { q: evt.hex[0], r: evt.hex[1] };
          this.state.spawnUnit(
            evt.ephemeralUnitId,
            evt.label.slice(0, 12) || evt.kind,
            evt.unitType ?? 'scout',
            'capital',
            coord,
            evt.label,
            evt.targetCityId,
            {
              parentUnitId: evt.parentUnit,
              ephemeral: true,
              subagentRunId: evt.subagentId,
            },
          );
          this.state.syncSubagentSpawn({
            ephemeralUnitId: evt.ephemeralUnitId,
            parentUnitId: evt.parentUnit,
            kind: evt.kind,
            label: evt.label,
            repoId: evt.targetCityId ?? parentUnit?.cityId ?? '',
          });
          this.state.setUnitState(evt.ephemeralUnitId, 'working');
          logEvent(`◈ Detachment: ${evt.label.slice(0, 40)}`, 'info');
        } else {
          logEvent(`◈ Detachment propuesto: ${evt.label.slice(0, 40)} (pendiente aprobación)`, 'info');
        }
        break;
      }
      case 'subagent_progress': {
        const progressText = evt.text ?? evt.phase ?? '…';
        this.state.appendSubagentProgress(evt.subagentId, progressText);
        let run = this.state.subagents.get(evt.subagentId);
        if (run?.status === 'proposed') {
          this.state.updateSubagent(evt.subagentId, { status: 'running', lastProgressAt: Date.now() });
          run = this.state.subagents.get(evt.subagentId);
        } else if (run) {
          this.state.updateSubagent(evt.subagentId, { lastProgressAt: Date.now() });
        }
        if (run?.ephemeralUnitId) {
          this.state.setUnitState(run.ephemeralUnitId, 'working');
        }
        break;
      }
      case 'subagent_complete':
        if (evt.outputFilePath) {
          this.state.updateSubagent(evt.subagentId, { outputFilePath: evt.outputFilePath });
        }
        this.state.completeSubagent(evt.subagentId, evt.success, evt.summary);
        logEvent(
          evt.success
            ? `✓ Subagente completado (${Math.round(evt.duration)}s)`
            : `✗ Subagente falló`,
          evt.success ? 'success' : 'warn',
        );
        break;
      case 'subagent_proposed':
        this.state.registerSubagent({
          id: evt.subagentId,
          parentMissionId: evt.parentMissionId,
          parentUnitId: evt.parentUnit,
          kind: evt.kind,
          label: evt.label,
          status: 'proposed',
          risk: evt.risk as import('./types.ts').SubagentRisk,
          startedAt: Date.now(),
        });
        logEvent(`⏳ Subagente propuesto [${evt.risk}]: ${evt.label.slice(0, 40)}`, 'warn');
        break;
      case 'subagent_cancel':
        this.state.cancelSubagent(evt.subagentId, 'cancelled by user (Recall)');
        logEvent(`Subagente cancelado: ${evt.subagentId}`, 'warn');
        break;
      default:
        break;
    }
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
    clearInterval(this.healthInterval);
    clearInterval(this.gpuInterval);
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

// ─── Foreign Relations API ─────────────────────────────────────────────────────

export async function getRepoProfile(
  repoPath: string,
): Promise<import('./types.ts').RepoProfile | null> {
  try {
    const res = await fetch(
      bridgeUrl(`/api/foreign/repo-profile?repoPath=${encodeURIComponent(repoPath)}`),
      {
        headers: bridgeHeaders(),
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as import('./types.ts').RepoProfile;
  } catch {
    return null;
  }
}

export async function scoreArticleRepo(
  article: import('./types.ts').CDailyArticle,
  repoPath: string,
): Promise<import('./types.ts').ForeignScoreResponse | null> {
  try {
    const res = await fetch(bridgeUrl('/api/foreign/score'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      body: JSON.stringify({ article, repoPath }),
    });
    if (!res.ok) return null;
    return (await res.json()) as import('./types.ts').ForeignScoreResponse;
  } catch {
    return null;
  }
}

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

export interface GraphRelationsResponse {
  cityId: string;
  count: number;
  relations: GraphRelationCandidate[];
}

export interface GraphRelationEvidence {
  from_id: string;
  to_id: string;
  exists: boolean;
  relation?: GraphRelationCandidate;
  jaccard_scores?: Record<string, number>;
  coactivity?: { score: number; evidence: string[] };
  fromCityName?: string;
  toCityName?: string;
  fromRepoPath?: string;
  toRepoPath?: string;
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

export async function fetchGraphRelationEvidence(
  fromId: string,
  toId: string,
  cities: Array<{ id: string; name: string; repoPath?: string }>,
): Promise<GraphRelationEvidence | null> {
  try {
    const params = new URLSearchParams({ fromId, toId });
    if (cities.length > 0) {
      params.set('cities', JSON.stringify(cities));
    }
    const res = await fetch(bridgeUrl(`/api/graph-relations/evidence?${params.toString()}`), {
      headers: bridgeHeaders(),
    });
    if (!res.ok) return null;
    return (await res.json()) as GraphRelationEvidence;
  } catch {
    return null;
  }
}

export async function fetchGraphRelationStats(): Promise<GraphRelationStats | null> {
  try {
    const res = await fetch(bridgeUrl('/api/graph-relations/stats'), {
      headers: bridgeHeaders(),
    });
    if (!res.ok) return null;
    return (await res.json()) as GraphRelationStats;
  } catch {
    return null;
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

export async function refreshGraphRelationIndex(payload: {
  cities?: Array<{ id: string; name: string; repoPath?: string }>;
  repoPaths?: string[];
}): Promise<{ ok: boolean; error?: string; stats?: Record<string, unknown> }> {
  try {
    const res = await fetch(bridgeUrl('/api/graph-relations/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return (await res.json()) as { ok: boolean; error?: string; stats?: Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
