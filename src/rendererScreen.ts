// ─── RepoCiv — Screen-space overlay rendering ──────────────────────────────────
// Pure render functions that draw on top of the main world render.
// Extracted from renderer.ts to keep the orchestrator focused on dispatch.

import type { Camera, Axial } from './hex.ts';
import { tileKey, type Tile } from './types.ts';
import {
  renderDragGhost,
  renderCityDragGhost,
  renderAreaSelect,
  renderDropTarget,
} from './ui/spatialPreview.ts';
import { HEX_SIZE } from './constants.ts';

export interface ScreenOverlayState {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  cam: Camera;
  animTime: number;
  // spatial overlay state
  draggedUnit: { color: string; id: string } | null;
  ghostScreenPos: { x: number; y: number } | null;
  draggedCity: { name: string } | null;
  cityGhostScreenPos: { x: number; y: number } | null;
  relocateDragActive: boolean;
  areaStart: { x: number; y: number } | null;
  areaEnd: { x: number; y: number } | null;
  hoveredHex: Axial | null;
  // world access (minimal — only what overlays need)
  tiles: Map<string, Tile>;
  // callbacks to avoid importing heavy types
  tilePixelPos: (coord: Axial, tile?: Tile | null) => { x: number; y: number };
  canRelocateTo: (hoveredHex: Axial) => boolean;
}

/** Render all screen-space overlays: drag ghosts, area select, atmospheric bloom. */
export function renderScreenOverlays(s: ScreenOverlayState): void {
  const { ctx, canvas, cam } = s;

  // ─── Spatial overlays ───────────────────────────────────────────────────
  if (s.draggedUnit && s.ghostScreenPos) {
    renderDragGhost(
      ctx,
      s.ghostScreenPos.x,
      s.ghostScreenPos.y,
      s.draggedUnit.color,
      s.draggedUnit.id,
    );
    if (s.hoveredHex) {
      const toTile = s.tiles.get(tileKey(s.hoveredHex));
      const px = s.tilePixelPos(s.hoveredHex, toTile);
      const sx = (px.x - cam.x) * cam.zoom + cam.cx;
      const sy = (px.y - cam.y) * cam.zoom + cam.cy;
      renderDropTarget(ctx, sx, sy, HEX_SIZE * cam.zoom, !!toTile?.city);
    }
  }
  if (s.draggedCity && s.cityGhostScreenPos && s.relocateDragActive) {
    renderCityDragGhost(
      ctx,
      s.cityGhostScreenPos.x,
      s.cityGhostScreenPos.y,
      s.draggedCity.name,
    );
    if (s.hoveredHex) {
      const toTile = s.tiles.get(tileKey(s.hoveredHex));
      const ok = s.canRelocateTo(s.hoveredHex);
      const px = s.tilePixelPos(s.hoveredHex, toTile);
      const sx = (px.x - cam.x) * cam.zoom + cam.cx;
      const sy = (px.y - cam.y) * cam.zoom + cam.cy;
      renderDropTarget(ctx, sx, sy, HEX_SIZE * cam.zoom, ok);
    }
  }
  if (s.areaStart && s.areaEnd) {
    renderAreaSelect(ctx, s.areaStart.x, s.areaStart.y, s.areaEnd.x, s.areaEnd.y);
  }

  // ─── Atmospheric Bloom / Lighting ──────────────────────────────────────
  const timeOfDay = (s.animTime * 0.035) % (Math.PI * 2);
  const sinTime = Math.sin(timeOfDay);

  let warmColor: string;
  let vignetteColor: string;

  if (sinTime > 0.5) {
    warmColor = 'rgba(255, 255, 255, 0.015)';
    vignetteColor = 'rgba(0, 0, 0, 0.12)';
  } else if (sinTime > 0) {
    warmColor = 'rgba(240, 150, 50, 0.04)';
    vignetteColor = 'rgba(15, 10, 5, 0.22)';
  } else if (sinTime > -0.5) {
    warmColor = 'rgba(180, 100, 240, 0.03)';
    vignetteColor = 'rgba(8, 4, 18, 0.26)';
  } else {
    warmColor = 'rgba(40, 60, 180, 0.015)';
    vignetteColor = 'rgba(1, 1, 6, 0.45)';
  }

  const grad = ctx.createRadialGradient(
    canvas.width / 2,
    canvas.height / 2,
    0,
    canvas.width / 2,
    canvas.height / 2,
    canvas.width,
  );
  grad.addColorStop(0, warmColor);
  grad.addColorStop(1, vignetteColor);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
