// Pure isometric geometry shared by office drawing and local rendering.

export const ISO_TILE_W = 64;
export const ISO_TILE_H = 32;
export const ISO_WALL_H = 24;

export function isoProject(x: number, y: number, z = 0): { px: number; py: number } {
  return {
    px: ((x - y) * ISO_TILE_W) / 2,
    py: ((x + y) * ISO_TILE_H) / 2 - z * ISO_WALL_H,
  };
}

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
