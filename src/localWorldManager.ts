// ─── RepoCiv — Local World Manager (Phase 6 / 7a) ────────────────────────────
// Extracted from GameState to reduce god-object size.
// Owns all "RimWorld-style" local view state and logic.

import type { Unit, LocalWorld, LocalUnit, LocalTile, LocalMission, ViewMode } from './types.ts';
import { UNIT_COLORS } from './types.ts';
import { generateLocalWorldFromApi, buildMockLocalWorld, BATTERY_STORED } from './localMap.ts';
import { findPath, findNearestWorkbench } from './localPathfinding.ts';
import { peekNextMission } from './priorityMatrix.ts';
import { logger } from './logger.ts';

const TICK_MS = 16; // must match game.ts

export class LocalWorldManager {
  viewMode: ViewMode = 'macro';
  private localWorld: LocalWorld | null = null;
  private localUnits: LocalUnit[] = [];
  private missionQueue: LocalMission[] = [];
  private localTickCount = 0;

  constructor(
    private readonly notify: () => void,
    /** Returns the first macro-world unit (used to seed the local unit on entry). */
    private readonly getFirstUnit: () => Unit | undefined,
    private readonly getMacroUnit?: (id: string) => Unit | undefined,
  ) {}

  // ─── Phase 6: View transition ──────────────────────────────────────────────

  async enterLocalView(repoId: string): Promise<LocalWorld> {
    if (this.viewMode !== 'local') {
      this.viewMode = 'local';
      this.notify();
    }
    if (!this.localWorld || this.localWorld.repoId !== repoId) {
      this.localWorld = await generateLocalWorldFromApi(repoId);
      if (this.localUnits.length === 0) {
        const entrance = this.localWorld.rooms.find((r) => r.zoneType === 'reception') ?? this.localWorld.rooms[0] ?? { x: 1, y: 1, w: 4, h: 4 };
        const heroUnit = this.getFirstUnit();
        this.localUnits.push({
          id: heroUnit?.id ?? 'MAIN',
          name: heroUnit?.name ?? 'MAIN',
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
          macroUnitId: heroUnit?.id ?? 'MAIN',
          currentWorkbenchId: null,
          currentRoomId:
            this.localWorld.grid[entrance.y + Math.floor(entrance.h / 2)]?.[
              entrance.x + Math.floor(entrance.w / 2)
            ]?.roomId ?? null,
          fatigue: heroUnit?.fatigue ?? 100,
          maxFatigue: heroUnit?.maxFatigue ?? 100,
          isResting: heroUnit?.isResting ?? false,
          effectiveSpeed: heroUnit?.effectiveSpeed ?? 1,
        });
        this.assignDesk(this.localUnits[this.localUnits.length - 1]!);
      }
    }
    return this.localWorld;
  }

  enterLocalViewMock(repoId: string): LocalWorld {
    if (this.viewMode !== 'local') {
      this.viewMode = 'local';
      this.notify();
    }
    if (!this.localWorld || this.localWorld.repoId !== repoId) {
      this.localWorld = buildMockLocalWorld(repoId);
      if (this.localUnits.length === 0) {
        const entrance = this.localWorld.rooms.find((r) => r.zoneType === 'reception') ?? this.localWorld.rooms[0] ?? { x: 1, y: 1, w: 4, h: 4 };
        this.localUnits.push({
          id: 'MAIN',
          name: 'MAIN',
          unitType: 'hero',
          color: '#4af',
          gridX: entrance.x + 1,
          gridY: entrance.y + 1,
          targetX: null,
          targetY: null,
          path: [],
          pathIndex: 0,
          pathProgress: 0,
          state: 'idle_in_room',
          mission: null,
          workProgress: 0,
          macroUnitId: 'MAIN',
          currentWorkbenchId: null,
          currentRoomId: this.localWorld.grid[entrance.y + 1]?.[entrance.x + 1]?.roomId ?? null,
          fatigue: 100,
          maxFatigue: 100,
          isResting: false,
          effectiveSpeed: 1,
        });
        this.assignDesk(this.localUnits[this.localUnits.length - 1]!);
      }
    }
    return this.localWorld;
  }

  enterMacroView(): void {
    this.viewMode = 'macro';
  }

  getLocalWorld(): LocalWorld | null {
    return this.localWorld;
  }
  getLocalUnits(): LocalUnit[] {
    return this.localUnits;
  }
  getLocalUnit(id: string): LocalUnit | undefined {
    return this.localUnits.find((u) => u.id === id);
  }
  getMissionQueue(): LocalMission[] {
    return this.missionQueue;
  }
  getLocalTick(): number {
    return this.localTickCount;
  }

  // ─── Phase 7a: Local update loop ──────────────────────────────────────────

  tick(dt: number): void {
    if (this.viewMode !== 'local' || !this.localWorld) return;
    this.localTickCount++;
    const scale = dt / TICK_MS;

    for (const unit of this.localUnits) {
      // 1. Advance moving units (workbench)
      if (unit.state === 'walking_to_workbench' && unit.pathIndex < unit.path.length) {
        unit.pathProgress += 0.06 * unit.effectiveSpeed * scale;
        if (unit.pathProgress >= 1) {
          unit.pathProgress = 0;
          const step = unit.path[unit.pathIndex]!;
          unit.gridX = step.x;
          unit.gridY = step.y;
          // Spatial awareness: update room on tile change (efficient, not every tick)
          const tile = this.localWorld?.grid[unit.gridY]?.[unit.gridX];
          unit.currentRoomId = tile?.roomId ?? null;
          unit.pathIndex++;
          if (unit.pathIndex >= unit.path.length) {
            unit.path = [];
            unit.pathIndex = 0;
            unit.state = unit.currentWorkbenchId ? 'working_on_file' : 'idle_in_room';
            unit.workProgress = 0;
          }
        }
      }

      // 1b. Advance moving units (rest/bed)
      if (unit.state === 'walking_to_room' && unit.pathIndex < unit.path.length) {
        unit.pathProgress += 0.06 * unit.effectiveSpeed * scale;
        if (unit.pathProgress >= 1) {
          unit.pathProgress = 0;
          const step = unit.path[unit.pathIndex]!;
          unit.gridX = step.x;
          unit.gridY = step.y;
          const tile = this.localWorld?.grid[unit.gridY]?.[unit.gridX];
          unit.currentRoomId = tile?.roomId ?? null;
          unit.pathIndex++;
          if (unit.pathIndex >= unit.path.length) {
            unit.path = [];
            unit.pathIndex = 0;
            unit.state = 'resting';
            unit.isResting = true;
            unit.workProgress = 0;
          }
        }
      }

      // 2. Advance working units
      if (unit.state === 'working_on_file') {
        unit.workProgress = Math.min(100, (unit.workProgress ?? 0) + 0.08 * scale);
        if (unit.workProgress >= 100) {
          this._completeLocalMission(unit.id);
        }
      }
    }

    // 3. Dispatch idle unit → next queued mission (~every 500ms)
    if (this.localTickCount % 30 === 0) {
      this._dispatchNextMission();
    }

    // 4. Power System tick (every 100ms = ~6 ticks)
    if (this.localTickCount % 6 === 0) {
      this._tickPowerSystem();
    }

    // 5. Rest System tick (every 200ms = ~12 ticks)
    if (this.localTickCount % 12 === 0) {
      this._tickRestSystem();
    }

    // 6. Temperature System tick (every 500ms = ~30 ticks)
    if (this.localTickCount % 30 === 0) {
      this._tickTemperatureSystem();
    }
  }

  private _tickRestSystem(): void {
    if (!this.localWorld || !this.localWorld.restAreas) return;

    for (const unit of this.localUnits) {
      // Fatigue decreases while working, increases while resting
      if (unit.state === 'working_on_file') {
        unit.fatigue = Math.max(0, unit.fatigue - 0.5); // fatigue drain per tick
      } else if (unit.state === 'resting') {
        // Recovery handled by rest area
      } else if (unit.state === 'idle_in_room' || unit.state === 'walking_to_workbench' || unit.state === 'walking_to_room') {
        unit.fatigue = Math.max(0, unit.fatigue - 0.1); // slow drain while idle/moving
      }

      // Auto-seek rest when fatigue < 30 and not already resting
      if (unit.fatigue < 30 && unit.state !== 'resting' && unit.state !== 'walking_to_room') {
        this._sendUnitToRest(unit);
      }

      // Resting units recover fatigue
      if (unit.state === 'resting' && unit.restingRoomId) {
        const restArea = this.localWorld.restAreas.find(ra => ra.id === unit.restingRoomId);
        if (restArea) {
          const recoveryPerTick = (restArea.recoveryRate / 1000) * TICK_MS * 12; // per 12-tick interval
          unit.fatigue = Math.min(unit.maxFatigue, unit.fatigue + recoveryPerTick);

          // Leave rest when fully recovered
          if (unit.fatigue >= unit.maxFatigue * 0.95) {
            this._exitRest(unit, restArea);
          }
        } else {
          // Rest area gone, exit rest
          unit.state = 'idle_in_room';
          unit.isResting = false;
          unit.restingRoomId = undefined;
        }
      }
    }
  }

  private _sendUnitToRest(unit: LocalUnit): void {
    if (!this.localWorld || !this.localWorld.restAreas || this.localWorld.restAreas.length === 0) return;

    // Find available rest area with capacity
    let bestRest: typeof this.localWorld.restAreas[0] | null = null;
    let bestDist = Infinity;

    for (const rest of this.localWorld.restAreas) {
      if (rest.unitsInside.length >= rest.capacity) continue;

      // Find nearest bed tile
      for (const bedTile of rest.tiles) {
        const dist = Math.abs(unit.gridX - bedTile.x) + Math.abs(unit.gridY - bedTile.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestRest = rest;
        }
      }
    }

    if (!bestRest) return;

    // Pick a free bed
    const freeBed = bestRest.tiles.find(() => !bestRest.unitsInside.includes(unit.id));
    if (!freeBed) return;

    // Path to bed
    const pathResult = findPath(this.localWorld, unit.gridX, unit.gridY, freeBed.x, freeBed.y);
    if (!pathResult) return;

    unit.path = pathResult.path;
    unit.pathIndex = 0;
    unit.pathProgress = 0;
    unit.state = 'walking_to_room';
    unit.targetX = freeBed.x;
    unit.targetY = freeBed.y;
    unit.restingRoomId = bestRest.id;
    bestRest.unitsInside.push(unit.id);
  }

  private _exitRest(unit: LocalUnit, restArea: { id: string; unitsInside: string[] }): void {
    unit.state = 'idle_in_room';
    unit.isResting = false;
    unit.restingRoomId = undefined;
    restArea.unitsInside = restArea.unitsInside.filter(id => id !== unit.id);
  }

  private _tickPowerSystem(): void {
    if (!this.localWorld || !this.localWorld.powerGrid) return;

    const pg = this.localWorld.powerGrid;

    // Calculate net power
    let generated = 0;
    for (const src of pg.sources) {
      if (src.type === 'generator' && src.fuel !== undefined) {
        src.fuel = Math.max(0, src.fuel - 0.1); // fuel consumption
        if (src.fuel > 0) generated += src.outputWatts;
      } else if (src.type === 'solar') {
        // Solar varies with "time of day" simulation
        const hour = (Date.now() / 3600000) % 24;
        const solarFactor = hour > 6 && hour < 18 ? Math.sin((hour - 6) / 12 * Math.PI) : 0;
        generated += src.outputWatts * solarFactor;
      } else if (src.type === 'wind') {
        // Wind is random-ish
        generated += src.outputWatts * (0.3 + Math.random() * 0.7);
      }
      // Batteries don't generate
    }

    let consumed = 0;
    for (const cons of pg.consumers) {
      consumed += cons.watts;
    }

    pg.generatedWatts = Math.round(generated);
    pg.consumedWatts = Math.round(consumed);

    // Battery charge/discharge
    const netWatts = pg.generatedWatts - pg.consumedWatts;
    if (netWatts > 0) {
      // Charge batteries
      for (const src of pg.sources) {
        if (src.type === 'battery' && src.fuel !== undefined) {
          src.fuel = Math.min(100, src.fuel + (netWatts / BATTERY_STORED) * 100 * (1/600)); // per tick
          pg.storedWatts = Math.round(src.fuel / 100 * BATTERY_STORED);
        }
      }
    } else if (netWatts < 0) {
      // Discharge batteries
      const deficit = Math.abs(netWatts);
      for (const src of pg.sources) {
        if (src.type === 'battery' && src.fuel !== undefined && src.fuel > 0) {
          const draw = Math.min(deficit, src.fuel / 100 * BATTERY_STORED * (1/600));
          src.fuel = Math.max(0, src.fuel - (draw / BATTERY_STORED) * 100 * 600);
          pg.storedWatts = Math.round(src.fuel / 100 * BATTERY_STORED);
        }
      }
    }

    // Power outage incident if severe deficit
    if (pg.consumedWatts > pg.generatedWatts + pg.storedWatts * 0.1 && Math.random() < 0.001) {
      // Could trigger incident system later
      logger.warn('[Power] Grid overload! Consumed:', pg.consumedWatts, 'Generated:', pg.generatedWatts, 'Stored:', pg.storedWatts);
    }
  }

  queueLocalMission(repoId: string, filePath: string, fileName: string, unitId?: string): void {
    const mission: LocalMission = {
      id: `mission-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      unitId: unitId ?? '',
      repoId,
      filePath,
      fileName,
      status: 'queued',
      assignedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      workbenchId: '',
      workbench: null,
      progress: 0,
    };
    this.missionQueue.push(mission);

    if (unitId) {
      this._assignMissionToSpecificUnit(mission, unitId);
    }
  }

  dispatchMissionById(missionId: string): void {
    const idx = this.missionQueue.findIndex((m) => m.id === missionId && m.status === 'queued');
    if (idx === -1) return;
    this._assignMissionToUnit(this.missionQueue[idx]!);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private _assignMissionToSpecificUnit(queued: LocalMission, unitId: string): void {
    let unit = this.localUnits.find((u) => u.id === unitId || u.macroUnitId === unitId);
    if (!unit && this.localWorld) {
      // Spawn unit at the reception entrance
      const macroUnit = this.getMacroUnit?.(unitId);
      const entrance = this.localWorld.rooms.find((r) =>
        r.zoneType === 'reception') ?? this.localWorld.rooms[0] ?? { x: 1, y: 1, w: 4, h: 4 };
      const gx = entrance.x + Math.floor(entrance.w / 2);
      const gy = entrance.y + Math.floor(entrance.h / 2);
      const color = macroUnit ? (UNIT_COLORS[macroUnit.type] ?? '#4af') : '#4af';

      unit = {
        id: unitId,
        name: macroUnit?.name ?? unitId,
        unitType: macroUnit?.type ?? 'worker',
        color,
        gridX: gx,
        gridY: gy,
        targetX: null,
        targetY: null,
        path: [],
        pathIndex: 0,
        pathProgress: 0,
        state: 'idle_in_room',
        mission: macroUnit?.mission ?? null,
        workProgress: 0,
        macroUnitId: unitId,
        currentWorkbenchId: null,
        currentRoomId: this.localWorld.grid[gy]?.[gx]?.roomId ?? null,
        fatigue: macroUnit?.fatigue ?? 100,
        maxFatigue: macroUnit?.maxFatigue ?? 100,
        isResting: macroUnit?.isResting ?? false,
        effectiveSpeed: macroUnit?.effectiveSpeed ?? 1,
      };
      this.localUnits.push(unit);
      this.assignDesk(unit);
    }

    if (!unit || !this.localWorld) return;

    // Interrupt current mission for this unit in missionQueue
    for (const m of this.missionQueue) {
      if (m.unitId === unit.id && (m.status === 'walking' || m.status === 'working')) {
        m.status = 'failed';
        m.completedAt = Date.now();
      }
    }

    let wbX = -1,
      wbY = -1,
      wbId = '';
    outer: for (const row of this.localWorld.grid) {
      for (const tile of row) {
        if (tile.type === 'workbench' && tile.workbench?.filePath === queued.filePath) {
          wbX = tile.x;
          wbY = tile.y;
          wbId = tile.workbench.id;
          break outer;
        }
      }
    }
    if (wbX === -1) {
      // Phase B: prefer assigned desk if reachable
      const best = this.findBestWorkbench(unit);
      if (!best?.workbench) return;
      wbX = best.x;
      wbY = best.y;
      wbId = best.workbench.id;
      queued.workbench = best.workbench;
    }

    const pathResult = findPath(this.localWorld, unit.gridX, unit.gridY, wbX, wbY);
    if (!pathResult) return;

    unit.currentWorkbenchId = wbId;
    unit.path = pathResult.path;
    unit.pathIndex = 0;
    unit.pathProgress = 0;
    unit.state = 'walking_to_workbench';
    unit.isResting = false;
    queued.unitId = unit.id;
    queued.workbenchId = wbId;
    queued.status = 'walking';
    queued.startedAt = Date.now();
    this.notify();
  }

  private _assignMissionToUnit(queued: LocalMission): void {
    const unit = this.localUnits.find((u) => u.state === 'idle_in_room');
    if (!unit || !this.localWorld) return;

    let wbX = -1,
      wbY = -1,
      wbId = '';
    outer: for (const row of this.localWorld.grid) {
      for (const tile of row) {
        if (tile.type === 'workbench' && tile.workbench?.filePath === queued.filePath) {
          wbX = tile.x;
          wbY = tile.y;
          wbId = tile.workbench.id;
          break outer;
        }
      }
    }
    if (wbX === -1) {
      // Phase B: prefer assigned desk if reachable
      const best = this.findBestWorkbench(unit);
      if (!best?.workbench) return;
      wbX = best.x;
      wbY = best.y;
      wbId = best.workbench.id;
      queued.workbench = best.workbench;
    }

    const pathResult = findPath(this.localWorld, unit.gridX, unit.gridY, wbX, wbY);
    if (!pathResult) return;

    unit.currentWorkbenchId = wbId;
    unit.path = pathResult.path;
    unit.pathIndex = 0;
    unit.pathProgress = 0;
    unit.state = 'walking_to_workbench';
    queued.unitId = unit.id;
    queued.workbenchId = wbId;
    queued.status = 'walking';
    queued.startedAt = Date.now();
  }

  // ─── Phase B: Desk assignment helpers ─────────────────────────────────────

  /** Prefers the unit's assigned desk if free and reachable; falls back to nearest. */
  findBestWorkbench(
    unit: LocalUnit,
  ): { x: number; y: number; workbench: LocalTile['workbench']; distance: number } | null {
    if (!this.localWorld) return null;

    // Try assigned desk first
    if (unit.assignedDesk) {
      const deskKey = `${unit.assignedDesk.x},${unit.assignedDesk.y}`;
      const owner = this.localWorld.deskAssignments.get(deskKey);
      if (!owner || owner === unit.id) {
        const pathResult = findPath(this.localWorld, unit.gridX, unit.gridY, unit.assignedDesk.x, unit.assignedDesk.y);
        if (pathResult) {
          const tile = this.localWorld.grid[unit.assignedDesk.y]?.[unit.assignedDesk.x];
          if (tile?.workbench) {
            return { x: unit.assignedDesk.x, y: unit.assignedDesk.y, workbench: tile.workbench, distance: pathResult.cost };
          }
        }
      }
    }

    // Fallback to nearest — skipping desks assigned to other units
    return findNearestWorkbench(this.localWorld, unit.gridX, unit.gridY, unit.id);
  }

  /** Assign a free desk: prefer the unit's room, fall back to the nearest
   *  free desk anywhere. Units spawn in the reception, which has no desks
   *  by design — without the fallback the hero never gets an assignment. */
  assignDesk(unit: LocalUnit): void {
    if (!this.localWorld) return;
    const world = this.localWorld;
    const roomId = unit.currentRoomId;

    let bestInRoom: { x: number; y: number; dist: number } | null = null;
    let bestAnywhere: { x: number; y: number; dist: number } | null = null;
    for (const row of world.grid) {
      for (const tile of row) {
        if (tile.type !== 'workbench' || !tile.workbench) continue;
        const key = `${tile.x},${tile.y}`;
        if (world.deskAssignments.has(key)) continue;
        const dist = Math.abs(unit.gridX - tile.x) + Math.abs(unit.gridY - tile.y);
        if (roomId && tile.roomId === roomId && (!bestInRoom || dist < bestInRoom.dist)) {
          bestInRoom = { x: tile.x, y: tile.y, dist };
        }
        if (!bestAnywhere || dist < bestAnywhere.dist) {
          bestAnywhere = { x: tile.x, y: tile.y, dist };
        }
      }
    }

    const best = bestInRoom ?? bestAnywhere;
    if (best) {
      unit.assignedDesk = { x: best.x, y: best.y };
      world.deskAssignments.set(`${best.x},${best.y}`, unit.id);
    }
  }

  /** Release every desk owned by a unit (call before removing it). */
  releaseDesks(unitId: string): void {
    if (!this.localWorld) return;
    for (const [key, owner] of this.localWorld.deskAssignments) {
      if (owner === unitId) this.localWorld.deskAssignments.delete(key);
    }
  }

  private _dispatchNextMission(): void {
    const queued = this.missionQueue.filter((m) => m.status === 'queued');
    if (queued.length === 0) return;
    const next = peekNextMission(queued);
    if (next) this._assignMissionToUnit(next);
  }

  private _completeLocalMission(unitId: string): void {
    const unit = this.localUnits.find((u) => u.id === unitId);
    if (!unit) return;

    const mission = this.missionQueue.find(
      (m) => m.unitId === unitId && (m.status === 'walking' || m.status === 'working'),
    );
    if (mission) {
      mission.status = 'complete';
      mission.completedAt = Date.now();
    }

    unit.currentWorkbenchId = null;
    unit.workProgress = 0;
    unit.state = 'idle_in_room';
    unit.path = [];
    this.notify();
  }

  /** Swarm Civ: mirror ephemeral subagent as local operator. */
  syncSubagentSpawn(payload: {
    ephemeralUnitId: string;
    parentUnitId: string;
    kind: string;
    label: string;
    repoId: string;
  }): void {
    if (this.viewMode !== 'local' || !this.localWorld) return;
    if (payload.repoId && this.localWorld.repoId !== payload.repoId) return;
    if (this.localUnits.some((u) => u.id === payload.ephemeralUnitId)) return;

    const parent = this.localUnits.find((u) => u.id === payload.parentUnitId);
    const rooms = this.localWorld.rooms;
    const room = rooms[Math.floor(Math.random() * rooms.length)] ?? rooms[0];
    const gx = room ? room.x + Math.floor(room.w / 2) : 2;
    const gy = room ? room.y + Math.floor(room.h / 2) : 2;
    const kind = payload.kind.toLowerCase();
    const unitType =
      kind === 'explore' ? 'scout' : kind === 'shell' ? 'worker' : ('worker' as const);

    this.localUnits.push({
      id: payload.ephemeralUnitId,
      name: payload.label.slice(0, 10) || payload.kind,
      unitType,
      color: parent?.color ?? '#8ab4f8',
      gridX: gx,
      gridY: gy,
      targetX: null,
      targetY: null,
      path: [],
      pathIndex: 0,
      pathProgress: 0,
      state: 'working_on_file',
      mission: payload.label,
      workProgress: 10,
      macroUnitId: payload.parentUnitId,
      currentWorkbenchId: null,
      currentRoomId: room?.id ?? null,
      fatigue: 100,
      maxFatigue: 100,
      isResting: false,
      effectiveSpeed: 1,
      ephemeral: true,
    });
    this.assignDesk(this.localUnits[this.localUnits.length - 1]!);
    this.notify();
  }

  removeSubagentUnit(unitId: string): void {
    const before = this.localUnits.length;
    this.localUnits = this.localUnits.filter((u) => u.id !== unitId);
    if (this.localUnits.length !== before) {
      this.releaseDesks(unitId);
      this.notify();
    }
  }

  private _tickTemperatureSystem(): void {
    if (!this.localWorld || !this.localWorld.roomClimates) return;

    const climates = this.localWorld.roomClimates;
    const HEAT_TRANSFER_RATE = 0.02; // per tick through doors/vents

    for (const [, climate] of climates) {
      // 1. Heaters add heat
      for (const heater of climate.heaters) {
        climate.temperature += (heater.powerWatts / 1000) * 0.5; // simplified heating
      }

      // 2. Coolers remove heat
      for (const cooler of climate.coolers) {
        climate.temperature -= (cooler.powerWatts / 1000) * 0.5; // simplified cooling
      }

      // 3. Heat transfer through vents to adjacent rooms
      for (const vent of climate.vents) {
        if (!vent.open) continue;
        const otherClimate = climates.get(vent.connectedRoomId);
        if (!otherClimate) continue;

        const tempDiff = climate.temperature - otherClimate.temperature;
        const transfer = tempDiff * HEAT_TRANSFER_RATE;
        climate.temperature -= transfer;
        otherClimate.temperature += transfer;
      }

      // 4. Passive heat loss/gain to ambient (21°C)
      const ambientTemp = 21;
      const ambientDiff = climate.temperature - ambientTemp;
      climate.temperature -= ambientDiff * 0.001; // very slow drift to ambient

      // Clamp temperature
      climate.temperature = Math.max(-20, Math.min(50, climate.temperature));
    }

    this.notify();
  }
}
