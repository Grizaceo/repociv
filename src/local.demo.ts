/**
 * local.demo.ts — Phase 6+7a demo: DAVI walks to a file in local view.
 *
 * Run:  npx tsx src/local.demo.ts
 * (No browser required — purely programmatic simulation)
 */

import { fileURLToPath } from 'node:url';
import { buildLocalWorld } from './localMap.js';
import type { LocalUnit, LocalMission, Workbench } from './types.js';
import type { LocalWorld } from './types.js';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname); // scan the src/ directory

// ─── Mock LocalWorld (real scanner, no bridge needed) ───────────────────────────
const localWorld: LocalWorld = buildLocalWorld('repociv', REPO_ROOT);

console.log('=== RepoCiv Phase 6+7a Demo ===');
console.log(`World: ${localWorld.width}x${localWorld.height} tiles, ${localWorld.rooms.length} rooms, ${localWorld.workbenches.length} workbenches\n`);

// ─── Mock local units registry ────────────────────────────────────────────────
const localUnits: Map<string, LocalUnit> = new Map();
const missionQueue: LocalMission[] = [];

// ─── A* grid pathfinding (simplified inline for demo) ─────────────────────────
function astarGrid(
  world: LocalWorld,
  startX: number, startY: number,
  goalX: number, goalY: number,
): Array<{ x: number; y: number }> {
  // Simple BFS (no terrain costs in local view — all walkable except walls)
  const key = (x: number, y: number) => `${x},${y}`;
  const visited = new Set<string>();
  const queue: Array<{ x: number; y: number; path: Array<{ x: number; y: number }> }> = [
    { x: startX, y: startY, path: [{ x: startX, y: startY }] },
  ];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const k = key(current.x, current.y);
    if (visited.has(k)) continue;
    visited.add(k);

    if (current.x === goalX && current.y === goalY) return current.path;

    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      const nk = key(nx, ny);
      if (visited.has(nk)) continue;
      if (nx < 0 || ny < 0 || nx >= world.width || ny >= world.height) continue;
      const tile = world.grid[ny]?.[nx];
      if (!tile || tile.type === 'wall') continue;  // floor + workbench both walkable
      queue.push({ x: nx, y: ny, path: [...current.path, { x: nx, y: ny }] });
    }
  }
  return [{ x: startX, y: startY }];
}

// ─── Unit factory ─────────────────────────────────────────────────────────────
function spawnLocalUnit(id: string, name: string, unitType: LocalUnit['unitType'], color: string): LocalUnit {
  const startRoom = localWorld.rooms[0]!;
  // Find first non-workbench floor tile in the room for spawn
  let spawnTileX = startRoom.x + 1;
  let spawnTileY = startRoom.y + 1;
  outer:
  for (let ry = startRoom.y + 1; ry < startRoom.y + startRoom.h - 1; ry++) {
    for (let rx = startRoom.x + 1; rx < startRoom.x + startRoom.w - 1; rx++) {
      const tile = localWorld.grid[ry]![rx]!;
      if (tile.type === 'floor' && !tile.workbench) {
        spawnTileX = rx;
        spawnTileY = ry;
        break outer;
      }
    }
  }
  const unit: LocalUnit = {
    id, name, unitType, color,
    gridX: spawnTileX,
    gridY: spawnTileY,
    targetX: null,
    targetY: null,
    path: [],
    pathIndex: 0,
    pathProgress: 0,
    state: 'idle_in_room',
    mission: null,
    workProgress: 0,
    macroUnitId: `macro-${id}`,
  };
  localUnits.set(id, unit);
  return unit;
}

// ─── Mission queue (simple: first available unit takes next queued mission) ───
function enqueueMission(unitId: string, workbench: Workbench): void {
  missionQueue.push({
    id: `mission-${Date.now()}`,
    unitId,
    workbench,
    status: 'queued',
    progress: 0,
  });
}

function processMissionQueue(): void {
  for (const mission of missionQueue) {
    if (mission.status !== 'queued') continue;
    const unit = localUnits.get(mission.unitId);
    if (!unit || unit.state !== 'idle_in_room') continue;

    // Find path to workbench
    const wbTile = findWorkbenchTile(mission.workbench);
    if (!wbTile) {
      console.log(`  [WARN] findWorkbenchTile returned NULL for ${mission.workbench.fileName}`);
      mission.status = 'failed';
      continue;
    }

    const path = astarGrid(localWorld, unit.gridX, unit.gridY, wbTile.x, wbTile.y);
    if (path.length <= 1) {
      // Already at the workbench
      unit.state = 'working_on_file';
      mission.status = 'working';
    } else {
      // Assign mission to unit
      unit.mission = mission.id;
      mission.status = 'walking';
      unit.path = path;
      unit.pathIndex = 0;
      unit.pathProgress = 0;
      unit.targetX = wbTile.x;
      unit.targetY = wbTile.y;
      unit.state = 'walking_to_workbench';
    }
  }
}

function findWorkbenchTile(wb: Workbench): { x: number; y: number } | null {
  for (let y = 0; y < localWorld.height; y++) {
    for (let x = 0; x < localWorld.width; x++) {
      const tile = localWorld.grid[y]?.[x];
      if (tile?.workbench?.filePath === wb.filePath) return { x, y };
    }
  }
  return null;
}

// ─── localUpdate (simplified Phase 7a simulation) ─────────────────────────────
const SPEED = 4; // tiles per second

function localUpdate(dt: number): void {
  for (const unit of localUnits.values()) {
    if (unit.state === 'walking_to_workbench' || unit.state === 'walking_to_room') {
      // Advance path
      unit.pathProgress += SPEED * dt;
      while (unit.pathProgress >= 1 && unit.pathIndex < unit.path.length - 1) {
        unit.pathProgress -= 1;
        unit.pathIndex++;
        const next = unit.path[unit.pathIndex]!;
        unit.gridX = next.x;
        unit.gridY = next.y;
      }

      // Check if arrived
      if (unit.pathIndex >= unit.path.length - 1) {
        const mission = missionQueue.find(m => m.unitId === unit.id && m.status === 'walking');
        unit.state = 'working_on_file';
        unit.path = [];
        unit.pathIndex = 0;
        unit.pathProgress = 0;
        if (mission) mission.status = 'working';
        console.log(`  [ARRIVED] ${unit.name} reached workbench at (${unit.gridX}, ${unit.gridY})`);
      }
    } else if (unit.state === 'working_on_file') {
      // Accumulate work progress
      const mission = missionQueue.find(m => m.unitId === unit.id && (m.status === 'working' || m.status === 'walking'));
      if (mission) {
        mission.progress = Math.min(100, mission.progress + 25 * dt);
        unit.workProgress = mission.progress;
        if (mission.progress >= 100) {
          mission.status = 'complete';
          unit.state = 'idle_in_room';
          unit.mission = null;
          unit.workProgress = 0;
          console.log(`  [COMPLETE] ${unit.name} finished ${mission.workbench.fileName}!`);
        }
      }
    }
  }
}

// ─── DEMO SEQUENCE ────────────────────────────────────────────────────────────
const davi = spawnLocalUnit('davi', 'DAVI', 'hero', '#c8a84b');
const targetWb = localWorld.workbenches.find(w => w.fileName === 'chat.ts')!;

console.log(`Spawning: ${davi.name} at (${davi.gridX}, ${davi.gridY}) in room "${localWorld.rooms[0]!.label}"`);
console.log(`Mission:  walk to ${targetWb.fileName} at (${targetWb.id})\n`);

enqueueMission(davi.id, targetWb);

// ─── Simulate 8 steps of 0.5s each (4 seconds total) ─────────────────────────
// Speed=4 tiles/s, walk=7 tiles → ~1.75s walk + ~2s work
console.log('-- Simulating 8 steps (4s @ 0.5s/step) --');
const STEPS = 8;
for (let i = 0; i <= STEPS; i++) {
  const t = (i / STEPS) * 4;
  processMissionQueue();
  localUpdate(0.5);

  // Log every step to show walking progression
  const state = davi.state.replace(/_/g, ' ');
  const pos = `(${davi.gridX}, ${davi.gridY})`;
  const work = davi.workProgress > 0 ? ` work:${davi.workProgress.toFixed(0)}%` : '';
  const pathLeft = (davi.path.length - davi.pathIndex - 1) > 0 ? ` path-left:${davi.path.length - davi.pathIndex - 1}` : '';
  console.log(`  t=${t.toFixed(1)}s | DAVI: ${state.padEnd(22)} pos=${pos.padEnd(12)}${work}${pathLeft}`);
}

console.log('\n=== Demo complete ===');
console.log('Next: open the browser, double-click a city → local 2D view with agents walking');
