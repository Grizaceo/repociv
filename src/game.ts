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
} from './types.ts';
import type { Axial } from './hex.ts';
import { aStarPath, invalidatePathCache } from './pathfinding.ts';
import { axialDistance } from './hex.ts';
import { getConfig } from './gameConfig.ts';
import { LocalWorldManager } from './localWorldManager.ts';

// ─── Clock speed ──────────────────────────────────────────────────────────────
const TICK_MS = 16; // ~60 fps

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
      // Phase 9: XCOM Context Fatigue
      fatigue: 100,
      maxFatigue: 100,
      isResting: false,
      restingRoomId: undefined,
      effectiveSpeed: 1.0,
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
  queueLocalMission(repoId: string, filePath: string, fileName: string): void {
    this._local.queueLocalMission(repoId, filePath, fileName);
  }
  dispatchMissionById(missionId: string): void {
    this._local.dispatchMissionById(missionId);
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
    this.missions.set(id, {
      id,
      unit,
      questName,
      status: 'running',
      startedAt: Date.now(),
      completedAt: null,
    });
    this.notify();
  }

  completeMission(id: string, success: boolean) {
    const m = this.missions.get(id);
    if (!m) return;
    m.status = success ? 'complete' : 'failed';
    m.completedAt = Date.now();
    this.notify();
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
