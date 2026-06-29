// ─── Camera/zoom/pan, screen↔world conversion ───────────────────────────────
import type { LocalWorld } from '../types.ts';
import { screenToWorld, clampZoom } from '../hex.ts';
import { isoProject, isoUnproject } from '../isoLocalRenderer.ts';
import type { CameraState, CamAnim } from './state.ts';

const TILE_SIZE = 32;

export function calcLod(zoom: number): 'low' | 'medium' | 'high' {
  if (zoom < 0.4) return 'low';
  if (zoom < 1.0) return 'medium';
  return 'high';
}

export function screenToTile(
  cam: CameraState,
  isometric: boolean,
  sx: number,
  sy: number,
): { x: number; y: number } | null {
  const { wx, wy } = screenToWorld(cam, sx, sy);
  if (isometric) {
    const iso = isoUnproject(wx, wy);
    return { x: Math.floor(iso.x), y: Math.floor(iso.y) };
  }
  const x = Math.floor(wx / TILE_SIZE);
  const y = Math.floor(wy / TILE_SIZE);
  return { x, y };
}

export function getTile(world: LocalWorld | null, x: number, y: number) {
  if (!world) return null;
  if (y < 0 || y >= world.height || x < 0 || x >= world.width) return null;
  return world.grid[y]![x] ?? null;
}

export function visibleTileRect(
  cam: CameraState,
  isometric: boolean,
  canvasW: number,
  canvasH: number,
  world: LocalWorld,
): { x0: number; y0: number; x1: number; y1: number } {
  if (isometric) {
    const tl = screenToWorld(cam, 0, 0);
    const tr = screenToWorld(cam, canvasW, 0);
    const bl = screenToWorld(cam, 0, canvasH);
    const br = screenToWorld(cam, canvasW, canvasH);
    const corners = [
      isoUnproject(tl.wx, tl.wy),
      isoUnproject(tr.wx, tr.wy),
      isoUnproject(bl.wx, bl.wy),
      isoUnproject(br.wx, br.wy),
    ];
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const c of corners) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    }
    const margin = 3;
    return {
      x0: Math.max(0, Math.floor(minX) - margin),
      y0: Math.max(0, Math.floor(minY) - margin),
      x1: Math.min(world.width - 1, Math.ceil(maxX) + margin),
      y1: Math.min(world.height - 1, Math.ceil(maxY) + margin),
    };
  }

  const { wx: left, wy: top } = screenToWorld(cam, 0, 0);
  const { wx: right, wy: bottom } = screenToWorld(cam, canvasW, canvasH);
  return {
    x0: Math.max(0, Math.floor(left / TILE_SIZE)),
    y0: Math.max(0, Math.floor(top / TILE_SIZE)),
    x1: Math.min(world.width - 1, Math.floor(right / TILE_SIZE)),
    y1: Math.min(world.height - 1, Math.floor(bottom / TILE_SIZE)),
  };
}

export function centerOnWorld(cam: CameraState, isometric: boolean, world: LocalWorld): void {
  if (isometric) {
    const largestRoom = world.rooms.reduce<import('../types.ts').LocalRoom | null>(
      (best, r) => (!best || r.width * r.height > best.width * best.height ? r : best),
      null,
    );
    if (largestRoom) {
      const cx = largestRoom.x + largestRoom.width / 2;
      const cy = largestRoom.y + largestRoom.height / 2;
      const p = isoProject(cx, cy);
      cam.x = p.px;
      cam.y = p.py;
    } else {
      const c0 = isoProject(0, 0);
      const c1 = isoProject(world.width, 0);
      const c2 = isoProject(0, world.height);
      const c3 = isoProject(world.width, world.height);
      cam.x = (Math.min(c0.px, c1.px, c2.px, c3.px) + Math.max(c0.px, c1.px, c2.px, c3.px)) / 2;
      cam.y = (Math.min(c0.py, c1.py, c2.py, c3.py) + Math.max(c0.py, c1.py, c2.py, c3.py)) / 2;
    }
  } else {
    cam.x = (world.width * TILE_SIZE) / 2;
    cam.y = (world.height * TILE_SIZE) / 2;
  }
}

export function jumpToTile(
  cam: CameraState,
  isometric: boolean,
  tileX: number,
  tileY: number,
): void {
  if (isometric) {
    const p = isoProject(tileX, tileY);
    cam.x = p.px;
    cam.y = p.py;
  } else {
    cam.x = tileX * TILE_SIZE + TILE_SIZE / 2;
    cam.y = tileY * TILE_SIZE + TILE_SIZE / 2;
  }
}

export function animateCamera(cam: CameraState, px: number, py: number, duration = 400): CamAnim {
  return {
    fromX: cam.x,
    fromY: cam.y,
    targetX: px,
    targetY: py,
    startTime: performance.now(),
    duration,
  };
}

export function tickCameraAnimation(
  camAnim: CamAnim | null,
  cam: CameraState,
  now: number,
): CamAnim | null {
  if (!camAnim) return null;
  const t = Math.min(1, (now - camAnim.startTime) / camAnim.duration);
  const ease = 1 - Math.pow(1 - t, 3);
  cam.x = camAnim.fromX + (camAnim.targetX - camAnim.fromX) * ease;
  cam.y = camAnim.fromY + (camAnim.targetY - camAnim.fromY) * ease;
  return t >= 1 ? null : camAnim;
}

export function handleWheelZoom(
  cam: CameraState,
  deltaY: number,
  clientX: number,
  clientY: number,
): void {
  const factor = deltaY > 0 ? 0.9 : 1.1;
  const newZoom = clampZoom(cam.zoom * factor, 0.2, 4);
  const before = screenToWorld(cam, clientX, clientY);
  cam.zoom = newZoom;
  const after = screenToWorld(cam, clientX, clientY);
  cam.x += before.wx - after.wx;
  cam.y += before.wy - after.wy;
}

export { TILE_SIZE };
