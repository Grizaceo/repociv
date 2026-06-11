import type { LocalNpc, LocalRoom, LocalTile, LocalUnit, LocalWorld, ZoneType } from './types.ts';
import { drawIsoOfficeSprite, type IsoOfficeDrawContext, ISO_TILE_W, ISO_TILE_H, ISO_WALL_H, isoProject as officeIsoProject } from './isoOfficeSprites.ts';
import {
  drawIsoBreakArea as renderIsoBreakArea,
  drawIsoMeetingTable as renderIsoMeetingTable,
  drawIsoPhoneBooth as renderIsoPhoneBooth,
  drawIsoPrism as renderIsoPrism,
  drawIsoServerRack as renderIsoServerRack,
  drawIsoSofa as renderIsoSofa,
  drawIsoStairs as renderIsoStairs,
} from './isoOfficeRenderer.ts';

export { ISO_TILE_W, ISO_TILE_H, ISO_WALL_H };
export const isoProject = officeIsoProject;

const ISO_FLOOR: Record<string, string> = {
  team_cluster: '#6B8FB5',
  meeting: '#D49B3A',
  focus: '#4A8F4A',
  break: '#C47A4A',
  infra: '#7A8B9E',
  reception: '#C4B8A0',
  biophilic: '#4A9E8E',
  path: '#B8B8B8',
  outside: '#A8A8A8',
};
const ISO_WALL_FACE = '#C8C8C8';
const ISO_WALL_SIDE = '#B0B0B0';
const ISO_WALL_TOP = '#D8D8D8';
const ISO_DOOR_WOOD = '#B89860';
const ISO_DOOR_GLASS = 'rgba(180, 210, 230, 0.4)';
const ISO_WINDOW_SKY: [string, string] = ['rgba(140, 190, 220, 0.5)', 'rgba(180, 210, 230, 0.3)'];
const ISO_HELMET = '#E8B830';
const ISO_SHADOW = 'rgba(80, 80, 80, 0.18)';
const ISO_SELECTION = '#B08040';

export function isoUnproject(px: number, py: number): { x: number; y: number } {
  const x = px / (ISO_TILE_W / 2) + py / (ISO_TILE_H / 2);
  const y = py / (ISO_TILE_H / 2) - px / (ISO_TILE_W / 2);
  return { x: x / 2, y: y / 2 };
}

export function isoTileCorners(x: number, y: number, z = 0): Array<{ x: number; y: number }> {
  const base = isoProject(x, y, z);
  return [
    { x: base.px, y: base.py - ISO_TILE_H / 2 },
    { x: base.px + ISO_TILE_W / 2, y: base.py },
    { x: base.px, y: base.py + ISO_TILE_H / 2 },
    { x: base.px - ISO_TILE_W / 2, y: base.py },
  ];
}

export interface IsoRenderState {
  ctx: CanvasRenderingContext2D;
  cam: { x: number; y: number; zoom: number; cx: number; cy: number };
  world: LocalWorld;
  localUnits: LocalUnit[];
  dt: number;
  lodLow: boolean;
  view: { x0: number; y0: number; x1: number; y1: number };
  tokens: Record<string, string>;
  extColor: Record<string, string>;
  isoStaticLayer: HTMLCanvasElement | null;
  isoStaticOffsetX: number;
  isoStaticOffsetY: number;
  powerOverlay: boolean;
  temperatureOverlay: boolean;
  workbenchLabelOverlay: boolean;
  debugOverlay: boolean;
  zonePaintMode: ZoneType | null;
  zonePaintStart: { x: number; y: number } | null;
  zonePaintCurrent: { x: number; y: number } | null;
  hoveredTile: { x: number; y: number } | null;
  hoveredUnit: LocalUnit | null;
  doorOpenStates: Map<string, number>;
  fpsValue: number;
  onUnitRendered: ((unit: LocalUnit, screenX: number, screenY: number) => void) | null;
  spawnZzz: (x: number, y: number) => void;
  spawnBreath: (x: number, y: number) => void;
  darkenHex: (hex: string, pct: number) => string;
}

interface IsoTileRenderState {
  ctx: CanvasRenderingContext2D;
  world: LocalWorld;
  tokens: Record<string, string>;
  extColor: Record<string, string>;
  doorOpenStates: Map<string, number>;
  spawnZzz: (x: number, y: number) => void;
  spawnBreath: (x: number, y: number) => void;
  darkenHex: (hex: string, pct: number) => string;
  cam?: { x: number; y: number; zoom: number; cx: number; cy: number };
  hoveredUnit?: LocalUnit | null;
  onUnitRendered?: ((unit: LocalUnit, screenX: number, screenY: number) => void) | null;
  fpsValue?: number;
}

function monoFont(state: Pick<IsoRenderState, 'tokens'> | Pick<IsoTileRenderState, 'tokens'>): string {
  return state.tokens.fontMono ?? "'JetBrains Mono', monospace";
}

export function renderIso(state: IsoRenderState) {
  const { world, localUnits, dt, lodLow, view, ctx } = state;

  for (let y = view.y0; y <= view.y1; y++) {
    for (let x = view.x0; x <= view.x1; x++) {
      const tile = world.grid[y]?.[x];
      if (!tile || tile.type !== 'door') continue;
      const key = `${x},${y}`;
      const dpx = isoProject(x, y).px;
      const dpy = isoProject(x, y).py;

      let minD = Infinity;
      for (const unit of localUnits) {
        let gx: number, gy: number;
        if (unit.path.length > 0 && unit.pathIndex < unit.path.length) {
          const from = unit.path[unit.pathIndex]!;
          const to = unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!;
          const t = unit.pathProgress;
          gx = from.x + (to.x - from.x) * t;
          gy = from.y + (to.y - from.y) * t;
        } else {
          gx = unit.gridX;
          gy = unit.gridY;
        }
        const up = isoProject(gx, gy);
        const d = Math.hypot(up.px - dpx, up.py - dpy) / ISO_TILE_W;
        if (d < minD) minD = d;
      }

      const targetOpen = Math.max(0, Math.min(1, (1.8 - minD) * 1.5));
      let currentOpen = state.doorOpenStates.get(key) ?? 0;
      currentOpen = currentOpen + (targetOpen - currentOpen) * (1 - Math.exp(-dt * 12));
      state.doorOpenStates.set(key, currentOpen);
    }
  }

  if (state.isoStaticLayer) {
    ctx.drawImage(state.isoStaticLayer, state.isoStaticOffsetX, state.isoStaticOffsetY);
  }

  const tiles: Array<{ x: number; y: number; tile: LocalTile; z: number }> = [];
  for (let y = view.y0; y <= view.y1; y++) {
    for (let x = view.x0; x <= view.x1; x++) {
      const tile = world.grid[y]?.[x];
      if (!tile) continue;
      if (tile.type === 'floor' || tile.type === 'path' || tile.type === 'wall') continue;
      const z = tile.type === 'door' || tile.type === 'window' ? 2 : tile.type === 'workbench' ? 1 : 0;
      tiles.push({ x, y, tile, z });
    }
  }
  tiles.sort((a, b) => {
    const d = (a.x + a.y) - (b.x + b.y);
    return d !== 0 ? d : a.z - b.z;
  });

  const activeWbIds = new Set(
    localUnits.filter((u) => u.state === 'working_on_file' && u.currentWorkbenchId).map((u) => u.currentWorkbenchId),
  );

  // Desks always render individually — the area-scaled grid layout
  // guarantees they fit. The cluster pill panel is only an overflow
  // summary for rooms with more files than placed desks.
  const isoClusterMap = new Map<string, { room: LocalRoom; extensions: string[] }>();
  for (const room of world.rooms) {
    const placed = room.layoutPlan?.deskCount ?? 0;
    if (room.workbenches.length <= placed || room.workbenches.length < 3) continue;
    isoClusterMap.set(room.id, { room, extensions: room.workbenches.map((wb) => wb.extension) });
  }

  for (const { x, y, tile } of tiles) {
    drawIsoTile(state, tile, x, y, world, activeWbIds);
  }

  for (const { room, extensions } of isoClusterMap.values()) {
    drawIsoWorkbenchCluster(state, room, extensions);
  }

  const npcEntries = (world.npcs ?? [])
    .filter((n) => n.gridX >= view.x0 && n.gridX <= view.x1 && n.gridY >= view.y0 && n.gridY <= view.y1)
    .map((n) => ({ npc: n, sortKey: n.gridX + n.gridY }));
  npcEntries.sort((a, b) => a.sortKey - b.sortKey);
  for (const { npc } of npcEntries) {
    drawIsoNpc(state, npc);
  }

  const unitEntries = localUnits.map((u) => {
    let gx: number, gy: number;
    if (u.path.length > 0 && u.pathIndex < u.path.length) {
      const from = u.path[u.pathIndex]!;
      const to = u.path[Math.min(u.pathIndex + 1, u.path.length - 1)]!;
      const t = u.pathProgress;
      gx = from.x + (to.x - from.x) * t;
      gy = from.y + (to.y - from.y) * t;
    } else {
      gx = u.gridX;
      gy = u.gridY;
    }
    return { unit: u, gx, gy, sortKey: gx + gy };
  });
  unitEntries.sort((a, b) => a.sortKey - b.sortKey);

  drawIsoWindowLightRays(state, world, view);

  for (const { unit, gx, gy } of unitEntries) {
    drawIsoUnit(state, unit, gx, gy);
  }

  if (!lodLow) {
    for (const room of world.rooms) {
      drawIsoRoomLabel(state, room);
    }
  }

  if (!lodLow && state.workbenchLabelOverlay) {
    for (let y = view.y0; y <= view.y1; y++) {
      for (let x = view.x0; x <= view.x1; x++) {
        const tile = world.grid[y]?.[x];
        if (tile?.type !== 'workbench' || !tile.workbench) continue;
        const base = isoProject(x, y);
        const name = tile.workbench.fileName;
        const short = name.length > 8 ? name.slice(0, 6) + '..' : name;
        const textW = ctx.measureText(short).width + 6;
        const labelW = Math.max(24, textW);
        const labelH = 8;
        const lx = base.px - labelW / 2;
        const ly = base.py - ISO_WALL_H - 8;
        ctx.fillStyle = 'rgba(20, 20, 30, 0.8)';
        ctx.beginPath();
        ctx.roundRect(lx, ly, labelW, labelH, 2);
        ctx.fill();
        ctx.fillStyle = '#E2E8F0';
        ctx.font = `bold 5px ${monoFont(state)}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(short, base.px, ly + labelH / 2);
      }
    }
  }

  if (state.powerOverlay && world.powerGrid) {
    drawIsoPowerOverlay(state, world, view);
  }
  if (state.temperatureOverlay && world.roomClimates) {
    drawIsoTemperatureOverlay(state, world, view);
  }
  if (world.zones && world.zones.length > 0) {
    drawIsoZones(state, world, view);
  }
  if (state.zonePaintMode && state.zonePaintStart && state.zonePaintCurrent) {
    drawIsoZonePaintPreview(state, view);
  }
  if (state.hoveredTile) {
    drawIsoHoveredTile(state, state.hoveredTile);
  }
  if (state.debugOverlay) {
    drawIsoDebugOverlay(state, world, localUnits);
  }
}

export function drawIsoTile(
  state: IsoTileRenderState,
  tile: LocalTile,
  gridX: number,
  gridY: number,
  world: LocalWorld,
  activeWbIds?: Set<string | null>,
) {
  const { ctx } = state;
  const corners = isoTileCorners(gridX, gridY);
  const room = tile.roomId ? world.rooms.find((r) => r.id === tile.roomId) : undefined;
  const zone = room?.zoneType;

  const floorKey = zone ?? 'team_cluster';
  let floorColor = ISO_FLOOR[floorKey] || ISO_FLOOR.team_cluster || '#B8B8B8';
  if (tile.type === 'path' || tile.type === 'aisle') floorColor = ISO_FLOOR.path || '#B8B8B8';
  if (!tile.roomId && tile.type !== 'path' && tile.type !== 'aisle') floorColor = ISO_FLOOR.outside || '#A8A8A8';

  ctx.fillStyle = floorColor;
  ctx.beginPath();
  ctx.moveTo(corners[0]!.x, corners[0]!.y);
  ctx.lineTo(corners[1]!.x, corners[1]!.y);
  ctx.lineTo(corners[2]!.x, corners[2]!.y);
  ctx.lineTo(corners[3]!.x, corners[3]!.y);
  ctx.closePath();
  ctx.fill();

  if (zone === 'team_cluster' && (gridX + gridY) % 2 === 0) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.beginPath();
    ctx.arc(corners[0]!.x, corners[0]!.y + ISO_TILE_H * 0.3, ISO_TILE_H * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }
  if (zone === 'meeting') {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(corners[0]!.x, corners[0]!.y + ISO_TILE_H * 0.3);
    ctx.lineTo(corners[2]!.x, corners[2]!.y - ISO_TILE_H * 0.3);
    ctx.stroke();
  }
  if (zone === 'focus') {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.beginPath();
    ctx.arc(corners[0]!.x, corners[0]!.y + ISO_TILE_H * 0.2, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  if (zone === 'infra') {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.beginPath();
    ctx.moveTo(corners[0]!.x, corners[0]!.y + ISO_TILE_H * 0.1);
    ctx.lineTo(corners[2]!.x, corners[2]!.y - ISO_TILE_H * 0.1);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(100, 100, 100, 0.15)';
  ctx.lineWidth = 0.5;
  ctx.stroke();

  if (tile.type === 'path' || tile.type === 'aisle') {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
    ctx.beginPath();
    ctx.moveTo(corners[0]!.x, corners[0]!.y);
    ctx.lineTo(corners[1]!.x, corners[1]!.y);
    ctx.lineTo(corners[2]!.x, corners[2]!.y);
    ctx.lineTo(corners[3]!.x, corners[3]!.y);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(corners[0]!.x, corners[0]!.y);
    ctx.lineTo(corners[2]!.x, corners[2]!.y);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const hatchStep = ISO_TILE_H / 4;
    for (let i = -2; i <= 2; i++) {
      const oy = i * hatchStep;
      ctx.moveTo(corners[0]!.x + oy * 0.3, corners[0]!.y + oy);
      ctx.lineTo(corners[2]!.x + oy * 0.3, corners[2]!.y + oy);
    }
    ctx.stroke();

    const north = world.grid[gridY - 1]?.[gridX];
    const south = world.grid[gridY + 1]?.[gridX];
    const east = world.grid[gridY]?.[gridX + 1];
    const west = world.grid[gridY]?.[gridX - 1];
    const doorNeighbors = [north, south, east, west].filter((n): n is LocalTile => n?.type === 'door');
    if (doorNeighbors.length > 0) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const midX = (corners[0]!.x + corners[2]!.x) / 2;
      const midY = (corners[0]!.y + corners[2]!.y) / 2;
      ctx.moveTo(midX - 3, midY);
      ctx.lineTo(midX + 3, midY);
      ctx.stroke();
    }
  }

  if (gridX === 0 || gridY === 0 || gridX === world.width - 1 || gridY === world.height - 1) {
    ctx.strokeStyle = '#606060';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (gridX === 0) {
      ctx.moveTo(corners[3]!.x, corners[3]!.y);
      ctx.lineTo(corners[0]!.x, corners[0]!.y);
    }
    if (gridY === 0) {
      ctx.moveTo(corners[0]!.x, corners[0]!.y);
      ctx.lineTo(corners[1]!.x, corners[1]!.y);
    }
    if (gridX === world.width - 1) {
      ctx.moveTo(corners[1]!.x, corners[1]!.y);
      ctx.lineTo(corners[2]!.x, corners[2]!.y);
    }
    if (gridY === world.height - 1) {
      ctx.moveTo(corners[2]!.x, corners[2]!.y);
      ctx.lineTo(corners[3]!.x, corners[3]!.y);
    }
    ctx.stroke();
  }

  if (tile.type === 'wall' || tile.type === 'door' || tile.type === 'window') {
    drawIsoWallTile(state, tile, gridX, gridY, world, corners, zone);
  }

  const officeDctx: IsoOfficeDrawContext = {
    ctx,
    fontMono: monoFont(state),
    extColor: state.extColor,
    world,
  };
  if (
    tile.type === 'workbench' ||
    tile.type === 'standing_desk' ||
    tile.type === 'chair' ||
    tile.type === 'cubicle_partition' ||
    tile.type === 'reception' ||
    tile.type === 'watercooler' ||
    tile.type === 'planter' ||
    tile.type === 'whiteboard'
  ) {
    drawIsoOfficeSprite(officeDctx, tile, gridX, gridY, activeWbIds);
  } else if (tile.type === 'sofa') {
    renderIsoSofa(ctx, isoProject, gridX, gridY);
  } else if (tile.type === 'server_rack') {
    renderIsoServerRack(ctx, isoProject, gridX, gridY);
  } else if (tile.type === 'meeting_room') {
    renderIsoMeetingTable(ctx, isoProject, gridX, gridY);
  } else if (tile.type === 'phone_booth') {
    renderIsoPhoneBooth(ctx, isoProject, gridX, gridY);
  } else if (tile.type === 'break_area') {
    renderIsoBreakArea(ctx, isoProject, gridX, gridY);
  } else if (tile.type === 'stairs') {
    renderIsoStairs(ctx, isoProject, gridX, gridY);
  }

  if (tile.decor === 'focus_lamp') {
    const poleX = corners[0]!.x;
    const baseY = corners[0]!.y + 2;
    ctx.strokeStyle = '#8B7355';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(poleX, baseY);
    ctx.lineTo(poleX, baseY - ISO_WALL_H * 0.6);
    ctx.stroke();
    ctx.fillStyle = '#FFE0A0';
    ctx.beginPath();
    ctx.arc(poleX, baseY - ISO_WALL_H * 0.6, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = '#FFE0A0';
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  if (tile.decor === 'coffee_machine') {
    const mx = corners[3]!.x + 4;
    const my = corners[3]!.y - 2;
    ctx.fillStyle = '#6B5B4F';
    ctx.fillRect(mx, my, 6, 5);
    ctx.fillStyle = '#D4C0A8';
    ctx.fillRect(mx + 1, my + 1, 4, 3);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.beginPath();
    ctx.arc(mx + 3, my - 2, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawIsoWallTile(
  state: IsoTileRenderState,
  tile: LocalTile,
  gridX: number,
  gridY: number,
  world: LocalWorld,
  corners: Array<{ x: number; y: number }>,
  zone?: string,
) {
  const { ctx } = state;
  const northTile = world.grid[gridY - 1]?.[gridX];
  const westTile = world.grid[gridY]?.[gridX - 1];
  const isOpen = (t: LocalTile | undefined) =>
    t === undefined ||
    t.type === 'floor' ||
    t.type === 'path' ||
    t.type === 'aisle' ||
    t.type === 'chair' ||
    t.type === 'door' ||
    t.type === 'workbench' ||
    t.type === 'kiosk';
  const hasNorthFace = isOpen(northTile);
  const hasWestFace = isOpen(westTile);

  const isGlass = zone === 'team_cluster' || zone === 'meeting';
  const isWood = zone === 'break' || zone === 'biophilic';
  const isConcrete = zone === 'infra';

  const right = corners[1]!;
  const bottom = corners[2]!;
  const left = corners[3]!;
  const topCap = isoTileCorners(gridX, gridY, 1);

  const faceColor = isConcrete ? '#A0A8B8' : isWood ? '#C4A880' : isGlass ? 'rgba(160, 190, 210, 0.35)' : ISO_WALL_FACE;
  const sideColor = isConcrete ? '#9098A8' : isWood ? '#B49870' : isGlass ? 'rgba(140, 175, 200, 0.3)' : ISO_WALL_SIDE;

  if (hasNorthFace) {
    ctx.fillStyle = faceColor;
    ctx.beginPath();
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(bottom.x, bottom.y + ISO_WALL_H);
    ctx.lineTo(left.x, left.y + ISO_WALL_H);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(80, 80, 80, 0.15)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    const aoGrad = ctx.createLinearGradient(0, bottom.y + ISO_WALL_H - 4, 0, bottom.y + ISO_WALL_H);
    aoGrad.addColorStop(0, 'rgba(0,0,0,0)');
    aoGrad.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = aoGrad;
    ctx.fillRect(left.x, bottom.y + ISO_WALL_H - 4, bottom.x - left.x, 4);
  }

  if (hasWestFace) {
    ctx.fillStyle = sideColor;
    ctx.beginPath();
    ctx.moveTo(bottom.x, bottom.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(right.x, right.y + ISO_WALL_H);
    ctx.lineTo(bottom.x, bottom.y + ISO_WALL_H);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(80, 80, 80, 0.15)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    const aoGrad = ctx.createLinearGradient(0, bottom.y + ISO_WALL_H - 4, 0, bottom.y + ISO_WALL_H);
    aoGrad.addColorStop(0, 'rgba(0,0,0,0)');
    aoGrad.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = aoGrad;
    ctx.fillRect(bottom.x, bottom.y + ISO_WALL_H - 4, right.x - bottom.x, 4);
  }

  ctx.fillStyle = isConcrete ? '#B0B8C8' : ISO_WALL_TOP;
  ctx.beginPath();
  ctx.moveTo(topCap[0]!.x, topCap[0]!.y);
  ctx.lineTo(topCap[1]!.x, topCap[1]!.y);
  ctx.lineTo(topCap[2]!.x, topCap[2]!.y);
  ctx.lineTo(topCap[3]!.x, topCap[3]!.y);
  ctx.closePath();
  ctx.fill();

  if (zone === 'infra') {
    ctx.strokeStyle = 'rgba(30, 30, 30, 0.35)';
    ctx.lineWidth = 0.8;
    if (hasNorthFace) {
      ctx.beginPath();
      ctx.moveTo((left.x + bottom.x) / 2 - 2, bottom.y);
      ctx.lineTo((left.x + bottom.x) / 2 - 2, bottom.y + ISO_WALL_H);
      ctx.stroke();
    }
    if (hasWestFace) {
      ctx.beginPath();
      ctx.moveTo((bottom.x + right.x) / 2 + 2, bottom.y);
      ctx.lineTo((bottom.x + right.x) / 2 + 2, bottom.y + ISO_WALL_H);
      ctx.stroke();
    }
  }
  if (zone === 'biophilic') {
    ctx.fillStyle = '#6A9E6A';
    ctx.beginPath();
    ctx.arc(topCap[3]!.x + 3, topCap[3]!.y + 4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4A7E4A';
    ctx.beginPath();
    ctx.arc(topCap[3]!.x + 1, topCap[3]!.y + 6, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  if (tile.type === 'door') {
    drawIsoDoor(state, tile, corners, isGlass, hasNorthFace, hasWestFace);
  }
  if (tile.type === 'window') {
    drawIsoWindowTile(state, corners);
  }
}

function drawIsoDoor(
  state: IsoTileRenderState,
  tile: LocalTile,
  corners: Array<{ x: number; y: number }>,
  isGlass: boolean,
  hasNorthFace: boolean,
  hasWestFace: boolean,
) {
  const { ctx } = state;
  const openPct = state.doorOpenStates.get(`${tile.x},${tile.y}`) ?? 0;
  const right = corners[1]!;
  const bottom = corners[2]!;
  const left = corners[3]!;

  const frameColor = isGlass ? ISO_DOOR_GLASS : ISO_DOOR_WOOD;
  const panelColor = isGlass ? 'rgba(160, 190, 210, 0.5)' : '#A08850';
  const WH = ISO_WALL_H;

  const drawOnFace = (tl: { x: number; y: number }, tr: { x: number; y: number }) => {
    const dx = tr.x - tl.x;
    const dy = tr.y - tl.y;
    const pt = (t: number, down = 0) => ({ x: tl.x + dx * t, y: tl.y + dy * t + down });

    ctx.fillStyle = frameColor;
    for (const [t0, t1] of [[0, 0.06], [0.94, 1]] as [number, number][]) {
      const a = pt(t0), b = pt(t1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x, b.y + WH); ctx.lineTo(a.x, a.y + WH);
      ctx.closePath(); ctx.fill();
    }

    const slide = openPct * 0.42;
    ctx.fillStyle = panelColor;
    const lEnd = 0.5 - slide;
    if (lEnd > 0.06) {
      const a = pt(0.06, 2), b = pt(lEnd, 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x, b.y + WH - 4); ctx.lineTo(a.x, a.y + WH - 4);
      ctx.closePath(); ctx.fill();
    }
    const rStart = 0.5 + slide;
    if (rStart < 0.94) {
      const a = pt(rStart, 2), b = pt(0.94, 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x, b.y + WH - 4); ctx.lineTo(a.x, a.y + WH - 4);
      ctx.closePath(); ctx.fill();
    }

    ctx.fillStyle = isGlass ? '#90A8B8' : '#806840';
    const h = pt(openPct < 0.5 ? 0.44 : 0.56, WH / 2);
    ctx.beginPath(); ctx.arc(h.x, h.y, 1.5, 0, Math.PI * 2); ctx.fill();
  };

  if (hasNorthFace) drawOnFace(left, bottom);
  if (hasWestFace) drawOnFace(bottom, right);
}

function drawIsoWindowTile(
  state: IsoTileRenderState,
  corners: Array<{ x: number; y: number }>,
) {
  const { ctx } = state;
  const bottom = corners[2]!;
  const left = corners[3]!;
  const baseY = Math.min(bottom.y, left.y);

  const winGrad = ctx.createLinearGradient(bottom.x, baseY, left.x, baseY + ISO_WALL_H);
  winGrad.addColorStop(0, ISO_WINDOW_SKY[0]);
  winGrad.addColorStop(1, ISO_WINDOW_SKY[1]);
  ctx.fillStyle = winGrad;
  ctx.beginPath();
  ctx.moveTo(bottom.x - 2, baseY + 3);
  ctx.lineTo(left.x + 2, baseY + 3);
  ctx.lineTo(left.x + 2, baseY + ISO_WALL_H - 3);
  ctx.lineTo(bottom.x - 2, baseY + ISO_WALL_H - 3);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo((bottom.x + left.x) / 2, baseY + 3);
  ctx.lineTo((bottom.x + left.x) / 2, baseY + ISO_WALL_H - 3);
  ctx.moveTo(bottom.x - 2, baseY + ISO_WALL_H / 2);
  ctx.lineTo(left.x + 2, baseY + ISO_WALL_H / 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(200, 200, 200, 0.5)';
  for (let i = 0; i < 3; i++) {
    const cy = baseY + 5 + i * 6;
    ctx.fillRect(bottom.x - 7, cy, 5, 3);
    ctx.fillRect(left.x + 2, cy, 5, 3);
  }
}

function drawIsoUnit(state: IsoRenderState, unit: LocalUnit, gx: number, gy: number) {
  const { ctx } = state;
  const base = isoProject(gx, gy);
  const ux = base.px;
  const uy = base.py;

  if ((unit.state === 'idle_in_room' || unit.state === 'resting') && Math.random() < 0.02) {
    state.spawnZzz(ux, uy);
  }

  let dirAngle = 0;
  let isMoving = false;
  if (unit.path.length > 0 && unit.pathIndex < unit.path.length) {
    isMoving = true;
    const from = unit.path[unit.pathIndex]!;
    const to = unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!;
    dirAngle = Math.atan2(to.y - from.y, to.x - from.x);
  } else if (unit.state === 'working_on_file' && unit.currentWorkbenchId) {
    const wbTile = state.world.grid.flat().find((t) => t.workbench?.id === unit.currentWorkbenchId);
    if (wbTile) dirAngle = Math.atan2(wbTile.y - unit.gridY, wbTile.x - unit.gridX);
  }

  const speed = isMoving ? 3.6 * unit.effectiveSpeed : 0;
  const Sf = 1 + Math.min(0.25, speed * 0.08);
  const Sc = 1 / Sf;
  const bobbingY = isMoving ? Math.sin(unit.pathProgress * Math.PI * 2) * 3 : 0;
  const scale = ISO_TILE_W / 64;

  ctx.save();
  ctx.translate(ux, uy + bobbingY - ISO_WALL_H * 0.3);
  if (unit.ephemeral) ctx.scale(0.8, 0.8);

  const isHovered = state.hoveredUnit?.id === unit.id;
  if (isHovered) {
    ctx.strokeStyle = ISO_SELECTION;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, ISO_TILE_W * 0.3, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.save();
  ctx.rotate(dirAngle);
  ctx.scale(Sf, Sc);

  const drawPrism = (cx: number, zBase: number, zTop: number, hw: number, hd: number, color: string) =>
    renderIsoPrism(ctx, cx, zBase, zTop, hw, hd, color, scale);

  const shadowOffX = 1.5 * scale;
  const shadowOffY = 3 * scale;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
  ctx.beginPath();
  ctx.ellipse(shadowOffX, shadowOffY + 1 * scale, ISO_TILE_W * 0.22, ISO_TILE_H * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = ISO_SHADOW;
  ctx.beginPath();
  ctx.ellipse(shadowOffX, shadowOffY, ISO_TILE_W * 0.18, ISO_TILE_H * 0.15, 0, 0, Math.PI * 2);
  ctx.fill();

  const legColor = state.darkenHex(unit.color, 20);
  drawPrism(-5 * scale, 0, 8, 2.5, 2, legColor);
  drawPrism(5 * scale, 0, 8, 2.5, 2, legColor);
  drawPrism(0, 8, 18, 10, 6, unit.color);
  drawPrism(0, 18, 26, 5, 3.5, '#e8d8c8');
  drawPrism(0, 26, 28, 6, 4, ISO_HELMET);

  const now = performance.now();
  if (unit.state === 'working_on_file') {
    const flash = Math.sin(now / 150) > 0;
    ctx.fillStyle = flash ? '#22C55E' : '#14532d';
    ctx.beginPath();
    ctx.arc(6 * scale, -27 * scale, 1.2, 0, Math.PI * 2);
    ctx.arc(-6 * scale, -27 * scale, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  const initials = unit.name.slice(0, 2).toUpperCase();
  ctx.save();
  ctx.translate(0, ISO_TILE_H * 0.55);
  ctx.font = `bold 8px ${monoFont(state)}`;
  const textW = ctx.measureText(initials).width + 8;
  ctx.fillStyle = 'rgba(30, 30, 30, 0.85)';
  ctx.fillRect(-textW / 2, -6, textW, 12);
  ctx.strokeStyle = 'rgba(200, 200, 200, 0.2)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(-textW / 2, -6, textW, 12);
  ctx.fillStyle = unit.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials, 0, 0);
  ctx.restore();

  if (unit.state === 'working_on_file' && unit.workProgress > 0) {
    ctx.strokeStyle = state.tokens.success || '#22C55E';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, ISO_TILE_W * 0.28, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * unit.workProgress) / 100);
    ctx.stroke();
  }

  const statusIcon: Record<string, string> = {
    idle_in_room: '◌',
    walking_to_workbench: '→',
    walking_to_room: '→',
    working_on_file: '⚙',
    resting: '☾',
  };
  const icon = statusIcon[unit.state] ?? '?';
  ctx.fillStyle = unit.color;
  ctx.font = `${ISO_TILE_W * 0.18}px ${monoFont(state)}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(icon, 0, -ISO_TILE_H * 0.35 - 28 * scale);

  ctx.restore();

  if (state.onUnitRendered) {
    const sx = (ux - state.cam.x) * state.cam.zoom + state.cam.cx;
    const sy = (uy + bobbingY - state.cam.y) * state.cam.zoom + state.cam.cy;
    state.onUnitRendered(unit, sx, sy);
  }
}

function drawIsoRoomLabel(state: IsoRenderState, room: LocalRoom) {
  const { ctx, world } = state;
  const primary = (room.zoneLabel ?? room.folderName).toUpperCase();

  let doorBase: { px: number; py: number } | null = null;
  for (let y = room.y; y < room.y + room.height; y++) {
    for (let x = room.x; x < room.x + room.width; x++) {
      const tile = world.grid[y]?.[x];
      if (tile?.type === 'door' && tile.roomId === room.id) {
        doorBase = isoProject(x, y);
        break;
      }
    }
    if (doorBase) break;
  }

  const base = doorBase ?? isoProject(room.x + room.width / 2, room.y + room.height / 2);
  const plaqueX = base.px;
  const plaqueY = doorBase ? base.py - ISO_WALL_H * 0.6 : base.py - ISO_WALL_H - 4;

  const zoneColors: Record<string, string> = {
    team_cluster: '#F5D0C5',
    meeting: '#B09060',
    focus: '#E8F5D6',
    break: '#D0C0A0',
    infra: '#E2E8F0',
    reception: '#F5F0E8',
    biophilic: '#D4E8D0',
  };
  const plaqueColor = zoneColors[room.zoneType ?? 'team_cluster'] ?? '#F5D0C5';

  ctx.save();
  ctx.fillStyle = plaqueColor;
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 0.5;

  const plaqueW = Math.min(room.width * ISO_TILE_W, Math.max(40, primary.length * 5 + 8));
  const plaqueH = 10;
  ctx.beginPath();
  ctx.roundRect(plaqueX - plaqueW / 2, plaqueY - plaqueH, plaqueW, plaqueH, 2);
  ctx.fill();
  ctx.stroke();

  ctx.font = `bold 7px ${monoFont(state)}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#5C4033';
  ctx.fillText(primary.slice(0, 14), plaqueX, plaqueY - plaqueH / 2);
  ctx.restore();
}

function drawIsoNpc(state: IsoRenderState, npc: LocalNpc) {
  const { ctx } = state;
  const base = isoProject(npc.gridX, npc.gridY);
  const scale = ISO_TILE_W / 64;

  ctx.save();
  ctx.translate(base.px, base.py - ISO_WALL_H * 0.3);
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.arc(0, 0, ISO_TILE_W * 0.18, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
  ctx.beginPath();
  ctx.ellipse(0, 2 * scale, ISO_TILE_W * 0.12, ISO_TILE_H * 0.1, 0, 0, Math.PI * 2);
  ctx.fill();

  renderIsoPrism(ctx, 0, 0, 6, 2, 1.5, '#2d2722', scale);
  renderIsoPrism(ctx, 0, 6, 14, 7, 4, '#3a3a45', scale);
  renderIsoPrism(ctx, 0, 14, 20, 4, 2.5, '#e8d8c8', scale);
  renderIsoPrism(ctx, 6 * scale, 0, 5, 3, 1.5, '#8B7355', scale);

  ctx.restore();
}

function drawIsoHoveredTile(state: IsoRenderState, hovered: { x: number; y: number }) {
  const { ctx } = state;
  const corners = isoTileCorners(hovered.x, hovered.y);
  ctx.save();
  ctx.strokeStyle = ISO_SELECTION;
  ctx.lineWidth = 2 / state.cam.zoom;
  ctx.beginPath();
  ctx.moveTo(corners[0]!.x, corners[0]!.y);
  ctx.lineTo(corners[1]!.x, corners[1]!.y);
  ctx.lineTo(corners[2]!.x, corners[2]!.y);
  ctx.lineTo(corners[3]!.x, corners[3]!.y);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawIsoZones(state: IsoRenderState, world: LocalWorld, view: { x0: number; y0: number; x1: number; y1: number }) {
  const { ctx } = state;
  if (!world.zones) return;
  const zoneColors: Record<string, string> = {
    stockpile: '#8B5A2B',
    growing: '#4A7C2E',
    recreation: '#D4A537',
    bedroom: '#6B4F8A',
    dining: '#C46B3B',
    hospital: '#C0392B',
  };
  for (const zone of world.zones) {
    const color = zoneColors[zone.type] || '#888';
    ctx.save();
    ctx.globalAlpha = 0.2;
    for (const tile of zone.tiles) {
      if (tile.x < view.x0 || tile.x > view.x1 || tile.y < view.y0 || tile.y > view.y1) continue;
      const corners = isoTileCorners(tile.x, tile.y);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(corners[0]!.x, corners[0]!.y);
      ctx.lineTo(corners[1]!.x, corners[1]!.y);
      ctx.lineTo(corners[2]!.x, corners[2]!.y);
      ctx.lineTo(corners[3]!.x, corners[3]!.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    if (zone.tiles.length > 0) {
      const xs = zone.tiles.map((t) => t.x);
      const ys = zone.tiles.map((t) => t.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      const c1 = isoTileCorners(minX, minY);
      const c2 = isoTileCorners(maxX, maxY);
      ctx.beginPath();
      ctx.moveTo(c1[0]!.x, c1[0]!.y);
      ctx.lineTo(c1[1]!.x, c1[1]!.y);
      ctx.lineTo(c2[2]!.x, c2[2]!.y);
      ctx.lineTo(c2[3]!.x, c2[3]!.y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = `bold 9px ${monoFont(state)}`;
      ctx.textAlign = 'left';
      ctx.fillText(zone.type.toUpperCase(), c1[0]!.x, c1[0]!.y - 4);
    }
  }
}

function drawIsoZonePaintPreview(state: IsoRenderState, view: { x0: number; y0: number; x1: number; y1: number }) {
  const { ctx } = state;
  if (!state.zonePaintStart || !state.zonePaintCurrent) return;
  const x0 = Math.min(state.zonePaintStart.x, state.zonePaintCurrent.x);
  const y0 = Math.min(state.zonePaintStart.y, state.zonePaintCurrent.y);
  const x1 = Math.max(state.zonePaintStart.x, state.zonePaintCurrent.x);
  const y1 = Math.max(state.zonePaintStart.y, state.zonePaintCurrent.y);

  const zoneColors: Record<string, string> = {
    stockpile: '#8B5A2B',
    growing: '#4A7C2E',
    recreation: '#D4A537',
    bedroom: '#6B4F8A',
    dining: '#C46B3B',
    hospital: '#C0392B',
  };
  const color = zoneColors[state.zonePaintMode || 'stockpile'] || '#888';

  ctx.save();
  ctx.globalAlpha = 0.25;
  for (let y = y0; y <= y1; y++) {
    if (y < view.y0 || y > view.y1) continue;
    for (let x = x0; x <= x1; x++) {
      if (x < view.x0 || x > view.x1) continue;
      const corners = isoTileCorners(x, y);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(corners[0]!.x, corners[0]!.y);
      ctx.lineTo(corners[1]!.x, corners[1]!.y);
      ctx.lineTo(corners[2]!.x, corners[2]!.y);
      ctx.lineTo(corners[3]!.x, corners[3]!.y);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();

  const c1 = isoTileCorners(x0, y0);
  const c2 = isoTileCorners(x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.beginPath();
  ctx.moveTo(c1[0]!.x, c1[0]!.y);
  ctx.lineTo(c1[1]!.x, c1[1]!.y);
  ctx.lineTo(c2[2]!.x, c2[2]!.y);
  ctx.lineTo(c2[3]!.x, c2[3]!.y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  ctx.fillStyle = color;
  ctx.font = `bold 10px ${monoFont(state)}`;
  ctx.textAlign = 'center';
  ctx.fillText(`${w}×${h} (${w * h} tiles)`, (c1[0]!.x + c2[2]!.x) / 2, c1[0]!.y - 8);
}

function drawIsoPowerOverlay(state: IsoRenderState, world: LocalWorld, view: { x0: number; y0: number; x1: number; y1: number }) {
  const { ctx } = state;
  const pg = world.powerGrid;
  if (!pg) return;
  ctx.save();
  ctx.globalAlpha = 0.6;

  for (const key of pg.conduits) {
    const parts = key.split(',');
    if (parts.length < 2) continue;
    const sx = Number(parts[0]);
    const sy = Number(parts[1]);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
    if (sx < view.x0 || sx > view.x1 || sy < view.y0 || sy > view.y1) continue;
    const base = isoProject(sx, sy);
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(base.px, base.py - ISO_TILE_H / 2);
    ctx.lineTo(base.px, base.py + ISO_TILE_H / 2);
    ctx.moveTo(base.px - ISO_TILE_W / 2, base.py);
    ctx.lineTo(base.px + ISO_TILE_W / 2, base.py);
    ctx.stroke();
    ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
    ctx.beginPath();
    ctx.arc(base.px, base.py, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const src of pg.sources) {
    if (src.tileX < view.x0 || src.tileX > view.x1 || src.tileY < view.y0 || src.tileY > view.y1) continue;
    const base = isoProject(src.tileX, src.tileY);
    const now = performance.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 500);
    const glowR = ISO_TILE_W * 0.5 + 10 * pulse;
    const grad = ctx.createRadialGradient(base.px, base.py, 0, base.px, base.py, glowR);
    grad.addColorStop(0, `rgba(245, 158, 11, ${0.4 * pulse})`);
    grad.addColorStop(1, 'rgba(245, 158, 11, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(base.px - glowR, base.py - glowR, glowR * 2, glowR * 2);
    ctx.fillStyle = '#F59E0B';
    ctx.font = `bold 9px ${monoFont(state)}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${src.outputWatts}W`, base.px, base.py - 8);
  }

  for (const cons of pg.consumers) {
    if (cons.tileX < view.x0 || cons.tileX > view.x1 || cons.tileY < view.y0 || cons.tileY > view.y1) continue;
    const base = isoProject(cons.tileX, cons.tileY);
    const barW = ISO_TILE_W * 0.6;
    const barH = 3;
    const bx = base.px - barW / 2;
    const by = base.py + ISO_TILE_H / 2 + 4;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(bx, by, barW, barH);
    const loadPct = Math.min(1, cons.watts / 200);
    ctx.fillStyle = loadPct > 0.8 ? '#EF4444' : loadPct > 0.5 ? '#F59E0B' : '#22C55E';
    ctx.fillRect(bx, by, barW * loadPct, barH);
  }

  if (pg.generatedWatts > 0 || pg.consumedWatts > 0) {
    const statsBase = isoProject(view.x0, view.y0);
    ctx.fillStyle = 'rgba(13, 13, 20, 0.9)';
    ctx.fillRect(statsBase.px - 5, statsBase.py - ISO_WALL_H - 55, 160, 50);
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
    ctx.strokeRect(statsBase.px - 5, statsBase.py - ISO_WALL_H - 55, 160, 50);
    ctx.fillStyle = '#22C55E';
    ctx.font = `11px ${monoFont(state)}`;
    ctx.textAlign = 'left';
    ctx.fillText(`⚡ Gen: ${pg.generatedWatts}W`, statsBase.px, statsBase.py - ISO_WALL_H - 40);
    ctx.fillStyle = '#EF4444';
    ctx.fillText(`🔌 Con: ${pg.consumedWatts}W`, statsBase.px, statsBase.py - ISO_WALL_H - 24);
    ctx.fillStyle = pg.storedWatts > 0 ? '#3B82F6' : '#6B7280';
    ctx.fillText(`🔋 Bat: ${pg.storedWatts}W`, statsBase.px, statsBase.py - ISO_WALL_H - 8);
  }

  ctx.restore();
}

function drawIsoWindowLightRays(state: IsoRenderState, world: LocalWorld, view: { x0: number; y0: number; x1: number; y1: number }) {
  const { ctx } = state;
  for (let y = view.y0; y <= view.y1; y++) {
    for (let x = view.x0; x <= view.x1; x++) {
      const tile = world.grid[y]?.[x];
      if (!tile || tile.type !== 'window') continue;

      const dirs = [
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
      ];
      for (const { dx, dy } of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < view.x0 || nx > view.x1 || ny < view.y0 || ny > view.y1) continue;
        const neighbor = world.grid[ny]?.[nx];
        if (!neighbor) continue;
        if (neighbor.type === 'floor' || neighbor.type === 'path') {
          const base = isoProject(nx, ny);
          const rayGrad = ctx.createRadialGradient(
            base.px - dx * ISO_TILE_W * 0.15,
            base.py - dy * ISO_TILE_H * 0.15,
            0,
            base.px,
            base.py,
            ISO_TILE_W * 0.6,
          );
          rayGrad.addColorStop(0, 'rgba(255, 255, 255, 0.2)');
          rayGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx.fillStyle = rayGrad;
          const corners = isoTileCorners(nx, ny);
          ctx.beginPath();
          ctx.moveTo(corners[0]!.x, corners[0]!.y);
          ctx.lineTo(corners[1]!.x, corners[1]!.y);
          ctx.lineTo(corners[2]!.x, corners[2]!.y);
          ctx.lineTo(corners[3]!.x, corners[3]!.y);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
  }
}

function drawIsoTemperatureOverlay(state: IsoRenderState, world: LocalWorld, view: { x0: number; y0: number; x1: number; y1: number }) {
  const { ctx } = state;
  const climates = world.roomClimates;
  if (!climates) return;
  ctx.save();
  ctx.globalAlpha = 0.5;

  function tempToColor(temp: number): string {
    const comfortMin = 16, comfortMax = 26;
    if (temp <= comfortMin) return `rgb(80, ${Math.round(100 + (temp + 20) / (comfortMin + 20) * 155)}, 220)`;
    if (temp >= comfortMax) return `rgb(220, ${Math.round(255 * (1 - Math.min(1, (temp - comfortMax) / (50 - comfortMax))))}, 0)`;
    const t = (temp - comfortMin) / (comfortMax - comfortMin);
    return `rgb(${Math.round(200 * (1 - t))}, 255, ${Math.round(200 * (1 - t))}`;
  }

  for (const [roomId, climate] of climates) {
    const room = world.rooms.find((r) => r.id === roomId);
    if (!room) continue;
    const cx = room.x + room.width / 2;
    const cy = room.y + room.height / 2;
    const base = isoProject(cx, cy);
    if (cx < view.x0 || cx > view.x1 || cy < view.y0 || cy > view.y1) continue;

    const color = tempToColor(climate.temperature);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(base.px, base.py, Math.max(room.width, room.height) * ISO_TILE_W * 0.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = `bold 12px ${monoFont(state)}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${climate.temperature.toFixed(1)}°C`, base.px, base.py);

    if (Math.abs(climate.temperature - climate.targetTemperature) > 0.5) {
      ctx.fillStyle = '#FBBF24';
      ctx.font = `9px ${monoFont(state)}`;
      const arrow = climate.temperature < climate.targetTemperature ? '▲' : '▼';
      ctx.fillText(`${arrow} ${climate.targetTemperature.toFixed(1)}°C`, base.px, base.py + 18);
    }

    if (climate.temperature < 10 && Math.random() < 0.02) {
      const rx = room.x + Math.random() * room.width;
      const ry = room.y + Math.random() * room.height;
      const p = isoProject(rx, ry);
      state.spawnBreath(p.px, p.py);
    }
  }

  for (const [roomId, climate] of climates) {
    const room = world.rooms.find((r) => r.id === roomId);
    if (!room) continue;
    for (const heater of climate.heaters) {
      if (heater.tileX < view.x0 || heater.tileX > view.x1 || heater.tileY < view.y0 || heater.tileY > view.y1) continue;
      const base = isoProject(heater.tileX, heater.tileY);
      const now = performance.now();
      ctx.strokeStyle = `rgba(239, 83, 80, ${0.4 + 0.3 * Math.sin(now / 120)})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(base.px - 6 + i * 6, base.py + ISO_TILE_H / 2);
        ctx.quadraticCurveTo(base.px + 4 * Math.sin(now / 100 + i), base.py + ISO_TILE_H / 2 - 8, base.px - 6 + i * 6, base.py + ISO_TILE_H / 2 - 16);
        ctx.stroke();
      }
    }
    for (const cooler of climate.coolers) {
      if (cooler.tileX < view.x0 || cooler.tileX > view.x1 || cooler.tileY < view.y0 || cooler.tileY > view.y1) continue;
      const base = isoProject(cooler.tileX, cooler.tileY);
      const now = performance.now();
      ctx.fillStyle = `rgba(100, 181, 246, ${0.4 + 0.3 * Math.sin(now / 150)})`;
      for (let i = 0; i < 4; i++) {
        const px2 = base.px + (i - 1.5) * 4;
        const py2 = base.py + ISO_TILE_H / 2 - 3 - (now / 80 + i * 0.5) % 10;
        ctx.beginPath();
        ctx.arc(px2, py2, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const vent of climate.vents) {
      if (!vent.open) continue;
      if (vent.tileX < view.x0 || vent.tileX > view.x1 || vent.tileY < view.y0 || vent.tileY > view.y1) continue;
      const base = isoProject(vent.tileX, vent.tileY);
      ctx.fillStyle = `rgba(144, 164, 174, ${0.6 + 0.3 * Math.sin(performance.now() / 200)})`;
      ctx.font = `${ISO_TILE_W * 0.18}px ${monoFont(state)}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('↔', base.px, base.py);
    }
  }

  ctx.restore();
}

function drawIsoDebugOverlay(state: IsoRenderState, world: LocalWorld, localUnits: LocalUnit[]) {
  const { ctx } = state;
  for (const unit of localUnits) {
    if (unit.path.length === 0 || unit.pathIndex >= unit.path.length) continue;
    const remaining = unit.path.slice(unit.pathIndex);
    if (remaining.length < 2) continue;

    ctx.strokeStyle = unit.color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    const start = isoProject(remaining[0]!.x, remaining[0]!.y);
    ctx.moveTo(start.px, start.py);
    for (let i = 1; i < remaining.length; i++) {
      const p = isoProject(remaining[i]!.x, remaining[i]!.y);
      ctx.lineTo(p.px, p.py);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = unit.color;
    for (const wp of remaining) {
      const p = isoProject(wp.x, wp.y);
      ctx.beginPath();
      ctx.arc(p.px, p.py, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const unit of localUnits) {
    const base = isoProject(unit.gridX, unit.gridY);
    const lines: string[] = [
      `${unit.name}`,
      `st: ${unit.state}`,
      `pos: ${unit.gridX},${unit.gridY}`,
      `fat: ${Math.round(unit.fatigue)}`,
      `spd: ${unit.effectiveSpeed.toFixed(1)}`,
    ];
    if (unit.mission) lines.push(`mission: ${unit.mission.slice(0, 12)}`);
    if (unit.currentWorkbenchId) lines.push(`wb: ${unit.currentWorkbenchId.slice(0, 8)}`);

    const lineH = 9;
    const cardW = 72;
    const cardH = lines.length * lineH + 4;
    const cx = base.px - cardW / 2;
    const cy = base.py - ISO_WALL_H - 34 - cardH;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.beginPath();
    ctx.roundRect(cx, cy, cardW, cardH, 2);
    ctx.fill();
    ctx.strokeStyle = unit.color;
    ctx.lineWidth = 0.5;
    ctx.stroke();

    ctx.fillStyle = '#E2E8F0';
    ctx.font = `bold 7px ${monoFont(state)}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i]!, cx + 3, cy + 2 + i * lineH);
    }
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(8, 8, 90, 40);
  ctx.strokeStyle = '#606060';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(8, 8, 90, 40);

  ctx.fillStyle = '#E2E8F0';
  ctx.font = `bold 10px ${monoFont(state)}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`FPS: ${state.fpsValue}`, 14, 14);
  ctx.fillText(`Ticks: ${world.rooms.reduce((n, r) => n + r.workbenches.length, 0)}`, 14, 26);
  ctx.fillText(`Units: ${localUnits.length}`, 14, 38);
  ctx.restore();
}

/** Phase E: compact cluster of file-type pills for high-density rooms (isometric). */
function drawIsoWorkbenchCluster(
  state: IsoRenderState,
  room: LocalRoom,
  extensions: string[],
): void {
  const { ctx } = state;
  // Anchor at the room's north corner (top in iso) so the summary panel
  // floats over the back walls instead of covering the desk grid.
  const base = officeIsoProject(room.x + 1, room.y + 1);

  // Deduplicate and count extensions, sorted by count desc
  const counts = new Map<string, number>();
  for (const ext of extensions) {
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  const unique = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  // Cap at top 8 most common
  const shown = unique.slice(0, 8);

  // Layout: pills in a grid, max 4 per row
  const cols = Math.min(shown.length, 4);
  const rows = Math.ceil(shown.length / cols);
  const pillW = 28;
  const pillH = 11;
  const gap = 2;
  const totalW = cols * (pillW + gap) - gap;
  const totalH = rows * (pillH + gap) - gap;
  const startX = base.px - totalW / 2;
  // Position above the room floor, visible over walls
  const startY = base.py - ISO_WALL_H - 10 - totalH;

  // Total count badge
  const totalFiles = extensions.length;

  // Background panel with total
  ctx.save();
  ctx.fillStyle = 'rgba(18, 20, 26, 0.92)';
  ctx.beginPath();
  ctx.roundRect(startX - 6, startY - 14, totalW + 12, totalH + 28, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 200, 200, 0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Title: total file count
  ctx.fillStyle = '#CCCCCC';
  ctx.font = `bold 7px ${monoFont(state)}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`${totalFiles} files`, base.px, startY - 10);

  // Draw pills
  ctx.font = `bold 7px ${monoFont(state)}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < shown.length; i++) {
    const [ext, count] = shown[i]!;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const px = startX + col * (pillW + gap);
    const py = startY + row * (pillH + gap);
    const color = state.extColor[ext] ?? '#888';

    ctx.fillStyle = color + '22';
    ctx.beginPath();
    ctx.roundRect(px, py, pillW, pillH, 3);
    ctx.fill();

    ctx.fillStyle = color;
    const label = `${ext.toUpperCase().slice(0, 3)} ×${count}`;
    ctx.fillText(label, px + pillW / 2, py + pillH / 2);
  }
  ctx.restore();
}
