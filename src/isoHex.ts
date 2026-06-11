// ─── RepoCiv — Isometric hex projection (global map 2.5D) ───────────────────
import { axialToPixel, pixelToAxial, type Axial, type Camera } from './hex.ts';
import { type Terrain } from './types.ts';
import { HEX_SIZE } from './constants.ts';

/** Scale factor applied to flat-top hex layout. */
export const ISO_HEX_SCALE = 1;

/** Vertical extrusion per elevation step (pixels, screen-up is negative Y). */
export const ISO_EXTRUDE_H = 12;

/** Top-face radius factor — slightly below 1.0 to prevent neighbor overlap. */
export const ISO_HEX_RADIUS = 0.88;

/** @deprecated Layout uses flat hex spacing; kept for test compat. */
export const ISO_TILT_Y = 1;

/** Relative height steps per terrain type for extruded tiles. */
export function terrainElevation(terrain: Terrain): number {
  switch (terrain) {
    case 'mountain':
      return 3;
    case 'hills':
      return 2;
    case 'forest':
      return 1;
    case 'ocean':
      return -1;
    default:
      return 0;
  }
}

/** Pixel offset for a tile top face center from axial coords and elevation. */
export function axialToIsoPixel(
  q: number,
  r: number,
  size = HEX_SIZE,
  elevation = 0,
): { x: number; y: number } {
  const flat = axialToPixel({ q, r }, size * ISO_HEX_SCALE);
  // Keep flat hex tiling; only lift for elevation (true 2.5D extrusion).
  return { x: flat.x, y: flat.y - elevation * ISO_EXTRUDE_H };
}

/** Screen coords → axial hex (inverse camera + iso projection). */
export function screenToAxial(
  screenX: number,
  screenY: number,
  size = HEX_SIZE,
  cam: Camera,
): Axial {
  const px = (screenX - cam.cx) / cam.zoom + cam.x;
  const py = (screenY - cam.cy) / cam.zoom + cam.y;
  return pixelToAxial(px, py, size * ISO_HEX_SCALE);
}

/** Six flat-top hex corner angles (degrees). */
export function hexCornerAngle(index: number): number {
  return (Math.PI / 180) * (60 * index - 30);
}

