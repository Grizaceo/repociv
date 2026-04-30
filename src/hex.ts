// ─── Axial Coordinate (q, r) ─────────────────────────────────────────────────
// Used for storage and grid math. q = column, r = row (diagonal neighbours).
// ─────────────────────────────────────────────────────────────────────────────

export interface Axial {
  readonly q: number;
  readonly r: number;
}

export const AXIAL_ZERO: Axial = { q: 0, r: 0 };

// ─── Direction vectors (6 neighbours in axial coords) ───────────────────────
export const AXIAL_DIRECTIONS: readonly Axial[] = [
  { q: +1, r:  0 },  // E
  { q: +1, r: -1 },  // NE
  { q:  0, r: -1 },  // NW
  { q: -1, r:  0 },  // W
  { q: -1, r: +1 },  // SW
  { q:  0, r: +1 },  // SE
] as const;

// ─── Arithmetic ─────────────────────────────────────────────────────────────
export function axialAdd(a: Axial, b: Axial): Axial {
  return { q: a.q + b.q, r: a.r + b.r };
}

export function axialSub(a: Axial, b: Axial): Axial {
  return { q: a.q - b.q, r: a.r - b.r };
}

export function axialScale(a: Axial, k: number): Axial {
  return { q: a.q * k, r: a.r * k };
}

export function axialEquals(a: Axial, b: Axial): boolean {
  return a.q === b.q && a.r === b.r;
}

// ─── Conversion: Axial ↔ Cube ────────────────────────────────────────────────
export function axialToCube(a: Axial): CubeCoord {
  const x = a.q;
  const y = -a.q - a.r;
  const z = a.r;
  return { x, y, z };
}

export function cubeToAxial(c: CubeCoord): Axial {
  return { q: c.x, r: c.z };
}

// ─── Cube coordinates (x, y, z) with invariant x+y+z=0 ───────────────────────
export interface CubeCoord {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function cubeEquals(a: CubeCoord, b: CubeCoord): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

// ─── Distance ────────────────────────────────────────────────────────────────
// Manhattan distance in cube space / 2 = ring distance in axial space
export function axialDistance(a: Axial, b: Axial): number {
  const c = axialToCube(axialSub(a, b));
  return (Math.abs(c.x) + Math.abs(c.y) + Math.abs(c.z)) / 2;
}

// ─── Neighbours ─────────────────────────────────────────────────────────────
export function axialNeighbour(a: Axial, direction: number): Axial {
  return axialAdd(a, AXIAL_DIRECTIONS[((direction % 6) + 6) % 6]!);
}

export function axialNeighbours(a: Axial): Axial[] {
  return AXIAL_DIRECTIONS.map(d => axialAdd(a, d));
}

// ─── Range / Ring ───────────────────────────────────────────────────────────
export function axialRing(center: Axial, radius: number): Axial[] {
  if (radius === 0) return [center];
  const results: Axial[] = [];
  // Start at hex `radius` steps in direction 4 (SW)
  let hex = axialAdd(center, axialScale(AXIAL_DIRECTIONS[4]!, radius));
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < radius; j++) {
      results.push(hex);
      hex = axialNeighbour(hex, i);
    }
  }
  return results;
}

export function axialRange(center: Axial, radius: number): Axial[] {
  const results: Axial[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      results.push(axialAdd(center, { q, r }));
    }
  }
  return results;
}

// ─── Line drawing (linear interpolation in cube space) ───────────────────────
export function axialLine(a: Axial, b: Axial): Axial[] {
  const N = axialDistance(a, b);
  if (N === 0) return [a];
  const results: Axial[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const q = Math.round(a.q + (b.q - a.q) * t);
    const r = Math.round(a.r + (b.r - a.r) * t);
    results.push({ q, r });
  }
  return results;
}

// ─── Pixel ↔ Axial (flat-topped hex, size = circumradius) ───────────────────
const SQRT3 = Math.sqrt(3);

export function axialToPixel(a: Axial, size: number): { x: number; y: number } {
  const x = size * (3 / 2 * a.q);
  const y = size * (SQRT3 / 2 * a.q + SQRT3 * a.r);
  return { x, y };
}

export function pixelToAxial(px: number, py: number, size: number): Axial {
  if (size <= 0) return { q: 0, r: 0 };
  const q = (2 / 3 * px) / size;
  const r = (-1 / 3 * px + SQRT3 / 3 * py) / size;
  return axialRound({ q, r });
}

// ─── Pixel ↔ Axial with camera offset ──────────────────────────────────────
export function axialToWorld(a: Axial, size: number, cam: Camera): { x: number; y: number } {
  const { x, y } = axialToPixel(a, size);
  return {
    x: (x - cam.x) * cam.zoom + cam.cx,
    y: (y - cam.y) * cam.zoom + cam.cy,
  };
}

export function worldToAxial(wx: number, wy: number, size: number, cam: Camera): Axial {
  const px = (wx - cam.cx) / cam.zoom + cam.x;
  const py = (wy - cam.cy) / cam.zoom + cam.y;
  return pixelToAxial(px, py, size);
}

// ─── Rounding ──────────────────────────────────────────────────────────────
// Round fractional axial coords to nearest hex
export function axialRound(a: { q: number; r: number }): Axial {
  const cube = axialToCube(a as Axial);
  let rx = Math.round(cube.x);
  let ry = Math.round(cube.y);
  let rz = Math.round(cube.z);

  const xDiff = Math.abs(rx - cube.x);
  const yDiff = Math.abs(ry - cube.y);
  const zDiff = Math.abs(rz - cube.z);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  return cubeToAxial({ x: rx, y: ry, z: rz });
}

// ─── Camera ─────────────────────────────────────────────────────────────────
export interface Camera {
  x: number;       // world-space center
  y: number;
  cx: number;      // canvas-space center (half of canvas width/height)
  cy: number;
  zoom: number;    // 1 = 100%, clamped
}

export const CAMERA_DEFAULT: Camera = {
  x: 0, y: 0, cx: 0, cy: 0, zoom: 1,
};

// ─── Spiral: place cities in outward expanding ring pattern ─────────────────
// Uses axialRing's convention: ring k starts k steps in direction 4 (SW).
export function spiralCoords(center: Axial, count: number): Axial[] {
  if (count === 0) return [];
  const results: Axial[] = [center];
  for (let k = 1; results.length < count; k++) {
    let hex = axialAdd(center, axialScale(AXIAL_DIRECTIONS[4]!, k));
    for (let i = 0; i < 6 && results.length < count; i++) {
      for (let j = 0; j < k && results.length < count; j++) {
        results.push(hex);
        hex = axialNeighbour(hex, i);
      }
    }
  }
  return results;
}
