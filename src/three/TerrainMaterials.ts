// ─── Terrain materials from map palette ─────────────────────────────────────
import { Color, MeshLambertMaterial } from 'three';
import { TERRAIN_COLOR } from '../map.ts';
import { type Terrain } from '../types.ts';

const ALL_TERRAINS: Terrain[] = [
  'plains',
  'forest',
  'mountain',
  'desert',
  'ocean',
  'ice',
  'hills',
  'sacred',
];

function hexToColor(hex: string): Color {
  return new Color(hex);
}

/** One Lambert material per biome (shared across instanced tiles). */
export function createTerrainMaterials(): Record<Terrain, MeshLambertMaterial> {
  const out = {} as Record<Terrain, MeshLambertMaterial>;
  for (const terrain of ALL_TERRAINS) {
    const palette = TERRAIN_COLOR[terrain];
    out[terrain] = new MeshLambertMaterial({
      color: hexToColor(palette.fill),
    });
  }
  return out;
}

/** Terrain index for instancing (stable ordering). */
export const TERRAIN_INDEX: Record<Terrain, number> = ALL_TERRAINS.reduce(
  (acc, t, i) => {
    acc[t] = i;
    return acc;
  },
  {} as Record<Terrain, number>,
);

export { ALL_TERRAINS };

/** Dim a color for fog / unrevealed tiles (matches iso25d overlay tone). */
export const FOG_DARK = 0x2a2a35;

export function fogTint(base: Color, alpha: number, target = new Color(FOG_DARK)): Color {
  return base.clone().lerp(target, 1 - alpha);
}
