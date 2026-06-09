// ─── Fog-of-war tinting for instanced terrain ───────────────────────────────
import { Color } from 'three';
import { type Tile } from '../types.ts';
import { fogTint } from './TerrainMaterials.ts';
import { TERRAIN_COLOR } from '../map.ts';

export interface FogTileState {
  revealed: boolean;
  inFog: boolean;
}

export function tileFogAlpha(tile: Tile, fogEnabled: boolean): number {
  if (!tile.revealed) return 0.15;
  if (tile.inFog && fogEnabled) return 0.35;
  return 1;
}

/** Instance color with fog/reveal dimming applied. */
export function instanceColorForTile(
  tile: Tile,
  fogEnabled: boolean,
  target = new Color(),
): Color {
  const baseHex = TERRAIN_COLOR[tile.terrain]?.fill ?? TERRAIN_COLOR.plains.fill;
  target.set(baseHex);
  return fogTint(target, tileFogAlpha(tile, fogEnabled));
}
