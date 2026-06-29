// ─── Overlays — power, temperature, zones, labels ──────────────────────────
import type { LocalWorld, ZoneType } from '../types.ts';
import {
  drawPowerOverlay as drawPowerOverlayModule,
  drawTemperatureOverlay as drawTemperatureOverlayModule,
  drawWindowLightRays as drawWindowLightRaysModule,
  drawZonePaintPreview as drawZonePaintPreviewModule,
  drawZones as drawZonesModule,
} from '../localOverlays.ts';

const TILE_SIZE = 32;

export interface OverlayState {
  ctx: CanvasRenderingContext2D;
  tokens: Record<string, string>;
  tileSize: number;
  zonePaintMode: ZoneType | null;
  zonePaintStart: { x: number; y: number } | null;
  zonePaintCurrent: { x: number; y: number } | null;
  spawnBreath: (x: number, y: number) => void;
}

export function makeOverlayState(
  ctx: CanvasRenderingContext2D,
  tokens: Record<string, string>,
  zonePaintMode: ZoneType | null,
  zonePaintStart: { x: number; y: number } | null,
  zonePaintCurrent: { x: number; y: number } | null,
  spawnBreath: (x: number, y: number) => void,
): OverlayState {
  return {
    ctx,
    tokens,
    tileSize: TILE_SIZE,
    zonePaintMode,
    zonePaintStart,
    zonePaintCurrent,
    spawnBreath,
  };
}

export interface AssetState {
  ctx: CanvasRenderingContext2D;
  fontMono: string;
  tileSize: number;
}

export function makeAssetState(
  ctx: CanvasRenderingContext2D,
  tokens: Record<string, string>,
): AssetState {
  return {
    ctx,
    fontMono: tokens.fontMono ?? "'JetBrains Mono', monospace",
    tileSize: TILE_SIZE,
  };
}

// Re-exported overlay drawing functions (thin wrappers that accept our state types)
export function drawPowerOverlay(
  state: OverlayState,
  world: LocalWorld,
  view: { x0: number; y0: number; x1: number; y1: number },
): void {
  drawPowerOverlayModule(state, world, view);
}

export function drawTemperatureOverlay(
  state: OverlayState,
  world: LocalWorld,
  view: { x0: number; y0: number; x1: number; y1: number },
): void {
  drawTemperatureOverlayModule(state, world, view);
}

export function drawWindowLightRays(
  state: OverlayState,
  world: LocalWorld,
  view: { x0: number; y0: number; x1: number; y1: number },
): void {
  drawWindowLightRaysModule(state, world, view);
}

export function drawZonePaintPreview(
  state: OverlayState,
  view: { x0: number; y0: number; x1: number; y1: number },
): void {
  drawZonePaintPreviewModule(state, view);
}

export function drawZones(
  state: OverlayState,
  world: LocalWorld,
  view: { x0: number; y0: number; x1: number; y1: number },
): void {
  drawZonesModule(state, world, view);
}
