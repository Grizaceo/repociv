// ─── RepoCiv — Bridge message handlers ────────────────────────────────────────
//
// Extracted from bridge.ts (which was 863 lines and the handleBridgeEvent
// switch alone was 298 lines, ~28 cases). Each event from bridge.py is
// routed to a pure handler function here, with side effects mediated by a
// MessageContext (state + UI helpers). No DOM access, no transport —
// pure dispatch logic, easy to test, easy to extend.
//
// The BridgeEvents class wires the context once at start() and routes
// every incoming event through dispatchBridgeEvent(this.ctx, evt).
//
// Adding a new event type:
//   1. Add the variant to BridgeEvent in types.ts
//   2. Add a handler in HANDLERS below
//   3. Done — no other wiring needed
//
// If you find yourself adding DOM access, network calls, or transport
// state here, it probably belongs in bridge.ts instead. Handlers should
// be: take the event, mutate state, fire UI side effects.

import type { GameState } from './game.ts';
import { pickDetachmentHex } from './game.ts';
import type { BridgeEvent, CDailyArticle } from './types.ts';
import { logger } from './logger.ts';
import {
  logEvent,
  appendChatChunk,
  appendApprovalCard,
  setOperationTicker,
  showNotification,
} from './ui/index.ts';
import { cfg } from './gameConfig.ts';
import { approveCommand } from './commandBus.ts';
import { terminalPanel } from './terminalPanel.ts';

// ─── Context ────────────────────────────────────────────────────────────────
// Everything a handler might need from the outside world. The BridgeEvents
// class builds this once (it never changes after start()) and passes it
// on every dispatch.
export interface MessageContext {
  state: GameState;
  logEvent: typeof logEvent;
  showNotification: typeof showNotification;
  setOperationTicker: typeof setOperationTicker;
  appendChatChunk: typeof appendChatChunk;
  appendApprovalCard: typeof appendApprovalCard;
  terminalPanel: typeof terminalPanel;
  playSound: (type: 'move' | 'complete' | 'mission') => void;
  approveCommand: typeof approveCommand;
  cfg: typeof cfg;
}

// ─── Handler type ────────────────────────────────────────────────────────────
// Each handler takes the context and the narrowed event payload.
type Handler<T extends BridgeEvent> = (ctx: MessageContext, evt: T) => void;
type HandlerByType = {
  [K in BridgeEvent['type']]: Handler<Extract<BridgeEvent, { type: K }>>;
};

// ─── Lazy imports (code-split, keep initial bundle small) ────────────────────
// Celebrate the mission payoff canvas overlay on success — used by
// mission_complete. Static import would pull ui/payoffs into the bridge
// bundle even on first paint. Errors swallowed (canvas overlay is a
// nice-to-have; the mission is already reported as complete via the
// notification + sound).
async function celebrateMission(): Promise<void> {
  try {
    const mod = await import('./ui/payoffs.ts');
    const canvas = document.getElementById('main-canvas') as HTMLCanvasElement | null;
    if (canvas) mod.celebrateMission(canvas);
  } catch {
    // Swallowed: the overlay is best-effort. Common in test env where
    // `document` is undefined, and in SSR / partial bootstraps.
  }
}

// ─── Handlers ───────────────────────────────────────────────────────────────
// One per BridgeEvent variant. Keep them small (5-15 lines). If a case
// grows beyond that, extract to its own function and call from here.
const HANDLERS: HandlerByType = {
  // ─── Unit lifecycle ──────────────────────────────────────────────────
  unit_spawn(ctx, evt) {
    const parent = evt.parentUnit ? ctx.state.getUnit(evt.parentUnit) : undefined;
    let spawnCoord = { q: evt.hex[0], r: evt.hex[1] };
    if (parent && evt.hex[0] === 0 && evt.hex[1] === 0) {
      const childIndex = ctx.state
        .getChildrenOfUnit(parent.id)
        .filter((c) => c.ephemeral).length;
      spawnCoord = pickDetachmentHex(ctx.state, parent.coord, childIndex);
    }
    const unit = ctx.state.spawnUnit(
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
      const targetCity = ctx.state.world.cities.find((c) => c.id === evt.cityId);
      if (targetCity) ctx.state.moveUnit(unit.id, targetCity.coord);
    }
    ctx.logEvent(`Unidad ${unit.name} apareció en el mapa`, 'success');
  },

  unit_move(ctx, evt) {
    ctx.state.moveUnit(evt.unit, { q: evt.to[0], r: evt.to[1] });
  },

  unit_despawn(ctx, evt) {
    const ok = ctx.state.removeUnit(evt.unit);
    if (ok) ctx.logEvent(`Unidad ${evt.unit} desapareció del mapa`, 'warn');
  },

  unit_state(ctx, evt) {
    ctx.state.setUnitState(evt.unit, evt.state);
    if (evt.state === 'working') ctx.setOperationTicker(true, `${evt.unit} trabajando…`);
    else if (evt.state === 'idle') ctx.setOperationTicker(false);
  },

  unit_work(ctx, evt) {
    if (evt.cityId) ctx.state.setUnitCity(evt.unit, evt.cityId);
    ctx.state.setUnitWorkProgress(evt.unit, evt.progress);
  },

  // ─── Buildings ───────────────────────────────────────────────────────
  building_start(ctx, evt) {
    ctx.state.startBuilding(
      evt.city,
      evt.building,
      evt.building,
      evt.durationSeconds,
      evt.buildingType ?? 'building',
    );
    ctx.logEvent(`◆ ${evt.building}`, 'info');
  },

  building_progress(_ctx, evt) {
    // No-op for now (no progress UI element); the building_start
    // and building_complete events are the visible ones.
    void evt;
  },

  building_complete(ctx, evt) {
    ctx.state.completeBuilding(evt.city, evt.building);
    ctx.state.invalidatePathCache();
    ctx.logEvent(`✓ ${evt.building}`, 'success');
    ctx.showNotification({
      type: 'success',
      title: 'Construcción completada',
      body: `${evt.city} → ${evt.building}`,
    });
    ctx.playSound('complete');
  },

  building_failed(ctx, evt) {
    ctx.state.failBuilding(evt.city, evt.building);
    ctx.logEvent(`✗ ${evt.building}`, 'warn');
    ctx.showNotification({
      type: 'error',
      title: 'Construcción fallida',
      body: `${evt.city} → ${evt.building}`,
    });
  },

  // ─── Missions ─────────────────────────────────────────────────────────
  mission_start(ctx, evt) {
    ctx.state.startMission(evt.missionId, evt.unit, evt.questName);
    ctx.logEvent(`▶ ${evt.questName}`, 'info');
  },

  mission_complete(ctx, evt) {
    ctx.state.completeMission(evt.missionId, evt.success);
    ctx.setOperationTicker(false);
    const durLabel =
      evt.duration >= 60 ? `${Math.round(evt.duration / 60)}m` : `${evt.duration}s`;
    ctx.showNotification({
      type: evt.success ? 'success' : 'error',
      title: evt.success ? 'Misión completada' : 'Misión fallida',
      body: `${evt.unit} · ${durLabel}`,
      unit: evt.unit,
      ttl: evt.success ? 6000 : 8000,
    });
    if (evt.success) {
      ctx.playSound('mission');
      void celebrateMission();
    }
  },

  // ─── Chat & logs ─────────────────────────────────────────────────────
  chat_chunk(ctx, evt) {
    ctx.appendChatChunk(evt.unit, evt.text);
    ctx.terminalPanel.write(`[${evt.unit}] ${evt.text}`);
  },

  log(ctx, evt) {
    ctx.logEvent(evt.msg, evt.level ?? 'info');
  },

  // ─── Resources & fog ─────────────────────────────────────────────────
  resource_update(_ctx, evt) {
    // Direct DOM mutation — bypass state to avoid re-render churn
    // for a counter that updates many times per second.
    const el = document.querySelector<HTMLElement>(`#res-${evt.resource} .res-value`);
    if (el) {
      const prev = parseInt(el.textContent?.replace(/[^\d]/g, '') ?? '0', 10);
      el.textContent = (prev + evt.delta).toLocaleString();
    }
  },

  fog_reveal(ctx, evt) {
    ctx.state.revealHexes(evt.hexes, evt.cityId);
    ctx.logEvent(`🌫 Niebla disipada (${evt.hexes.length} hexes)`, 'info');
  },

  city_founder(_ctx, _evt) {
    // Future: foundation animation / city-create UI event. No-op today.
  },

  context_exhausted(ctx, evt) {
    ctx.logEvent(`⚠ Contexto agotado para ${evt.unit}`, 'warn');
  },

  // ─── Fatigue & rest areas (Phase 9) ──────────────────────────────────
  rest_area_discovered(ctx, evt) {
    const ra = evt.restArea;
    ctx.state.addRestArea({
      id: ra.id,
      roomId: ra.roomId,
      coord: { q: ra.coord[0], r: ra.coord[1] },
      recoveryRate: ra.recoveryRate,
      capacity: ra.capacity,
      unitsInside: ra.unitsInside,
    });
    ctx.logEvent(`☕ Área de descanso descubierta: ${ra.roomId}`, 'info');
  },

  rest_area_entered(ctx, evt) {
    ctx.state.setUnitResting(evt.unit, true, evt.restAreaId);
    ctx.logEvent(`${evt.unit} entró al área de descanso`, 'info');
  },

  rest_area_exited(ctx, evt) {
    ctx.state.setUnitResting(evt.unit, false);
    ctx.logEvent(`${evt.unit} salió del área de descanso`, 'info');
  },

  unit_fatigue_update(ctx, evt) {
    ctx.state.updateUnitFatigue(
      evt.unit,
      evt.fatigue,
      evt.maxFatigue ?? 100,
      evt.atRest ?? false,
      evt.restAreaId ?? null,
    );
  },

  unit_sent_to_rest(ctx, evt) {
    ctx.state.updateUnitFatigue(
      evt.unit,
      evt.fatigue,
      evt.maxFatigue,
      evt.atRest,
      evt.restAreaId,
    );
    ctx.logEvent(`🛌 ${evt.unit} enviado a descanso`, 'info');
  },

  // ─── Approvals ──────────────────────────────────────────────────────
  waiting_approval(ctx, evt) {
    // Auto-approve execute_agent (chat) when the setting is on — user
    // already expressed intent by typing and sending the message.
    if (evt.commandType === 'execute_agent' && ctx.cfg.trust.autoApproveChat) {
      void ctx.approveCommand(evt.commandId);
      return;
    }
    ctx.logEvent(
      `⏳ Aprobación requerida: ${evt.commandType} → ${evt.target} [${evt.risk}]`,
      'warn',
    );
    ctx.appendApprovalCard(evt.target, evt.commandId, evt.commandType, evt.target, evt.risk);
  },

  // ─── Subagents ───────────────────────────────────────────────────────
  subagent_spawn(ctx, evt) {
    const parentUnit = ctx.state.getUnit(evt.parentUnit);
    const spawnStatus = evt.status ?? 'running';
    ctx.state.registerSubagent({
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
        ? ctx.state.getChildrenOfUnit(parentUnit.id).filter((c) => c.ephemeral).length
        : 0;
      const coord = parentUnit
        ? pickDetachmentHex(ctx.state, parentUnit.coord, childIndex)
        : { q: evt.hex[0], r: evt.hex[1] };
      ctx.state.spawnUnit(
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
      ctx.state.syncSubagentSpawn({
        ephemeralUnitId: evt.ephemeralUnitId,
        parentUnitId: evt.parentUnit,
        kind: evt.kind,
        label: evt.label,
        repoId: evt.targetCityId ?? parentUnit?.cityId ?? '',
      });
      ctx.state.setUnitState(evt.ephemeralUnitId, 'working');
      ctx.logEvent(`◈ Detachment: ${evt.label.slice(0, 40)}`, 'info');
    } else {
      ctx.logEvent(
        `◈ Detachment propuesto: ${evt.label.slice(0, 40)} (pendiente aprobación)`,
        'info',
      );
    }
  },

  subagent_progress(ctx, evt) {
    const progressText = evt.text ?? evt.phase ?? '…';
    ctx.state.appendSubagentProgress(evt.subagentId, progressText);
    let run = ctx.state.subagents.get(evt.subagentId);
    if (run?.status === 'proposed') {
      ctx.state.updateSubagent(evt.subagentId, {
        status: 'running',
        lastProgressAt: Date.now(),
      });
      run = ctx.state.subagents.get(evt.subagentId);
    } else if (run) {
      ctx.state.updateSubagent(evt.subagentId, { lastProgressAt: Date.now() });
    }
    if (run?.ephemeralUnitId) {
      ctx.state.setUnitState(run.ephemeralUnitId, 'working');
    }
  },

  subagent_complete(ctx, evt) {
    if (evt.outputFilePath) {
      ctx.state.updateSubagent(evt.subagentId, { outputFilePath: evt.outputFilePath });
    }
    ctx.state.completeSubagent(evt.subagentId, evt.success, evt.summary);
    ctx.logEvent(
      evt.success
        ? `✓ Subagente completado (${Math.round(evt.duration)}s)`
        : `✗ Subagente falló`,
      evt.success ? 'success' : 'warn',
    );
  },

  subagent_proposed(ctx, evt) {
    ctx.state.registerSubagent({
      id: evt.subagentId,
      parentMissionId: evt.parentMissionId,
      parentUnitId: evt.parentUnit,
      kind: evt.kind,
      label: evt.label,
      status: 'proposed',
      risk: evt.risk as import('./types.ts').SubagentRisk,
      startedAt: Date.now(),
    });
    ctx.logEvent(`⏳ Subagente propuesto [${evt.risk}]: ${evt.label.slice(0, 40)}`, 'warn');
  },

  subagent_cancel(ctx, evt) {
    ctx.state.cancelSubagent(evt.subagentId, 'cancelled by user (Recall)');
    ctx.logEvent(`Subagente cancelado: ${evt.subagentId}`, 'warn');
  },
};

// ─── Public dispatch ───────────────────────────────────────────────────────
export function dispatchBridgeEvent(ctx: MessageContext, evt: BridgeEvent): void {
  const handler = HANDLERS[evt.type] as Handler<BridgeEvent> | undefined;
  if (!handler) {
    // Unknown event type — log and move on. The schema parser already
    // rejects malformed payloads, so this is the safety net for new
    // event variants added to types.ts before their handler is wired.
    logger.warn(`[bridge] No handler for event type: ${(evt as { type: string }).type}`);
    return;
  }
  handler(ctx, evt);
}

// Re-export CDailyArticle so bridge.ts can keep its existing public API
// (UI panels import it from there). Without this re-export the import
// chain breaks — the type was previously defined here, so the move is
// invisible to consumers.
export type { CDailyArticle };
