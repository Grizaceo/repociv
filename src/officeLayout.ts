// ─── RepoCiv — Office cubicle layout templates ───────────────────────────────
// Places desks, chairs, partitions, and aisles; assigns workbenches to desk cells.

import type { LocalRoom, LocalTile, LocalTileType, CubicleFacing, CubiclePlan } from './types.ts';

export const MIN_AISLE_WIDTH = 2;
/** Visual cap: a room never renders more than this many desks. Folders with
 *  more files keep every workbench in room.workbenches (missions fall back to
 *  the unit's assigned desk) and the renderer's cluster pill summarizes the
 *  overflow. Without the cap, big folders produce screen-filling desk carpets
 *  that stop reading as an office. 12 = the reference layout's 4×3 grid. */
export const MAX_DESKS_PER_ROOM = 12;
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

function isFloorTile(
  grid: LocalTile[][],
  x: number,
  y: number,
  gridW: number,
  gridH: number,
): boolean {
  if (!inBounds(x, y, gridW, gridH)) return false;
  const tile = grid[y]![x]!;
  return tile.type === 'floor';
}

/** Shared geometry for the team-cluster desk grid (reference office look).
 *
 *  A 1-tile walkway ring hugs the walls (the north ring row doubles as the
 *  wall-furniture band), desk columns sit every 2 tiles mirrored around a
 *  central aisle (no aisle in narrow rooms), and desk rows repeat on a
 *  3-row rhythm: desk, chair, open walkway. computeRoomSize sizes rooms
 *  with the same function so capacity and layout can never drift apart. */
interface TeamClusterDims {
  aisleWidth: number;
  /** Desk column x offsets relative to innerX0, sorted ascending. */
  colOffsets: number[];
  /** Desk row y offsets relative to innerY0, vertically centered. */
  rowOffsets: number[];
}

function teamClusterDims(innerW: number, innerH: number): TeamClusterDims {
  const deskX0 = 1;
  const deskX1 = innerW - 2;
  const deskH = innerH - 2;

  const colOffsets: number[] = [];
  let aisleWidth = 0;
  if (innerW >= 7) {
    // Wide room: 2-tile central aisle, desk columns mirrored on both sides
    // with a 1-tile gap to the aisle so nothing reads glued together.
    aisleWidth = MIN_AISLE_WIDTH;
    const mid = Math.floor(innerW / 2);
    const aisleX0 = mid - Math.floor(aisleWidth / 2);
    const aisleX1 = aisleX0 + aisleWidth - 1;
    for (let x = aisleX0 - 2; x >= deskX0; x -= 2) colOffsets.unshift(x);
    for (let x = aisleX1 + 2; x <= deskX1; x += 2) colOffsets.push(x);
  } else {
    // Narrow room: no aisle, columns from the west walkway.
    for (let x = deskX0; x <= deskX1; x += 2) colOffsets.push(x);
  }

  const rowOffsets: number[] = [];
  if (deskH >= 2) {
    const nRows = Math.floor((deskH - 2) / 3) + 1;
    const usedH = (nRows - 1) * 3 + 2;
    const yStart = 1 + Math.floor((deskH - usedH) / 2);
    for (let i = 0; i < nRows; i++) rowOffsets.push(yStart + i * 3);
  }

  return { aisleWidth, colOffsets, rowOffsets };
}

/** Max desks a team-cluster room interior can seat (used by room sizing). */
export function teamClusterCapacity(innerW: number, innerH: number): number {
  if (innerW < 4 || innerH < 3) return 0;
  const dims = teamClusterDims(innerW, innerH);
  return dims.colOffsets.length * dims.rowOffsets.length;
}

/** Team cluster: open-plan desk grid (cat-office style). */
function layoutTeamCluster(
  innerX0: number,
  innerY0: number,
  innerX1: number,
  innerY1: number,
  workbenchCount: number,
): OfficeLayoutResult {
  const innerW = innerX1 - innerX0 + 1;
  const innerH = innerY1 - innerY0 + 1;
  const { aisleWidth, colOffsets, rowOffsets } = teamClusterDims(innerW, innerH);
  const deskTarget = Math.min(workbenchCount, MAX_DESKS_PER_ROOM);

  const placements: LayoutPlacement[] = [];
  const deskPositions: OfficeLayoutResult['deskPositions'] = [];
  let wbIdx = 0;

  // Central aisle (full height) so the entrance reads as a carpet runner.
  if (aisleWidth > 0) {
    const mid = innerX0 + Math.floor(innerW / 2);
    const aisleX0 = mid - Math.floor(aisleWidth / 2);
    for (let y = innerY0; y <= innerY1; y++) {
      for (let x = aisleX0; x < aisleX0 + aisleWidth; x++) {
        placements.push({ x, y, type: 'aisle' });
      }
    }
  }

  for (const rowOff of rowOffsets) {
    if (wbIdx >= deskTarget) break;
    const y = innerY0 + rowOff;
    for (const colOff of colOffsets) {
      if (wbIdx >= deskTarget) break;
      const x = innerX0 + colOff;
      deskPositions.push({ x, y, facing: 's', workbenchIndex: wbIdx });
      placements.push({
        x,
        y,
        type: 'workbench',
        facing: 's',
        decor: 'desk_bundle',
        workbenchIndex: wbIdx,
      });
      placements.push({ x, y: y + 1, type: 'chair', facing: 'n' });
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

  // Checkerboard pass first so adjacent desks don't render glued together;
  // a second contiguous pass only runs if the room is too tight to seat
  // every workbench with spacing.
  let wbIdx = 0;
  const taken = new Set<string>();
  const passes: Array<(f: { x: number; y: number }) => boolean> = [
    (f) => (f.x + f.y) % 2 === 0,
    () => true,
  ];
  for (const accepts of passes) {
    for (const f of floors) {
      if (wbIdx >= room.workbenches.length) break;
      if (!accepts(f) || taken.has(`${f.x},${f.y}`)) continue;
      taken.add(`${f.x},${f.y}`);
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
      // Rooms too tight for the margin-ringed desk grid (capacity 0)
      // pack desks with the fallback instead of rendering empty.
      if (wbCount > 0 && teamClusterCapacity(innerW, innerH) === 0) {
        return layoutFallback(room, grid, gridW, gridH, wallThick);
      }
      return layoutTeamCluster(innerX0, innerY0, innerX1, innerY1, wbCount);
    case 'focus':
      // A focus pod holds a handful of desks (4×4 pod max). Rooms that
      // carry a whole test suite need the grid or most desks vanish.
      if (wbCount > 6) {
        if (teamClusterCapacity(innerW, innerH) === 0) {
          return layoutFallback(room, grid, gridW, gridH, wallThick);
        }
        return layoutTeamCluster(innerX0, innerY0, innerX1, innerY1, wbCount);
      }
      return layoutFocusPod(innerX0, innerY0, innerX1, innerY1, wbCount);
    case 'reception':
      return layoutReception(innerX0, innerY0, innerX1, innerY1);
    default:
      // meeting/infra/break/biophilic rooms hold workbenches too — they get
      // the same ordered desk grid (furnishRooms layers the zone flavor on
      // top). Routing them to layoutFallback packed desks checkerboard-style
      // into one corner of the room, without chairs.
      if (wbCount > 0) {
        if (teamClusterCapacity(innerW, innerH) === 0) {
          return layoutFallback(room, grid, gridW, gridH, wallThick);
        }
        return layoutTeamCluster(innerX0, innerY0, innerX1, innerY1, wbCount);
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
  // Phase E: mark high-density rooms for compact rendering (>=3 workbenches per room)
  room.highDensity = room.workbenches.length >= 3;

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
