// ─── RepoCiv — Game State ─────────────────────────────────────────────────────

import { logger } from './logger.ts';
import {
  type World,
  type Unit,
  type Building,
  type UnitState,
  tileKey,
  UNIT_COLORS,
  type ViewMode,
  type LocalWorld,
  type LocalUnit,
  type LocalMission,
  type AgentTask,
  type SubagentRun,
} from './types.ts';
import type { Axial } from './hex.ts';
import { aStarPath, invalidatePathCache } from './pathfinding.ts';
import { axialDistance, axialNeighbours } from './hex.ts';
import { getConfig } from './gameConfig.ts';
import { LocalWorldManager } from './localWorldManager.ts';
import { MissionRegistry } from './missionLifecycle.ts';
import { SubagentRegistry } from './subagentManager.ts';

// ─── Clock speed ──────────────────────────────────────────────────────────────
const TICK_MS = 16; // ~60 fps

/** Pick an adjacent hex for a detachment scout; falls back to parent if ring full. */
export function pickDetachmentHex(state: GameState, parentCoord: Axial, childIndex: number): Axial {
  const neighbors = axialNeighbours(parentCoord);
  const preferred = neighbors[((childIndex % 6) + 6) % 6]!;
  if (!state.getUnitAt(preferred)) return preferred;
  for (const hex of neighbors) {
    if (!state.getUnitAt(hex)) return hex;
  }
  return parentCoord;
}

// ─── Mission record (in-memory mirror of bridge.py persistence) ─────────────
export interface Mission {
  id: string;
  unit: string;
  questName: string;
  status: 'running' | 'complete' | 'failed';
  startedAt: number;
  completedAt: number | null;
  simulated?: boolean; // true = bridge was offline/simulated
}

// ─── GameState ───────────────────────────────────────────────────────────────
export class GameState {
  world: World;
  private running = false;
  private paused = false;
  private lastTick = 0;
  private rafId = 0;
  private tickCount = 0;

  // Units by id for O(1) lookup
  private unitMap = new Map<string, Unit>();
  // Active buildings by city+name key
  private buildingMap = new Map<string, Building>();

  // Currently selected unit (renderer-owned but state-managed)
  selectedUnit: Unit | null = null;

  // Active missions by missionId
  missions = new Map<string, Mission>();
  // Swarm Civ: subagent detachments
  subagents = new Map<string, SubagentRun>();
  subagentProgress = new Map<string, string[]>();
  completedSubagents: SubagentRun[] = [];
  highlightedSubagentId: string | null = null;
  // Extracted registries (see missionLifecycle.ts, subagentManager.ts)
  private _missions: MissionRegistry;
  private _subagents: SubagentRegistry;
  // Listener for state changes (used by UI to refresh hero bar / quest board)
  private listeners: Array<() => void> = [];

  // ─── Phase 6+7a: Local / RimWorld view (delegated to LocalWorldManager) ─────
  private _local: LocalWorldManager;

  /** Current view: 'macro' (hex map) or 'local' (RimWorld grid). */
  get viewMode(): ViewMode {
    return this._local.viewMode;
  }
  set viewMode(v: ViewMode) {
    this._local.viewMode = v;
  }

  /** Exposed for renderer compatibility (renderer reads state.localWorld directly). */
  get localWorld(): LocalWorld | null {
    return this._local.getLocalWorld();
  }

  constructor(world: World) {
    this.world = world;
    this._local = new LocalWorldManager(
      () => this.notify(),
      () => this.getAllUnits()[0],
      (id: string) => this.getUnit(id),
    );
    // Subagent + mission registries — pure data owners, see their
    // respective files. GameState exposes the public API via
    // delegation methods below; the data members are still the
    // canonical references for external readers.
    this._missions = new MissionRegistry(
      { active: this.missions },
      { notify: () => this.notify() },
    );
    this._subagents = new SubagentRegistry(
      {
        active: this.subagents,
        completed: this.completedSubagents,
        progress: this.subagentProgress,
        highlighted: this.highlightedSubagentId,
      },
      {
        notify: () => this.notify(),
        removeUnit: (id) => this.removeUnit(id),
        removeLocalUnit: (id) => this._local.removeSubagentUnit(id ?? ''),
        clearHighlight: (id) => {
          if (this.highlightedSubagentId === id) this.highlightedSubagentId = null;
        },
      },
    );
    // Index existing units and buildings
    for (const u of world.units) this.unitMap.set(u.id, u);
    for (const b of world.buildings) {
      this.buildingMap.set(`${b.cityId}::${b.id}`, b);
    }
  }

  // ─── Clock control ────────────────────────────────────────────────────────
  start() {
    this.running = true;
    this.lastTick = performance.now();
    this.loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this.lastTick = performance.now();
  }
  pauseWorld() {
    this.pause();
  }

  private loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const now = performance.now();
    const dt = now - this.lastTick;
    if (dt < TICK_MS) return;
    this.lastTick = now;
    this.tickCount++;

    if (!this.paused) {
      try {
        this.updateUnits(dt);
        this.updateBuildings(dt);
        if (this.viewMode === 'local') this._local.tick(dt);
      } catch (err) {
        logger.error('[GameState] loop error — frame skipped:', err);
      }
    }
  };

  // ─── Unit animation ───────────────────────────────────────────────────────
  private updateUnits(dt: number) {
    for (const unit of this.world.units) {
      if (unit.state === 'moving' && unit.targetCoord) {
        // 2.5 hex/s — derived from real dt (ms → s) to stay frame-rate independent
        unit.pathProgress += (dt / 1000) * 2.5;
        if (unit.pathProgress >= 1) {
          unit.pathProgress = 0;
          if (!unit.trailPositions) unit.trailPositions = [];
          unit.trailPositions.push({ q: unit.coord.q, r: unit.coord.r });
          if (unit.trailPositions.length > 5) unit.trailPositions.shift();
          unit.pathIndex++;
          if (unit.pathIndex >= unit.path.length - 1) {
            // Arrived
            const dest = unit.targetCoord!;
            unit.coord = dest;
            unit.targetCoord = undefined;
            unit.path = [] as Axial[];
            unit.pathIndex = 0;
            unit.state = unit.mission ? 'working' : 'idle';
          } else {
            unit.coord = unit.path[unit.pathIndex]!;
          }
        }
      }
      if (unit.state === 'working' && unit.workProgress !== undefined) {
        unit.workProgress = Math.min(100, unit.workProgress + (dt / 1000) * 3.0);
      }
    }
  }

  // ─── Building progress ────────────────────────────────────────────────────
  private updateBuildings(_dt: number) {
    for (const b of this.world.buildings) {
      if (b.state === 'building') {
        if (b.durationSeconds <= 0) {
          b.progress = 100;
          b.state = 'complete';
          continue;
        }
        b.elapsedSeconds += _dt / 1000;
        b.progress = Math.min(100, (b.elapsedSeconds / b.durationSeconds) * 100);
        if (b.progress >= 100) {
          b.state = 'complete';
        }
      }
    }
  }

  // ─── Query: unit at hex ────────────────────────────────────────────────────
  getUnitAt(coord: Axial): Unit | null {
    const key = tileKey(coord);
    return this.world.units.find((u) => tileKey(u.coord) === key) ?? null;
  }

  // ─── Selection ─────────────────────────────────────────────────────────────
  selectUnit(unit: Unit | null) {
    this.selectedUnit = unit;
  }

  // ─── Unit state ────────────────────────────────────────────────────────────
  setUnitState(unitId: string, state: UnitState) {
    const unit = this.unitMap.get(unitId);
    if (unit) {
      unit.state = state;
      this.notify();
    }
  }

  // ─── Phase 9: XCOM Context Fatigue ─────────────────────────────────────────
  updateUnitFatigue(
    unitId: string,
    fatigue: number,
    maxFatigue: number,
    atRest: boolean,
    restAreaId: string | null,
  ) {
    const unit = this.unitMap.get(unitId);
    if (unit) {
      unit.fatigue = fatigue;
      unit.maxFatigue = maxFatigue;
      unit.isResting = atRest;
      unit.restingRoomId = restAreaId ?? undefined;
      unit.effectiveSpeed = maxFatigue > 0 ? fatigue / maxFatigue : 1;
      this.notify();
    }
  }

  setUnitResting(unitId: string, isResting: boolean, restAreaId?: string) {
    const unit = this.unitMap.get(unitId);
    if (unit) {
      unit.isResting = isResting;
      unit.restingRoomId = isResting ? restAreaId : undefined;
      this.notify();
    }
  }

  getUnitFatigue(unitId: string): {
    unit: string;
    fatigue: number;
    maxFatigue: number;
    effectiveSpeed: number;
    isResting: boolean;
    restingRoomId: string | undefined;
  } | null {
    const unit = this.unitMap.get(unitId);
    if (!unit) return null;
    return {
      unit: unit.id,
      fatigue: unit.fatigue,
      maxFatigue: unit.maxFatigue,
      effectiveSpeed: unit.effectiveSpeed,
      isResting: unit.isResting,
      restingRoomId: unit.restingRoomId ?? undefined,
    };
  }

  addRestArea(restArea: import('./types').RestArea) {
    const existing = this.world.restAreas.find((r) => r.id === restArea.id);
    if (!existing) {
      this.world.restAreas.push(restArea);
      this.notify();
    }
  }

  removeRestArea(restAreaId: string) {
    const idx = this.world.restAreas.findIndex((r) => r.id === restAreaId);
    if (idx !== -1) {
      this.world.restAreas.splice(idx, 1);
      this.notify();
    }
  }

  getRestAreaNear(coord: Axial, radius = 3): import('./types').RestArea | undefined {
    return this.world.restAreas.find((ra) => axialDistance(ra.coord, coord) <= radius);
  }

  decayUnitFatigue(unitId: string, delta: number) {
    const unit = this.unitMap.get(unitId);
    if (!unit) return;
    unit.fatigue = Math.max(0, Math.min(unit.maxFatigue, unit.fatigue + delta));
    unit.effectiveSpeed = Math.round((unit.fatigue / unit.maxFatigue) * 1000) / 1000;
    const cfg = getConfig();
    // Auto-warn below configurable threshold (was hardcoded at 20%)
    if (
      unit.fatigue <= unit.maxFatigue * cfg.fatigue.autoWarnBelow &&
      unit.fatigue > 0 &&
      !unit.isResting
    ) {
      logger.warn(`[fatigue] ${unit.name} contexto bajo (${unit.fatigue}%)`);
    }
    this.notify();
  }

  // ─── Spawn unit ────────────────────────────────────────────────────────────
  spawnUnit(
    id: string,
    name: string,
    type: Unit['type'],
    civ: string,
    coord: Axial,
    mission?: string,
    cityId?: string,
    opts?: {
      parentUnitId?: string;
      ephemeral?: boolean;
      subagentRunId?: string;
    },
  ): Unit {
    const existing = this.unitMap.get(id);
    if (existing) return existing;
    const color = UNIT_COLORS[type] ?? UNIT_COLORS['hero']!;
    const unit: Unit = {
      id,
      name,
      type,
      civ,
      coord,
      targetCoord: undefined as Axial | undefined,
      path: [] as Axial[],
      pathIndex: 0,
      pathProgress: 0,
      state: 'idle',
      mission,
      cityId,
      speed: type === 'scout' ? 2 : 1,
      color,
      movesLeft: 4,
      maxMoves: 4,
      fatigue: 100,
      maxFatigue: 100,
      isResting: false,
      restingRoomId: undefined,
      effectiveSpeed: 1.0,
      parentUnitId: opts?.parentUnitId,
      ephemeral: opts?.ephemeral,
      subagentRunId: opts?.subagentRunId,
    };
    this.world.units.push(unit);
    this.unitMap.set(id, unit);
    this.notify();
    return unit;
  }

  // ─── Listeners (UI subscribes to state changes) ──────────────────────────
  subscribe(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  // ─── Unit removal (cleans up maps, path cache, selection) ────────────────
  /** Callbacks invoked with the removed unitId — lets UI layers clean up buffers. */
  private unitRemovedCallbacks: Array<(unitId: string) => void> = [];

  onUnitRemoved(fn: (unitId: string) => void): () => void {
    this.unitRemovedCallbacks.push(fn);
    return () => {
      this.unitRemovedCallbacks = this.unitRemovedCallbacks.filter((f) => f !== fn);
    };
  }

  removeUnit(unitId: string): boolean {
    if (!this.unitMap.has(unitId)) return false;
    this.world.units = this.world.units.filter((u) => u.id !== unitId);
    this.unitMap.delete(unitId);
    if (this.selectedUnit?.id === unitId) this.selectedUnit = null;
    invalidatePathCache();
    for (const cb of this.unitRemovedCallbacks) cb(unitId);
    this.notify();
    return true;
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  /** Public helper to trigger state notifications (e.g., after dynamic world updates). */
  notifyUpdate() {
    this.notify();
  }

  // ─── Get unit by id ───────────────────────────────────────────────────────
  getUnit(id: string): Unit | undefined {
    return this.unitMap.get(id);
  }

  getAllUnits(): Unit[] {
    return [...this.world.units];
  }

  getSubagentsOfUnit(unitId: string): SubagentRun[] {
    return [...this.subagents.values()].filter((s) => s.parentUnitId === unitId);
  }

  getChildrenOfUnit(unitId: string): Unit[] {
    return this.world.units.filter((u) => u.parentUnitId === unitId);
  }

  registerSubagent(run: SubagentRun): void {
    this._subagents.register(run);
  }

  updateSubagent(id: string, patch: Partial<SubagentRun>): void {
    this._subagents.update(id, patch);
  }

  appendSubagentProgress(id: string, text: string): void {
    this._subagents.appendProgress(id, text);
  }

  completeSubagent(id: string, success: boolean, summary: string): void {
    this._subagents.complete(id, success, summary);
  }

  cancelSubagent(id: string, summary = 'cancelled'): void {
    this._subagents.cancel(id, summary);
  }

  resolveSubagentId(preferredId?: string | null, unitId?: string): string | null {
    return this._subagents.resolveId(preferredId, unitId);
  }

  revealHexes(hexes: [number, number][], cityId?: string): void {
    if (cityId) {
      const city = this.world.cities.find((c) => c.id === cityId);
      if (city?.territory?.length) {
        for (const t of city.territory) {
          const key = tileKey(t);
          const tile = this.world.tiles.get(key);
          if (tile) {
            tile.inFog = false;
            tile.revealed = true;
          }
        }
        this.notify();
        return;
      }
    }
    for (const [q, r] of hexes) {
      const key = tileKey({ q, r });
      const tile = this.world.tiles.get(key);
      if (tile) {
        tile.inFog = false;
        tile.revealed = true;
      }
    }
    this.notify();
  }

  // ─── Move unit (A* pathfinding) ───────────────────────────────────────────
  moveUnit(unitId: string, target: Axial): boolean {
    const unit = this.unitMap.get(unitId);
    if (!unit) return false;

    const path = aStarPath(unit.coord, target, this.world, unit.type);
    if (path.length < 2) return false;

    unit.path = path;
    unit.targetCoord = target;
    unit.pathIndex = 0;
    unit.pathProgress = 0;
    unit.state = 'moving';
    return true;
  }

  getCapital(): import('./types').City | undefined {
    return this.world.cities.find((c) => c.isCapital);
  }

  invalidatePathCache(): void {
    invalidatePathCache();
  }

  // ─── Phase 6+7a: Local view — delegated to LocalWorldManager ────────────────

  async enterLocalView(repoId: string): Promise<LocalWorld> {
    return this._local.enterLocalView(repoId);
  }
  enterLocalViewMock(repoId: string): LocalWorld {
    return this._local.enterLocalViewMock(repoId);
  }
  enterMacroView(): void {
    this._local.enterMacroView();
  }

  getLocalWorld(): LocalWorld | null {
    return this._local.getLocalWorld();
  }
  getLocalUnits(): LocalUnit[] {
    return this._local.getLocalUnits();
  }
  getLocalUnit(id: string): LocalUnit | undefined {
    return this._local.getLocalUnit(id);
  }
  setLocalUnitTask(unitId: string, task: AgentTask | null): void {
    const unit = this._local.getLocalUnit(unitId);
    if (unit) unit.assignedTask = task;
  }
  queueLocalMission(repoId: string, filePath: string, fileName: string, unitId?: string): void {
    this._local.queueLocalMission(repoId, filePath, fileName, unitId);
  }
  dispatchMissionById(missionId: string): void {
    this._local.dispatchMissionById(missionId);
  }

  syncSubagentSpawn(payload: {
    ephemeralUnitId: string;
    parentUnitId: string;
    kind: string;
    label: string;
    repoId: string;
  }): void {
    this._local.syncSubagentSpawn(payload);
  }
  getMissionQueue(): LocalMission[] {
    return this._local.getMissionQueue();
  }
  getLocalTick(): number {
    return this._local.getLocalTick();
  }

  // ─── Building control ──────────────────────────────────────────────────────
  startBuilding(
    cityId: string,
    buildingId: string,
    name: string,
    durationSeconds: number,
    buildingType: 'building' | 'wonder' = 'building',
  ): Building {
    const key = `${cityId}::${buildingId}`;
    const existing = this.buildingMap.get(key);
    if (existing) return existing;
    const b: Building = {
      id: buildingId,
      name,
      type: buildingType,
      cityId,
      progress: 0,
      durationSeconds,
      elapsedSeconds: 0,
      state: 'building',
    };
    this.world.buildings.push(b);
    this.buildingMap.set(key, b);
    return b;
  }

  completeBuilding(cityId: string, buildingId: string) {
    const key = `${cityId}::${buildingId}`;
    const b = this.buildingMap.get(key);
    if (b) {
      b.state = 'complete';
      b.progress = 100;
    }
  }

  failBuilding(cityId: string, buildingId: string) {
    const key = `${cityId}::${buildingId}`;
    const b = this.buildingMap.get(key);
    if (b) b.state = 'failed';
  }

  // ─── Mission tracking ────────────────────────────────────────────────────
  startMission(id: string, unit: string, questName: string) {
    this._missions.start(id, unit, questName);
  }

  completeMission(id: string, success: boolean) {
    this._missions.complete(id, success);
  }

  // ─── Tick count for animations ─────────────────────────────────────────────
  get tick(): number {
    return this.tickCount;
  }

  // ─── Set unit's working city ───────────────────────────────────────────────
  setUnitCity(unitId: string, cityId: string) {
    const unit = this.unitMap.get(unitId);
    if (unit) {
      unit.cityId = cityId;
      this.notify();
    }
  }

  // ─── Set unit's work progress ────────────────────────────────────────────────
  setUnitWorkProgress(unitId: string, progress: number) {
    const unit = this.unitMap.get(unitId);
    if (unit) {
      unit.workProgress = progress;
      this.notify();
    }
  }
}
