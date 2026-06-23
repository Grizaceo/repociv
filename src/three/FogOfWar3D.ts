// ─── Fog-of-war tinting for instanced terrain ───────────────────────────────
import { Color } from 'three';
import { type Tile } from '../types.ts';
import { TERRAIN_COLOR } from '../map.ts';

export interface FogTileState {
  revealed: boolean;
  inFog: boolean;
}

export function tileFogAlpha(tile: Tile, fogEnabled: boolean): number {
  if (!tile.revealed) return 0.1;
  if (tile.inFog && fogEnabled) return 0.35;
  return 1;
}

const scratchGrey = new Color();

/** Instance color with fog/reveal dimming applied.
 *  Civ V fog of war is desaturated dusk, not a navy bruise: the legacy
 *  fogTint() lerped toward slate 0x2a2a35, which tinted every fogged tile
 *  blue-purple. Desaturate-then-dim keeps the biome hue readable under fog. */
export function instanceColorForTile(tile: Tile, fogEnabled: boolean, target = new Color()): Color {
  const baseHex = TERRAIN_COLOR[tile.terrain]?.fill ?? TERRAIN_COLOR.plains.fill;
  target.set(baseHex);
  const alpha = tileFogAlpha(tile, fogEnabled);
  if (alpha >= 1) return target;
  const t = 1 - alpha;
  const lum = target.r * 0.299 + target.g * 0.587 + target.b * 0.114;
  scratchGrey.setRGB(lum, lum, lum);
  target.lerp(scratchGrey, 0.45 * t);
  target.multiplyScalar(1 - 0.45 * t);
  return target;
}
