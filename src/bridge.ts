// ─── RepoCiv — Bridge Events ──────────────────────────────────────────────────
// Listens for events from bridge.py via Vite HMR custom events.
// Sends user commands to bridge.py at http://localhost:5274.
// Handles reconnect with exponential backoff + demo mode fallback.

import { type GameState } from './game.ts';
import { type BridgeEvent } from './types.ts';
import { logger } from './logger.ts';
import { parseBridgeEvent, describeBridgeEventError } from './bridgeSchema.ts';
import {
  logEvent,
  appendChatChunk,
  setBridgeStatus,
  setOperationTicker,
  updateGpuBar,
  showNotification,
} from './ui/index.ts';
import { openApprovalPanel } from './ui/approvalPanel.ts';
import { terminalPanel } from './terminalPanel.ts';
import { bridgeHeaders, bridgeUrl } from './bridgeEnv.ts';

const DEMO_INTERVAL_MS = 30_000;
const OFFLINE_DEMO_THRESHOLD_MS = 10_000;

export class BridgeEvents {
  private state: GameState;
  private healthInterval = 0;
  private reconnectDelay = 1000;
  private offlineSince: number | null = null;
  private demoInterval: ReturnType<typeof setInterval> | null = null;
  private gpuInterval = 0;
  private sse: EventSource | null = null;
  private sseConnected = false;
  bridgeOnline = false;

  constructor(state: GameState) {
    this.state = state;
  }

  start() {
    this.connectSSE();
    if (import.meta.hot) {
      import.meta.hot.on('bridge:event', (data: unknown) => {
        if (!this.sseConnected) this.handleRaw(data);
      });
    }
    this.checkHealth();
    this.healthInterval = window.setInterval(() => this.checkHealth(), 5000);
    this.gpuInterval = window.setInterval(() => this.fetchGpu(), 5000);
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
    setBridgeStatus(true, mode);
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
      // Solo feedback visual — NO disparar handleBridgeEvent para no falsear el estado del juego
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
        const unit = this.state.spawnUnit(
          evt.unit,
          evt.unit,
          evt.unitType ?? 'hero',
          evt.civ,
          { q: evt.hex[0], r: evt.hex[1] },
          evt.mission,
        );
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
        if (evt.success) playSound('mission');
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
      case 'waiting_approval':
        logEvent(
          `⏳ Aprobación requerida: ${evt.commandType} → ${evt.target} [${evt.risk}]`,
          'warn',
        );
        openApprovalPanel();
        break;
      case 'context_exhausted': {
        logEvent(`⚠ Contexto agotado para ${evt.unit}`, 'warn');
        break;
      }
      default:
        break;
    }
  }

  async sendApproval(commandId: string, approved: boolean) {
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
    fetch(bridgeUrl(''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify({ type, ...payload }),
    }).catch(() => {});
  }

  stop() {
    clearInterval(this.healthInterval);
    clearInterval(this.gpuInterval);
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


