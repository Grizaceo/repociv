import type { LocalNpc, LocalRoom, LocalTile, LocalUnit, LocalWorld, ZoneType } from './types.ts';
import {
  drawIsoOfficeSprite,
  type IsoOfficeDrawContext,
  ISO_TILE_W,
  ISO_TILE_H,
  ISO_WALL_H,
  isoProject as officeIsoProject,
} from './isoOfficeSprites.ts';
import {
  drawIsoBreakArea as renderIsoBreakArea,
  drawIsoMeetingTable as renderIsoMeetingTable,
  drawIsoPhoneBooth as renderIsoPhoneBooth,
  drawIsoPrism as renderIsoPrism,
  drawIsoServerRack as renderIsoServerRack,
  drawIsoSofa as renderIsoSofa,
  drawIsoStairs as renderIsoStairs,
} from './isoOfficeRenderer.ts';
import { isoTileCorners } from './isoGeometry.ts';
import { drawIsoZones, drawIsoZonePaintPreview } from './isoLocalZones.ts';
import { monoFont } from './isoRenderStyle.ts';
import { drawIsoPowerOverlay } from './isoPowerOverlay.ts';
import { drawIsoTemperatureOverlay } from './isoTemperatureOverlay.ts';
import { drawIsoDebugOverlay } from './isoDebugOverlay.ts';
export { isoUnproject } from './isoGeometry.ts';

import { worldToScreen } from './hex.ts';
import { activityGlyphFor, ACTIVITY_TTL_MS } from './localActivity.ts';

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
  // Ground with no room on it. At #A8A8A8 it painted a light-grey slab over
  // every part of the grid the office does not use, which on the dark sector
  // ground reads as a hole in the floor rather than as unbuilt space. Keep it
  // just above the backdrop so the tile grid still reads, and no brighter.
  outside: '#232830',
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
      if (
        tile.type === 'floor' ||
        tile.type === 'path' ||
        tile.type === 'wall' ||
        tile.type === 'vent' // drawn as wall in the static layer
      )
        continue;
      const z =
        tile.type === 'door' || tile.type === 'window' ? 2 : tile.type === 'workbench' ? 1 : 0;
      tiles.push({ x, y, tile, z });
    }
  }
  tiles.sort((a, b) => {
    const d = a.x + a.y - (b.x + b.y);
    return d !== 0 ? d : a.z - b.z;
  });

  const activeWbIds = new Set(
    localUnits
      .filter((u) => u.state === 'working_on_file' && u.currentWorkbenchId)
      .map((u) => u.currentWorkbenchId),
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
    .filter(
      (n) => n.gridX >= view.x0 && n.gridX <= view.x1 && n.gridY >= view.y0 && n.gridY <= view.y1,
    )
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

  // P2: Workbench labels — auto-visible when zoomed in, respect manual toggle
  if (!lodLow) {
    const cam = state.cam;
    // Auto-show labels when zoom >= 0.7, or when overlay is manually toggled on
    const labelAlpha = state.workbenchLabelOverlay
      ? 1
      : Math.max(0, Math.min(1, (cam.zoom - 0.5) / 0.3)); // fade 0.5→0.8
    if (labelAlpha > 0.02) {
      for (let y = view.y0; y <= view.y1; y++) {
        for (let x = view.x0; x <= view.x1; x++) {
          const tile = world.grid[y]?.[x];
          if (tile?.type !== 'workbench' || !tile.workbench) continue;
          // Skip high-density rooms (cluster pills handle those)
          const room = tile.roomId ? world.rooms.find((r) => r.id === tile.roomId) : undefined;
          if (room && room.workbenches.length >= 3) continue;

          const base = isoProject(x, y);
          const name = tile.workbench.fileName;
          const short = name.length > 10 ? name.slice(0, 8) + '..' : name;
          ctx.font = `bold 5px ${monoFont(state)}`;
          const textW = ctx.measureText(short).width + 6;
          const labelW = Math.max(24, textW);
          const labelH = 8;
          // Y offset scales with zoom to avoid overlapping agent sprites
          const yOffset = ISO_WALL_H + 6 + (cam.zoom > 1.2 ? 4 : 0);
          const lx = base.px - labelW / 2;
          const ly = base.py - yOffset;

          ctx.save();
          ctx.globalAlpha = labelAlpha;
          ctx.fillStyle = 'rgba(20, 20, 30, 0.8)';
          ctx.beginPath();
          ctx.roundRect(lx, ly, labelW, labelH, 2);
          ctx.fill();
          // Extension color dot
          const extCol = extColorFor(tile.workbench.extension);
          ctx.fillStyle = extCol;
          ctx.beginPath();
          ctx.arc(lx + 4, ly + labelH / 2, 1.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#E2E8F0';
          ctx.font = `bold 5px ${monoFont(state)}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(short, base.px + 2, ly + labelH / 2);
          ctx.restore();
        }
      }
    }
  }

  // P2: Hover tooltip for workbench — full path, ext dot, test badge
  if (state.hoveredTile) {
    const ht = world.grid[state.hoveredTile.y]?.[state.hoveredTile.x];
    if (ht?.type === 'workbench' && ht.workbench) {
      drawIsoWorkbenchTooltip(state, ht.workbench);
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
  if (!tile.roomId && tile.type !== 'path' && tile.type !== 'aisle')
    floorColor = ISO_FLOOR.outside || '#232830';

  ctx.fillStyle = floorColor;
  ctx.beginPath();
  ctx.moveTo(corners[0]!.x, corners[0]!.y);
  ctx.lineTo(corners[1]!.x, corners[1]!.y);
  ctx.lineTo(corners[2]!.x, corners[2]!.y);
  ctx.lineTo(corners[3]!.x, corners[3]!.y);
  ctx.closePath();
  ctx.fill();

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
    const doorNeighbors = [north, south, east, west].filter(
      (n): n is LocalTile => n?.type === 'door',
    );
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

  if (
    tile.type === 'wall' ||
    tile.type === 'door' ||
    tile.type === 'window' ||
    tile.type === 'vent'
  ) {
    // Vents replace wall tiles (placeTemperatureSystem); without the wall
    // prism they punch visible gaps into every shared wall.
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

  const faceColor = isConcrete
    ? '#A0A8B8'
    : isWood
      ? '#C4A880'
      : isGlass
        ? 'rgba(160, 190, 210, 0.35)'
        : ISO_WALL_FACE;
  const sideColor = isConcrete
    ? '#9098A8'
    : isWood
      ? '#B49870'
      : isGlass
        ? 'rgba(140, 175, 200, 0.3)'
        : ISO_WALL_SIDE;

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
    for (const [t0, t1] of [
      [0, 0.06],
      [0.94, 1],
    ] as [number, number][]) {
      const a = pt(t0),
        b = pt(t1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x, b.y + WH);
      ctx.lineTo(a.x, a.y + WH);
      ctx.closePath();
      ctx.fill();
    }

    const slide = openPct * 0.42;
    ctx.fillStyle = panelColor;
    const lEnd = 0.5 - slide;
    if (lEnd > 0.06) {
      const a = pt(0.06, 2),
        b = pt(lEnd, 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x, b.y + WH - 4);
      ctx.lineTo(a.x, a.y + WH - 4);
      ctx.closePath();
      ctx.fill();
    }
    const rStart = 0.5 + slide;
    if (rStart < 0.94) {
      const a = pt(rStart, 2),
        b = pt(0.94, 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x, b.y + WH - 4);
      ctx.lineTo(a.x, a.y + WH - 4);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = isGlass ? '#90A8B8' : '#806840';
    const h = pt(openPct < 0.5 ? 0.44 : 0.56, WH / 2);
    ctx.beginPath();
    ctx.arc(h.x, h.y, 1.5, 0, Math.PI * 2);
    ctx.fill();
  };

  if (hasNorthFace) drawOnFace(left, bottom);
  if (hasWestFace) drawOnFace(bottom, right);
}

function drawIsoWindowTile(state: IsoTileRenderState, corners: Array<{ x: number; y: number }>) {
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

/** True when the unit is mid-walk along its current path. */
export function isUnitMoving(unit: LocalUnit): boolean {
  return unit.path.length > 0 && unit.pathIndex < unit.path.length;
}

/**
 * Returns the angle (radians) used to rotate the unit's body in drawIsoUnit.
 *
 * Behavior:
 *   - If the unit is mid-walk, return the direction of the current step
 *     (atan2 of the delta from `path[pathIndex]` to the next waypoint).
 *   - If the unit is stationary (working, idle, resting, etc.), return 0.
 *
 * Why 0 for stationary: the iso unit sprite is a 3D-looking prism stack
 * (legs, torso, head, helmet) and rotating the whole body by 90° makes it
 * look like it is lying down, not "facing" the desk. For an iso sprite
 * the facing direction is implicit from the unit's position relative to
 * the workbench (it sits in the chair, in front of the desk). We only
 * rotate the body during walking, where the lean reads as "leaning into
 * the step".
 */
export function computeUnitDirAngle(unit: LocalUnit): number {
  if (!isUnitMoving(unit)) return 0;
  const from = unit.path[unit.pathIndex]!;
  const to = unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!;
  return Math.atan2(to.y - from.y, to.x - from.x);
}

// Exported for the activity-pulse test: everything else in this module is
// reached through renderIso, but the glyph draw is worth pinning at the canvas
// level, since a pure-logic test cannot tell "the event arrived" from "the
// pixel showed up".
export function drawIsoUnit(state: IsoRenderState, unit: LocalUnit, gx: number, gy: number) {
  const { ctx } = state;
  const base = isoProject(gx, gy);
  const ux = base.px;
  const uy = base.py;

  if ((unit.state === 'idle_in_room' || unit.state === 'resting') && Math.random() < 0.02) {
    state.spawnZzz(ux, uy);
  }

  const isMoving = isUnitMoving(unit);
  const dirAngle = computeUnitDirAngle(unit);

  const speed = isMoving ? 3.6 * unit.effectiveSpeed : 0;
  const Sf = 1 + Math.min(0.25, speed * 0.08);
  const Sc = 1 / Sf;
  // Per-step bounce: smooth ease-in-out per tile transition (P1)
  const bobbingY = isMoving ? Math.sin(unit.pathProgress * Math.PI) * 3 : 0;

  // Idle breathing: subtle scale oscillation 0.98→1.02 over 2s cycle (P1)
  let breatheScale = 1;
  if (!isMoving && (unit.state === 'idle_in_room' || unit.state === 'resting')) {
    const now2 = performance.now();
    breatheScale = 1 + Math.sin((now2 / 1000) * Math.PI) * 0.02;
  }

  // Despawn fade-out alpha (P1)
  const fadeAlpha = unit.despawning ? Math.max(0, unit.fadeAlpha ?? 1) : 1;
  if (fadeAlpha <= 0) return;

  const scale = ISO_TILE_W / 64;

  ctx.save();
  ctx.globalAlpha = fadeAlpha;
  ctx.translate(ux, uy + bobbingY - ISO_WALL_H * 0.3);
  if (unit.ephemeral) ctx.scale(0.8, 0.8);
  ctx.scale(breatheScale, breatheScale);

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

  const drawPrism = (
    cx: number,
    zBase: number,
    zTop: number,
    hw: number,
    hd: number,
    color: string,
  ) => renderIsoPrism(ctx, cx, zBase, zTop, hw, hd, color, scale);

  const shadowOffX = 1.5 * scale;
  const shadowOffY = 3 * scale;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
  ctx.beginPath();
  ctx.ellipse(
    shadowOffX,
    shadowOffY + 1 * scale,
    ISO_TILE_W * 0.22,
    ISO_TILE_H * 0.18,
    0,
    0,
    Math.PI * 2,
  );
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
    ctx.arc(
      0,
      0,
      ISO_TILE_W * 0.28,
      -Math.PI / 2,
      -Math.PI / 2 + (Math.PI * 2 * unit.workProgress) / 100,
    );
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

  // ─── Local view activity pulse ────────────────────────────────────────────
  // A unit parked at a workbench looks idle, but the agent behind it is mid
  // tool call. Flash a glyph above the status icon, faded by the TTL it has
  // left, so a burst of calls reads as one pulse dimming out instead of a
  // blinking lamp. The glyph itself is decided in localActivity.ts.
  if (unit.activity) {
    const age = Date.now() - unit.activity.at;
    if (age < ACTIVITY_TTL_MS) {
      const { glyph, color } = activityGlyphFor(unit.activity.toolName);
      const remaining = 1 - age / ACTIVITY_TTL_MS;
      ctx.save();
      ctx.globalAlpha = fadeAlpha * (0.35 + 0.65 * remaining);
      ctx.fillStyle = color;
      ctx.font = `${ISO_TILE_W * 0.26}px ${monoFont(state)}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(glyph, 0, -ISO_TILE_H * 0.35 - 48 * scale);
      ctx.restore();
    }
  }

  ctx.restore();

  if (state.onUnitRendered) {
    const { sx, sy } = worldToScreen(state.cam, ux, uy + bobbingY);
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

function drawIsoWindowLightRays(
  state: IsoRenderState,
  world: LocalWorld,
  view: { x0: number; y0: number; x1: number; y1: number },
) {
  const { ctx } = state;
  const now = performance.now();
  const shimmer = 0.85 + 0.15 * Math.sin(now / 3000); // slow 3s shimmer
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
          // P3: softer, longer rays with shimmer
          const rayGrad = ctx.createRadialGradient(
            base.px - dx * ISO_TILE_W * 0.2,
            base.py - dy * ISO_TILE_H * 0.2,
            0,
            base.px,
            base.py,
            ISO_TILE_W * 0.8, // wider radius for softer falloff
          );
          rayGrad.addColorStop(0, `rgba(255, 250, 235, ${0.22 * shimmer})`);
          rayGrad.addColorStop(0.5, `rgba(255, 245, 230, ${0.08 * shimmer})`);
          rayGrad.addColorStop(1, 'rgba(255, 245, 230, 0)');
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

// ─── P2: Workbench label helpers ──────────────────────────────────────────────

function extColorFor(ext: string, state?: IsoRenderState): string {
  if (state?.extColor && state.extColor[ext]) return state.extColor[ext]!;
  // Fallback common colors
  const fallbacks: Record<string, string> = {
    ts: '#4a9bd4',
    tsx: '#4a9bd4',
    js: '#e8c44a',
    py: '#4a9',
    json: '#e8a44a',
    md: '#8ab4f8',
    css: '#a855f7',
    html: '#e87a4a',
    sh: '#22c55e',
  };
  return fallbacks[ext] ?? '#888';
}

function drawIsoWorkbenchTooltip(state: IsoRenderState, wb: import('./types.ts').Workbench): void {
  const { ctx, cam } = state;
  const ht = state.hoveredTile!;
  const base = isoProject(ht.x, ht.y);

  // Screen position for tooltip (untransformed — drawn after ctx.restore)
  // We're still inside the camera transform, so convert to screen coords
  const { sx, sy } = worldToScreen(cam, base.px, base.py);

  // Tooltip dimensions
  const padX = 8;
  const padY = 6;
  const lineHeight = 11;
  const extCol = extColorFor(wb.extension, state);

  // Build tooltip text
  const fileName = wb.fileName;
  const extLabel = wb.extension.toUpperCase();
  const testBadge = wb.isTest ? ' [TEST]' : '';
  const pathShort = wb.filePath.length > 40 ? '...' + wb.filePath.slice(-37) : wb.filePath;

  const titleLine = `${fileName}${testBadge}`;
  const pathLine = pathShort;
  const extLine = `Type: ${extLabel}`;

  ctx.save();
  // Reset transform to draw in screen space
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `bold 10px ${monoFont(state)}`;
  const titleW = ctx.measureText(titleLine).width;
  ctx.font = `8px ${monoFont(state)}`;
  const pathW = ctx.measureText(pathLine).width;
  const extW = ctx.measureText(extLine).width;
  const maxW = Math.max(titleW, pathW, extW);
  const tooltipW = maxW + padX * 2;
  const tooltipH = lineHeight * 3 + padY * 2;

  // Position: above the hovered tile, clamped to screen
  let tx = sx - tooltipW / 2;
  let ty = sy - tooltipH - 12;
  tx = Math.max(4, Math.min(tx, ctx.canvas.width - tooltipW - 4));
  if (ty < 4) ty = sy + 12; // flip below if no room above

  // Background
  ctx.fillStyle = 'rgba(15, 15, 22, 0.95)';
  ctx.beginPath();
  ctx.roundRect(tx, ty, tooltipW, tooltipH, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 200, 200, 0.2)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Title line (with ext color dot)
  ctx.fillStyle = extCol;
  ctx.beginPath();
  ctx.arc(tx + padX + 2, ty + padY + 6, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = `bold 10px ${monoFont(state)}`;
  ctx.fillStyle = '#F0F0F0';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(titleLine, tx + padX + 10, ty + padY + 6);

  // Path line
  ctx.font = `8px ${monoFont(state)}`;
  ctx.fillStyle = '#A0A0A0';
  ctx.fillText(pathLine, tx + padX, ty + padY + 6 + lineHeight);

  // Ext line
  ctx.fillStyle = extCol;
  ctx.fillText(extLine, tx + padX, ty + padY + 6 + lineHeight * 2);

  ctx.restore();
}
