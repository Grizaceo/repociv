// ─── RepoCiv — Game State ─────────────────────────────────────────────────────

import { type World, type Unit, type Building, type UnitState, tileKey, UNIT_COLORS } from './types.ts';
import type { Axial } from './hex.ts';
import { aStarPath, invalidatePathCache } from './pathfinding.ts';

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
