import type { LocalRoom, LocalTile, LocalWorld } from './types.ts';
import {
  drawIsoCarpetTile,
  drawIsoCeilingLight,
  drawIsoDoorSignage,
  drawIsoExteriorFacade,
  type IsoOfficeDrawContext,
} from './isoOfficeSprites.ts';

export interface StaticLayerBuildResult {
  canvas: HTMLCanvasElement;
}

export interface IsoStaticLayerBuildResult {
  canvas: HTMLCanvasElement;
  offsetX: number;
  offsetY: number;
}

export function buildStaticLayer(
  world: LocalWorld,
  tileSize: number,
  drawTile: (ctx: CanvasRenderingContext2D, tile: LocalTile) => void,
): StaticLayerBuildResult {
  const canvas = document.createElement('canvas');
  canvas.width = world.width * tileSize;
  canvas.height = world.height * tileSize;
  const ctx = canvas.getContext('2d')!;

  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const tile = world.grid[y]![x]!;
      if (tile.type === 'door') {
        drawTile(ctx, { ...tile, type: 'floor' });
      } else {
        drawTile(ctx, tile);
      }
    }
  }

  return { canvas };
}

interface IsoStaticLayerOptions {
  world: LocalWorld;
  isoTileW: number;
  isoTileH: number;
  isoWallH: number;
  fontMono: string;
  extColor: Record<string, string>;
  zoneLight: Record<string, string>;
  isoProject: (x: number, y: number, z?: number) => { px: number; py: number };
  drawIsoTile: (
    ctx: CanvasRenderingContext2D,
    tile: LocalTile,
    x: number,
    y: number,
    world: LocalWorld,
  ) => void;
}

function isDynamicIsoFurniture(tile: LocalTile): boolean {
  return (
    tile.type === 'workbench' ||
    tile.type === 'standing_desk' ||
    tile.type === 'chair' ||
    tile.type === 'cubicle_partition' ||
    tile.type === 'sofa' ||
    tile.type === 'planter' ||
    tile.type === 'server_rack' ||
    tile.type === 'whiteboard' ||
    tile.type === 'reception' ||
    tile.type === 'window' ||
    tile.type === 'meeting_room' ||
    tile.type === 'phone_booth' ||
    tile.type === 'break_area' ||
    tile.type === 'watercooler' ||
    tile.type === 'stairs'
  );
}

function hasCorridorNeighbor(world: LocalWorld, x: number, y: number): boolean {
  return [
    world.grid[y - 1]?.[x],
    world.grid[y + 1]?.[x],
    world.grid[y]?.[x - 1],
    world.grid[y]?.[x + 1],
  ].some((n) => n?.type === 'path' || n?.type === 'aisle');
}

function buildRoomIndex(rooms: LocalRoom[]): Map<string, LocalRoom> {
  return new Map(rooms.map((room) => [room.id, room]));
}

export function buildIsoStaticLayer(options: IsoStaticLayerOptions): IsoStaticLayerBuildResult {
  const {
    world,
    isoTileW,
    isoTileH,
    isoWallH,
    fontMono,
    extColor,
    zoneLight,
    isoProject,
    drawIsoTile,
  } = options;

  const c0 = isoProject(0, 0);
  const c1 = isoProject(world.width, 0);
  const c2 = isoProject(0, world.height);
  const c3 = isoProject(world.width, world.height);
  const minPx = Math.min(c0.px, c1.px, c2.px, c3.px) - isoTileW;
  const maxPx = Math.max(c0.px, c1.px, c2.px, c3.px) + isoTileW;
  const minPy = Math.min(c0.py, c1.py, c2.py, c3.py) - isoWallH - isoTileH;
  const maxPy = Math.max(c0.py, c1.py, c2.py, c3.py) + isoTileH;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(maxPx - minPx);
  canvas.height = Math.ceil(maxPy - minPy);
  const ctx = canvas.getContext('2d')!;
  ctx.save();
  ctx.translate(-minPx, -minPy);

  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const tile = world.grid[y]![x]!;
      if (tile.type === 'door' || isDynamicIsoFurniture(tile)) {
        drawIsoTile(ctx, { ...tile, type: 'floor' }, x, y, world);
      } else {
        drawIsoTile(ctx, tile, x, y, world);
      }
    }
  }

  const officeDctx: IsoOfficeDrawContext = {
    ctx,
    fontMono,
    extColor,
  };

  for (const room of world.rooms) {
    const lightColor = zoneLight[room.zoneType ?? 'team_cluster'];
    if (!lightColor) continue;
    const cx = room.x + room.width / 2;
    const cy = room.y + room.height / 2;
    const base = isoProject(cx, cy);
    const radius = Math.max(room.width, room.height) * isoTileW * 0.55;
    const grad = ctx.createRadialGradient(base.px, base.py, 0, base.px, base.py, radius);
    grad.addColorStop(0, lightColor);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(base.px, base.py, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  const roomIndex = buildRoomIndex(world.rooms);
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const tile = world.grid[y]![x]!;
      if (tile.type === 'aisle' || tile.type === 'path') {
        drawIsoCarpetTile(officeDctx, x, y);
      }
      if ((x + y) % 5 === 0 && (tile.type === 'aisle' || tile.type === 'path')) {
        drawIsoCeilingLight(officeDctx, x, y);
      }
      if (tile.type === 'wall') {
        drawIsoExteriorFacade(officeDctx, x, y, world.width, world.height);
      }
      if (tile.type === 'door' && tile.roomId) {
        const room = roomIndex.get(tile.roomId);
        if (room?.zoneLabel && hasCorridorNeighbor(world, x, y)) {
          drawIsoDoorSignage(officeDctx, x, y, room.zoneLabel);
        }
      }
    }
  }

  ctx.restore();
  return {
    canvas,
    offsetX: minPx,
    offsetY: minPy,
  };
}
