// ─── RepoCiv — Game State ─────────────────────────────────────────────────────

import {
  type World, type Unit, type Building, type UnitState, tileKey, UNIT_COLORS,
  type ViewMode, type LocalWorld, type LocalUnit, type LocalMission,
} from './types.ts';
import type { Axial } from './hex.ts';
import { aStarPath, invalidatePathCache } from './pathfinding.ts';
import { generateLocalWorldFromApi, buildMockLocalWorld } from './localMap.ts';
import { findPath, findNearestWorkbench } from './localPathfinding.ts';

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

  // ─── Phase 6: Local / RimWorld view ─────────────────────────────────────────
  viewMode: ViewMode = 'macro';          // 'macro' | 'local'
  localWorld: LocalWorld | null = null;  // generated on first local entry
  private localUnits: LocalUnit[] = [];  // agents walking in the local grid
  private missionQueue: LocalMission[] = []; // simple queue (Phase 7a)
  private localTickCount = 0;

  constructor(world: World) {
    this.world = world;
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

  stop() { this.running = false; cancelAnimationFrame(this.rafId); }
  pause() { this.paused = true; }
  resume() { this.paused = false; this.lastTick = performance.now(); }
  pauseWorld() { this.pause(); }

  private loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const now = performance.now();
    const dt = now - this.lastTick;
    if (dt < TICK_MS) return;
    this.lastTick = now;
    this.tickCount++;

    if (!this.paused) {
      this.updateUnits(dt);
      this.updateBuildings(dt);
      if (this.viewMode === 'local') this.localUpdate(dt);
    }
  };

  // ─── Unit animation ───────────────────────────────────────────────────────
  private updateUnits(_dt: number) {
    for (const unit of this.world.units) {
      if (unit.state === 'moving' && unit.targetCoord) {
        unit.pathProgress += 0.04; // ~25 frames per hex
        if (unit.pathProgress >= 1) {
          unit.pathProgress = 0;
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
        unit.workProgress = Math.min(100, unit.workProgress + 0.05);
      }
    }
  }

  // ─── Building progress ────────────────────────────────────────────────────
  private updateBuildings(_dt: number) {
    for (const b of this.world.buildings) {
      if (b.state === 'building') {
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
    return this.world.units.find(u => tileKey(u.coord) === key) ?? null;
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
  updateUnitFatigue(unitId: string, fatigue: number, maxFatigue: number, atRest: boolean, restAreaId: string | null) {
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

  getUnitFatigue(unitId: string): { unit: string; fatigue: number; maxFatigue: number; effectiveSpeed: number; isResting: boolean; restingRoomId: string | undefined } | null {
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
    const existing = this.world.restAreas.find(r => r.id === restArea.id);
    if (!existing) {
      this.world.restAreas.push(restArea);
      this.notify();
    }
  }

  removeRestArea(restAreaId: string) {
    const idx = this.world.restAreas.findIndex(r => r.id === restAreaId);
    if (idx !== -1) {
      this.world.restAreas.splice(idx, 1);
      this.notify();
    }
  }

  getRestAreaNear(coord: Axial, radius = 3): import('./types').RestArea | undefined {
    return this.world.restAreas.find(ra => {
      const dq = Math.abs(ra.coord.q - coord.q);
      const dr = Math.abs(ra.coord.r - coord.r);
      return dq + dr <= radius;
    });
  }

  decayUnitFatigue(unitId: string, delta: number) {
    const unit = this.unitMap.get(unitId);
    if (!unit) return;
    unit.fatigue = Math.max(0, Math.min(unit.maxFatigue, unit.fatigue + delta));
    unit.effectiveSpeed = parseFloat((unit.fatigue / unit.maxFatigue).toFixed(3));
    // Auto-warn below configurable threshold (was hardcoded at 20%)
    if (unit.fatigue <= unit.maxFatigue * 0.2 && unit.fatigue > 0 && !unit.isResting) {
      console.warn(`[fatigue] ${unit.name} contexto bajo (${unit.fatigue}%)`);
    }
    this.notify();
  }

  // ─── Spawn unit ────────────────────────────────────────────────────────────
  spawnUnit(id: string, name: string, type: Unit['type'], civ: string, coord: Axial, mission?: string): Unit {
    const existing = this.unitMap.get(id);
    if (existing) return existing;
    const color = UNIT_COLORS[type] ?? UNIT_COLORS['hero']!;
    const unit: Unit = {
      id, name, type, civ, coord,
      targetCoord: undefined as Axial | undefined,
      path: [] as Axial[], pathIndex: 0, pathProgress: 0,
      state: 'idle',
      mission,
      speed: type === 'scout' ? 2 : 1,
      color,
      movesLeft: 4, maxMoves: 4,
      // Phase 9: XCOM Context Fatigue
      fatigue: 100, maxFatigue: 100,
      isResting: false, restingRoomId: undefined,
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
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  private notify() {
    for (const l of this.listeners) l();
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

  // ─── Phase 6: View transition ───────────────────────────────────────────────

  /** Switch to RimWorld local view, fetching file tree from bridge API. */
  async enterLocalView(repoId: string): Promise<LocalWorld> {
    if (!this.localWorld || this.localWorld.repoId !== repoId) {
      this.localWorld = await generateLocalWorldFromApi(repoId);
      if (this.localUnits.length === 0) {
        const entrance = this.localWorld.rooms[0] ?? { x: 1, y: 1, w: 4, h: 4 };
        const heroUnit = this.getAllUnits()[0];
        this.localUnits.push({
          id: heroUnit?.id ?? 'DAVI',
          name: heroUnit?.name ?? 'DAVI',
          unitType: heroUnit?.type ?? 'hero',
          color: heroUnit ? (UNIT_COLORS[heroUnit.type] ?? '#4af') : '#4af',
          gridX: entrance.x + Math.floor(entrance.w / 2),
          gridY: entrance.y + Math.floor(entrance.h / 2),
          targetX: null,
          targetY: null,
          path: [],
          pathIndex: 0,
          pathProgress: 0,
          state: 'idle_in_room',
          mission: heroUnit?.mission ?? null,
          workProgress: 0,
          macroUnitId: heroUnit?.id ?? 'DAVI',
          currentWorkbenchId: null,
          fatigue: heroUnit?.fatigue ?? 100,
          maxFatigue: heroUnit?.maxFatigue ?? 100,
          isResting: heroUnit?.isResting ?? false,
          effectiveSpeed: heroUnit?.effectiveSpeed ?? 1,
        });
      }
    }
    this.viewMode = 'local';
    return this.localWorld;
  }

  /** Synchronous local view entry using mock world (for tests / offline mode). */
  enterLocalViewMock(repoId: string): LocalWorld {
    if (!this.localWorld || this.localWorld.repoId !== repoId) {
      this.localWorld = buildMockLocalWorld(repoId);
      if (this.localUnits.length === 0) {
        const entrance = this.localWorld.rooms[0] ?? { x: 1, y: 1, w: 4, h: 4 };
        this.localUnits.push({
          id: 'DAVI', name: 'DAVI', unitType: 'hero', color: '#4af',
          gridX: entrance.x + 1, gridY: entrance.y + 1,
          targetX: null, targetY: null,
          path: [], pathIndex: 0, pathProgress: 0,
          state: 'idle_in_room', mission: null, workProgress: 0,
          macroUnitId: 'DAVI', currentWorkbenchId: null,
          fatigue: 100, maxFatigue: 100, isResting: false, effectiveSpeed: 1,
        });
      }
    }
    this.viewMode = 'local';
    return this.localWorld;
  }

  /** Switch back to macro civ view. */
  enterMacroView() {
    this.viewMode = 'macro';
  }

  getLocalWorld(): LocalWorld | null {
    return this.localWorld;
  }

  getLocalUnits(): LocalUnit[] {
    return this.localUnits;
  }

  getLocalUnit(id: string): LocalUnit | undefined {
    return this.localUnits.find(u => u.id === id);
  }

  // ─── Phase 7a: Local update loop ────────────────────────────────────────────

  /** Main tick update for local (RimWorld) view — runs every TICK_MS when viewMode=local */
  localUpdate(_dt: number) {
    if (this.viewMode !== 'local' || !this.localWorld) return;
    this.localTickCount++;

    for (const unit of this.localUnits) {
      // 1. Advance moving units
      if (unit.state === 'walking_to_workbench' && unit.path.length > 0) {
        unit.pathProgress += 0.06 * unit.effectiveSpeed;
        if (unit.pathProgress >= 1) {
          unit.pathProgress = 0;
          unit.gridX = unit.path[0]!.x;
          unit.gridY = unit.path[0]!.y;
          unit.path.shift();
          if (unit.path.length === 0) {
            unit.state = unit.currentWorkbenchId ? 'working_on_file' : 'idle_in_room';
            unit.workProgress = 0;
          }
        }
      }

      // 2. Advance working units
      if (unit.state === 'working_on_file') {
        unit.workProgress = Math.min(100, (unit.workProgress ?? 0) + 0.08);
        if (unit.workProgress >= 100) {
          this.completeLocalMission(unit.id);
        }
      }
    }

    // 3. Dispatch idle unit → next queued mission (~every 500ms)
    if (this.localTickCount % 30 === 0) {
      this.dispatchNextMission();
    }
  }

  /** Assign a mission to the queue (Phase 7a — no priority system). */
  queueLocalMission(repoId: string, filePath: string, fileName: string) {
    this.missionQueue.push({
      id: `mission-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      unitId: '', // assigned on dispatch
      repoId,
      filePath,
      fileName,
      status: 'queued',
      assignedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      workbenchId: '', // resolved on dispatch
      workbench: null,
      progress: 0,
    });
  }

  /** Manually dispatch a specific queued mission by ID (used by priority panel). */
  dispatchMissionById(missionId: string) {
    const idx = this.missionQueue.findIndex(m => m.id === missionId && m.status === 'queued');
    if (idx === -1) return;
    const queued = this.missionQueue[idx]!;
    this.assignMissionToUnit(queued);
  }

  private assignMissionToUnit(queued: LocalMission) {
    const unit = this.localUnits.find(u => u.state === 'idle_in_room');
    if (!unit || !this.localWorld) return;

    // Try to find workbench by filePath, fall back to nearest
    let wbX = -1, wbY = -1, wbId = '';
    outer: for (const row of this.localWorld.grid) {
      for (const tile of row) {
        if (tile.type === 'workbench' && tile.workbench?.filePath === queued.filePath) {
          wbX = tile.x; wbY = tile.y;
          wbId = tile.workbench.id;
          break outer;
        }
      }
    }
    if (wbX === -1) {
      const nearest = findNearestWorkbench(this.localWorld, unit.gridX, unit.gridY);
      if (!nearest?.workbench) return;
      wbX = nearest.x; wbY = nearest.y;
      wbId = nearest.workbench.id;
      queued.workbench = nearest.workbench;
    }

    const pathResult = findPath(this.localWorld, unit.gridX, unit.gridY, wbX, wbY);
    if (!pathResult) return;

    unit.currentWorkbenchId = wbId;
    unit.path = pathResult.path;
    unit.pathProgress = 0;
    unit.state = 'walking_to_workbench';
    queued.unitId = unit.id;
    queued.workbenchId = wbId;
    queued.status = 'walking';
    queued.startedAt = Date.now();
  }

  private dispatchNextMission() {
    const queued = this.missionQueue.find(m => m.status === 'queued');
    if (!queued) return;
    this.assignMissionToUnit(queued);
  }

  private completeLocalMission(unitId: string) {
    const unit = this.localUnits.find(u => u.id === unitId);
    if (!unit) return;

    const mission = this.missionQueue.find(
      m => m.unitId === unitId && (m.status === 'walking' || m.status === 'working'),
    );
    if (mission) {
      mission.status = 'complete';
      mission.completedAt = Date.now();
    }

    unit.currentWorkbenchId = null;
    unit.workProgress = 0;
    unit.state = 'idle_in_room';
    unit.path = [];
  }

  getMissionQueue(): LocalMission[] {
    return this.missionQueue;
  }

  getLocalTick(): number {
    return this.localTickCount;
  }

  // ─── Building control ──────────────────────────────────────────────────────
  startBuilding(cityId: string, buildingId: string, name: string, durationSeconds: number, buildingType: 'building' | 'wonder' = 'building'): Building {
    const key = `${cityId}::${buildingId}`;
    const existing = this.buildingMap.get(key);
    if (existing) return existing;
    const b: Building = {
      id: buildingId, name, type: buildingType,
      cityId, progress: 0, durationSeconds,
      elapsedSeconds: 0, state: 'building',
    };
    this.world.buildings.push(b);
    this.buildingMap.set(key, b);
    return b;
  }

  completeBuilding(cityId: string, buildingId: string) {
    const key = `${cityId}::${buildingId}`;
    const b = this.buildingMap.get(key);
    if (b) { b.state = 'complete'; b.progress = 100; }
  }

  failBuilding(cityId: string, buildingId: string) {
    const key = `${cityId}::${buildingId}`;
    const b = this.buildingMap.get(key);
    if (b) b.state = 'failed';
  }

  // ─── Mission tracking ────────────────────────────────────────────────────
  startMission(id: string, unit: string, questName: string) {
    this.missions.set(id, {
      id, unit, questName, status: 'running',
      startedAt: Date.now(), completedAt: null,
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
  get tick(): number { return this.tickCount; }
}
