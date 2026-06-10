// ─── RepoCiv — Office cubicle layout templates ───────────────────────────────
// Places desks, chairs, partitions, and aisles; assigns workbenches to desk cells.

import type {
  LocalRoom,
  LocalTile,
  LocalTileType,
  CubicleFacing,
  CubiclePlan,
} from './types.ts';

export const MIN_AISLE_WIDTH = 2;
const WALL_THICKNESS = 1;

export interface LayoutPlacement {
  x: number;
  y: number;
  type: LocalTileType;
  facing?: CubicleFacing;
  decor?: 'desk_bundle';
  workbenchIndex?: number;
}

export interface OfficeLayoutResult {
  plan: CubiclePlan;
  placements: LayoutPlacement[];
  deskPositions: Array<{ x: number; y: number; facing: CubicleFacing; workbenchIndex: number }>;
}

function inBounds(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h;
}

function isFloorTile(grid: LocalTile[][], x: number, y: number, gridW: number, gridH: number): boolean {
  if (!inBounds(x, y, gridW, gridH)) return false;
  const tile = grid[y]![x]!;
  return tile.type === 'floor';
}

/** Team cluster: central aisle (≥2 tiles) with desk rows and partitions between rows. */
function layoutTeamCluster(
  innerX0: number,
  innerY0: number,
  innerX1: number,
  innerY1: number,
  workbenchCount: number,
): OfficeLayoutResult {
  const innerW = innerX1 - innerX0 + 1;
  const aisleWidth = innerW >= MIN_AISLE_WIDTH + 2 ? MIN_AISLE_WIDTH : 1;
  const mid = innerX0 + Math.floor(innerW / 2);
  const aisleX0 = mid - Math.floor(aisleWidth / 2);
  const aisleX1 = aisleX0 + aisleWidth - 1;

  const leftDeskX = aisleX0 - 1;
  const rightDeskX = aisleX1 + 1;

  const placements: LayoutPlacement[] = [];
  const deskPositions: OfficeLayoutResult['deskPositions'] = [];
  let wbIdx = 0;

  // Central aisle (full height)
  for (let y = innerY0; y <= innerY1; y++) {
    for (let x = aisleX0; x <= aisleX1; x++) {
      placements.push({ x, y, type: 'aisle' });
    }
  }

  // Desk rows every 2 tiles; partition row between groups
  for (let y = innerY0; y <= innerY1; y++) {
    const rowInGroup = (y - innerY0) % 3;
    if (rowInGroup === 1) {
      // Horizontal partition between desk rows
      for (let x = innerX0; x <= innerX1; x++) {
        if (x >= aisleX0 && x <= aisleX1) continue;
        placements.push({ x, y, type: 'cubicle_partition', facing: 'n' });
      }
      continue;
    }

    if (wbIdx >= workbenchCount) continue;

    if (leftDeskX >= innerX0 && wbIdx < workbenchCount) {
      deskPositions.push({ x: leftDeskX, y, facing: 'e', workbenchIndex: wbIdx });
      placements.push({
        x: leftDeskX,
        y,
        type: 'workbench',
        facing: 'e',
        decor: 'desk_bundle',
        workbenchIndex: wbIdx,
      });
      const chairX = leftDeskX - 1;
      if (chairX >= innerX0) {
        placements.push({ x: chairX, y, type: 'chair', facing: 'w' });
      }
      wbIdx++;
    }

    if (rightDeskX <= innerX1 && wbIdx < workbenchCount) {
      deskPositions.push({ x: rightDeskX, y, facing: 'w', workbenchIndex: wbIdx });
      placements.push({
        x: rightDeskX,
        y,
        type: 'workbench',
        facing: 'w',
        decor: 'desk_bundle',
        workbenchIndex: wbIdx,
      });
      const chairX = rightDeskX + 1;
      if (chairX <= innerX1) {
        placements.push({ x: chairX, y, type: 'chair', facing: 'e' });
      }
      wbIdx++;
    }
  }

  return {
    plan: { template: 'open_rows', aisleWidth, deskCount: deskPositions.length },
    placements,
    deskPositions,
  };
}

/** Focus pod: 2×2 cubicle with partitions on 3 sides + desk + chair. */
function layoutFocusPod(
  innerX0: number,
  innerY0: number,
  innerX1: number,
  innerY1: number,
  workbenchCount: number,
): OfficeLayoutResult {
  const placements: LayoutPlacement[] = [];
  const deskPositions: OfficeLayoutResult['deskPositions'] = [];

  const podW = Math.min(4, innerX1 - innerX0 + 1);
  const podH = Math.min(4, innerY1 - innerY0 + 1);
  const podX0 = innerX0 + Math.floor((innerX1 - innerX0 + 1 - podW) / 2);
  const podY0 = innerY0 + Math.floor((innerY1 - innerY0 + 1 - podH) / 2);
  const podX1 = podX0 + podW - 1;
  const podY1 = podY0 + podH - 1;

  // Partitions on north, west, east (3 sides)
  for (let x = podX0; x <= podX1; x++) {
    placements.push({ x, y: podY0, type: 'cubicle_partition', facing: 'n' });
  }
  for (let y = podY0; y <= podY1; y++) {
    placements.push({ x: podX0, y, type: 'cubicle_partition', facing: 'w' });
    if (podX1 > podX0) {
      placements.push({ x: podX1, y, type: 'cubicle_partition', facing: 'e' });
    }
  }

  // Interior aisle strip toward entrance (south)
  if (podH >= 3) {
    const aisleY = podY1;
    for (let x = podX0 + 1; x < podX1; x++) {
      placements.push({ x, y: aisleY, type: 'aisle' });
    }
  }

  let wbIdx = 0;
  const deskX = podX0 + Math.floor(podW / 2);
  const deskY = podY0 + 1;
  if (workbenchCount > 0 && deskX <= podX1 && deskY <= podY1) {
    deskPositions.push({ x: deskX, y: deskY, facing: 's', workbenchIndex: 0 });
    placements.push({
      x: deskX,
      y: deskY,
      type: 'workbench',
      facing: 's',
      decor: 'desk_bundle',
      workbenchIndex: 0,
    });
    if (deskY + 1 <= podY1) {
      placements.push({ x: deskX, y: deskY + 1, type: 'chair', facing: 'n' });
    }
    wbIdx = 1;
  }

  // Extra workbenches in remaining floor inside pod. Skip cells that
  // are already claimed as aisle or partition (first-wins). Without
  // this filter deskPositions.length would count workbenches that
  // were actually applied as something else, inflating plan.deskCount
  // and making pathfinding aim units at non-existent desk cells.
  const reservedCells = new Set(
    placements
      .filter((p) => p.type === 'aisle' || p.type === 'cubicle_partition')
      .map((p) => `${p.x},${p.y}`),
  );
  for (let y = podY0 + 1; y <= podY1 && wbIdx < workbenchCount; y++) {
    for (let x = podX0 + 1; x < podX1 && wbIdx < workbenchCount; x++) {
      if (x === deskX && y === deskY) continue;
      if (reservedCells.has(`${x},${y}`)) continue;
      deskPositions.push({ x, y, facing: 's', workbenchIndex: wbIdx });
      placements.push({
        x,
        y,
        type: 'workbench',
        facing: 's',
        decor: 'desk_bundle',
        workbenchIndex: wbIdx,
      });
      reservedCells.add(`${x},${y}`);
      wbIdx++;
    }
  }

  return {
    plan: { template: 'focus_pod', aisleWidth: 1, deskCount: deskPositions.length },
    placements,
    deskPositions,
  };
}

/** Reception: aisle to center desk; corners reserved for plants (furnishRooms). */
function layoutReception(
  innerX0: number,
  innerY0: number,
  innerX1: number,
  innerY1: number,
): OfficeLayoutResult {
  const placements: LayoutPlacement[] = [];
  const cx = innerX0 + Math.floor((innerX1 - innerX0) / 2);
  const aisleWidth = Math.min(MIN_AISLE_WIDTH, innerX1 - innerX0 + 1);

  for (let y = innerY0; y <= innerY1; y++) {
    for (let dx = 0; dx < aisleWidth; dx++) {
      const x = cx - Math.floor(aisleWidth / 2) + dx;
      if (x >= innerX0 && x <= innerX1) {
        placements.push({ x, y, type: 'aisle' });
      }
    }
  }

  return {
    plan: { template: 'reception', aisleWidth, deskCount: 0 },
    placements,
    deskPositions: [],
  };
}

/** Fallback row-major desk placement when room is too small for templates. */
function layoutFallback(
  room: LocalRoom,
  grid: LocalTile[][],
  gridW: number,
  gridH: number,
  wallThick: number,
): OfficeLayoutResult {
  const placements: LayoutPlacement[] = [];
  const deskPositions: OfficeLayoutResult['deskPositions'] = [];
  const floors: Array<{ x: number; y: number }> = [];

  for (let ry = room.y + wallThick; ry < room.y + room.height - wallThick; ry++) {
    for (let rx = room.x + wallThick; rx < room.x + room.width - wallThick; rx++) {
      if (isFloorTile(grid, rx, ry, gridW, gridH)) floors.push({ x: rx, y: ry });
    }
  }

  let wbIdx = 0;
  for (const f of floors) {
    if (wbIdx >= room.workbenches.length) break;
    deskPositions.push({ x: f.x, y: f.y, facing: 's', workbenchIndex: wbIdx });
    placements.push({
      x: f.x,
      y: f.y,
      type: 'workbench',
      facing: 's',
      decor: 'desk_bundle',
      workbenchIndex: wbIdx,
    });
    wbIdx++;
  }

  return {
    plan: { template: 'open_rows', aisleWidth: 0, deskCount: deskPositions.length },
    placements,
    deskPositions,
  };
}

export function layoutOfficeRoom(
  room: LocalRoom,
  grid: LocalTile[][],
  gridW: number,
  gridH: number,
  wallThick = WALL_THICKNESS,
): OfficeLayoutResult {
  const innerX0 = room.x + wallThick;
  const innerY0 = room.y + wallThick;
  const innerX1 = room.x + room.width - wallThick - 1;
  const innerY1 = room.y + room.height - wallThick - 1;
  const innerW = innerX1 - innerX0 + 1;
  const innerH = innerY1 - innerY0 + 1;
  const wbCount = room.workbenches.length;
  const zone = room.zoneType ?? 'team_cluster';

  if (innerW < 4 || innerH < 3) {
    return layoutFallback(room, grid, gridW, gridH, wallThick);
  }

  switch (zone) {
    case 'team_cluster':
      if (innerW >= 6) {
        return layoutTeamCluster(innerX0, innerY0, innerX1, innerY1, wbCount);
      }
      return layoutFallback(room, grid, gridW, gridH, wallThick);
    case 'focus':
      return layoutFocusPod(innerX0, innerY0, innerX1, innerY1, wbCount);
    case 'reception':
      return layoutReception(innerX0, innerY0, innerX1, innerY1);
    default:
      if (wbCount > 0) {
        return layoutFallback(room, grid, gridW, gridH, wallThick);
      }
      return {
        plan: { template: 'open_rows', aisleWidth: 0, deskCount: 0 },
        placements: [],
        deskPositions: [],
      };
  }
}

const LAYOUT_TILE_TYPES = new Set<LocalTileType>([
  'aisle',
  'cubicle_partition',
  'chair',
  'workbench',
]);

/** Apply cubicle layout to grid and assign workbenches to desk cells. */
export function applyOfficeLayout(
  room: LocalRoom,
  grid: LocalTile[][],
  gridW: number,
  gridH: number,
  wallThick = WALL_THICKNESS,
): void {
  const result = layoutOfficeRoom(room, grid, gridW, gridH, wallThick);
  room.layoutPlan = result.plan;
  // Phase E: mark high-density rooms for compact rendering
  room.highDensity = room.workbenches.length > 4;

  for (const p of result.placements) {
    if (!inBounds(p.x, p.y, gridW, gridH)) continue;
    const tile = grid[p.y]![p.x]!;
    if (tile.type !== 'floor' && tile.type !== 'path') continue;

    tile.type = p.type;
    if (p.facing) tile.facing = p.facing;
    if (p.decor) tile.decor = p.decor;

    if (p.type === 'workbench' && p.workbenchIndex !== undefined) {
      const wb = room.workbenches[p.workbenchIndex];
      if (wb) tile.workbench = wb;
    }
  }
}

/** Count central aisle width in a room (for tests). */
export function measureAisleWidth(
  grid: LocalTile[][],
  room: LocalRoom,
  wallThick = WALL_THICKNESS,
): number {
  const innerX0 = room.x + wallThick;
  const innerY0 = room.y + wallThick;
  const innerX1 = room.x + room.width - wallThick - 1;
  const innerY1 = room.y + room.height - wallThick - 1;
  const midY = innerY0 + Math.floor((innerY1 - innerY0) / 2);

  let maxRun = 0;
  let run = 0;
  for (let x = innerX0; x <= innerX1; x++) {
    const tile = grid[midY]?.[x];
    if (tile?.type === 'aisle' && tile.roomId === room.id) {
      run++;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 0;
    }
  }
  return maxRun;
}

export function isLayoutReservedTile(tile: LocalTile): boolean {
  return LAYOUT_TILE_TYPES.has(tile.type);
}
