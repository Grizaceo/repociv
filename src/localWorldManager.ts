// ─── RepoCiv — Local World Manager (Phase 6 / 7a) ────────────────────────────
// Extracted from GameState to reduce god-object size.
// Owns all "RimWorld-style" local view state and logic.

import type { Unit, LocalWorld, LocalUnit, LocalMission, ViewMode } from './types.ts';
import { UNIT_COLORS } from './types.ts';
import { generateLocalWorldFromApi, buildMockLocalWorld } from './localMap.ts';
import { findPath, findNearestWorkbench } from './localPathfinding.ts';
import { peekNextMission } from './priorityMatrix.ts';

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
  ) {}

  // ─── Phase 6: View transition ──────────────────────────────────────────────

  async enterLocalView(repoId: string): Promise<LocalWorld> {
    if (!this.localWorld || this.localWorld.repoId !== repoId) {
      this.localWorld = await generateLocalWorldFromApi(repoId);
      if (this.localUnits.length === 0) {
        const entrance = this.localWorld.rooms[0] ?? { x: 1, y: 1, w: 4, h: 4 };
        const heroUnit = this.getFirstUnit();
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
          currentRoomId: this.localWorld.grid[entrance.y + Math.floor(entrance.h / 2)]?.[entrance.x + Math.floor(entrance.w / 2)]?.roomId ?? null,
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

  enterLocalViewMock(repoId: string): LocalWorld {
    if (!this.localWorld || this.localWorld.repoId !== repoId) {
      this.localWorld = buildMockLocalWorld(repoId);
      if (this.localUnits.length === 0) {
        const entrance = this.localWorld.rooms[0] ?? { x: 1, y: 1, w: 4, h: 4 };
        this.localUnits.push({
          id: 'DAVI',
          name: 'DAVI',
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
          macroUnitId: 'DAVI',
          currentWorkbenchId: null,
          currentRoomId: this.localWorld.grid[entrance.y + 1]?.[entrance.x + 1]?.roomId ?? null,
          fatigue: 100,
          maxFatigue: 100,
          isResting: false,
          effectiveSpeed: 1,
        });
      }
    }
    this.viewMode = 'local';
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
      // 1. Advance moving units
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
  }

  queueLocalMission(repoId: string, filePath: string, fileName: string): void {
    this.missionQueue.push({
      id: `mission-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      unitId: '',
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
    });
  }

  dispatchMissionById(missionId: string): void {
    const idx = this.missionQueue.findIndex((m) => m.id === missionId && m.status === 'queued');
    if (idx === -1) return;
    this._assignMissionToUnit(this.missionQueue[idx]!);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

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
      const nearest = findNearestWorkbench(this.localWorld, unit.gridX, unit.gridY);
      if (!nearest?.workbench) return;
      wbX = nearest.x;
      wbY = nearest.y;
      wbId = nearest.workbench.id;
      queued.workbench = nearest.workbench;
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
}
