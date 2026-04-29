// ─── RepoCiv — Bridge Events ──────────────────────────────────────────────────
// Listens for events from bridge.py via Vite HMR custom events.
// Sends user commands to bridge.py at http://localhost:5274.
// Handles reconnect with exponential backoff + demo mode fallback.

import { type GameState } from './game.ts';
import { type BridgeEvent } from './types.ts';
import { parseBridgeEvent, describeBridgeEventError } from './bridgeSchema.ts';
import { logEvent, appendChatChunk, setBridgeStatus, setOperationTicker, updateGpuBar } from './ui/index.ts';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:5274';
const BRIDGE_TOKEN = import.meta.env.VITE_BRIDGE_TOKEN ?? '';
const DEMO_INTERVAL_MS = 30_000;
const OFFLINE_DEMO_THRESHOLD_MS = 10_000;

export class BridgeEvents {
  private state: GameState;
  private healthInterval = 0;
  private reconnectDelay = 1000;
  private offlineSince: number | null = null;
  private demoInterval: ReturnType<typeof setInterval> | null = null;
  private gpuInterval = 0;
  bridgeOnline = false;

  constructor(state: GameState) {
    this.state = state;
  }

  start() {
    if (import.meta.hot) {
      import.meta.hot.on('bridge:event', (data: unknown) => {
        const evt = parseBridgeEvent(data);
        if (!evt) {
          const reason = describeBridgeEventError(data);
          const summary = JSON.stringify(data).slice(0, 120);
          console.warn('[bridge] descartando evento inválido:', reason, summary);
          logEvent(`Evento inválido descartado (${reason})`, 'warn');
          return;
        }
        this.handleBridgeEvent(evt);
      });
    }
    this.checkHealth();
    this.healthInterval = window.setInterval(() => this.checkHealth(), 5000);
    this.gpuInterval = window.setInterval(() => this.fetchGpu(), 5000);
  }

  private _authHeaders(): Record<string, string> {
    return BRIDGE_TOKEN ? { 'X-RepoCiv-Token': BRIDGE_TOKEN } : {};
  }

  private async checkHealth() {
    try {
      const res = await fetch(`${BRIDGE_URL}/health`, { method: 'GET', headers: this._authHeaders() });
      if (res.ok) {
        const data = await res.json() as { ok: boolean; openclaw: boolean };
        this.onBridgeOnline(data.openclaw ? 'openclaw' : 'hermes');
        return;
      }
    } catch {
      // fall through
    }
    this.onBridgeOffline();
  }

  private onBridgeOnline(mode: 'openclaw' | 'hermes') {
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
    logEvent('Modo DEMO activo — eventos simulados cada 30s', 'info');
    this.demoInterval = setInterval(() => {
      this.handleBridgeEvent({ type: 'resource_update', resource: 'gold', delta: 5 });
      this.handleBridgeEvent({ type: 'resource_update', resource: 'science', delta: 2 });
      this.handleBridgeEvent({ type: 'resource_update', resource: 'production', delta: 3 });
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
      const res = await fetch(`${BRIDGE_URL}/gpu`, { headers: this._authHeaders() });
      if (res.ok) {
        const data = await res.json() as { vramUsed?: number; vramTotal?: number; temp?: number } | null;
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
        playSound('complete');
        break;
      case 'building_failed':
        this.state.failBuilding(evt.city, evt.building);
        logEvent(`✗ ${evt.building}`, 'warn');
        break;
      case 'mission_start':
        this.state.startMission(evt.missionId, evt.unit, evt.questName);
        logEvent(`▶ ${evt.questName}`, 'info');
        break;
      case 'mission_complete':
        this.state.completeMission(evt.missionId, evt.success);
        setOperationTicker(false);
        if (evt.success) playSound('mission');
        break;
      case 'chat_chunk':
        appendChatChunk(evt.unit, evt.text);
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
        this.state.updateUnitFatigue(evt.unit, evt.fatigue, evt.maxFatigue ?? 100, evt.atRest ?? false, evt.restAreaId ?? null);
        break;
      }
      case 'unit_sent_to_rest': {
        this.state.updateUnitFatigue(evt.unit, evt.fatigue, evt.maxFatigue, evt.atRest, evt.restAreaId);
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
      case 'context_exhausted': {
        logEvent(`⚠ Contexto agotado para ${evt.unit}`, 'warn');
        break;
      }
      default:
        break;
    }
  }

  // ─── Send legacy command to bridge.py root POST ───────────────────────────
  send(type: string, payload: Record<string, unknown>) {
    if (!this.bridgeOnline) return;
    fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this._authHeaders() },
      body: JSON.stringify({ type, ...payload }),
    }).catch(() => {});
  }

  stop() {
    clearInterval(this.healthInterval);
    clearInterval(this.gpuInterval);
    this.stopDemo();
  }
}

// ─── Web Audio sound effects ─────────────────────────────────────────────────
type SoundType = 'move' | 'complete' | 'mission';

function playSound(type: SoundType) {
  try {
    const ctx = new AudioContext();
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

export { playSound };
