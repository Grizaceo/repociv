// ─── Units that share a hex: a small ring inside it ─────────────────────────
// External agents stand *in* their city (on the city hex), several can share
// it, and the city model sits at the hex centre. Every unit that stands on a
// city hex, or on a hex it shares, gets a slot on a ring inside the hex, so
// none buries the others or hides in the city — and a click resolves to the
// nearest slot, or to the city at the centre. Both renderers read the same
// offsets: 2D map space and 3D world XZ are the same numbers (axialToWorld3D).

import { axialToPixel, type Axial } from './hex.ts';
import { tileKey, type Unit } from './types.ts';

/** Slot distance from the hex centre, in hex sizes. */
export const STACK_RING = 0.5;

export interface StackOffset {
  x: number;
  y: number;
}

/** Map-space offset of each unit standing off its hex centre (moving and
 *  hidden units get none: they are on their way or not drawn). */
export function stackOffsets(
  units: readonly Unit[],
  hasCity: (key: string) => boolean,
  hexSize: number,
): Map<string, StackOffset> {
  const byHex = new Map<string, Unit[]>();
  for (const unit of units) {
    if (unit.hidden || unit.state === 'moving') continue;
    const key = tileKey(unit.coord);
    const here = byHex.get(key);
    if (here) here.push(unit);
    else byHex.set(key, [unit]);
  }
  const out = new Map<string, StackOffset>();
  for (const [key, here] of byHex) {
    if (here.length === 1 && !hasCity(key)) continue;
    here.forEach((unit, i) => {
      // First slot straight below the centre (toward the viewer), then around.
      const angle = Math.PI / 2 + (i * 2 * Math.PI) / here.length;
      out.set(unit.id, {
        x: Math.cos(angle) * STACK_RING * hexSize,
        y: Math.sin(angle) * STACK_RING * hexSize,
      });
    });
  }
  return out;
}

/** The unit a click at map-space `point` means on hex `coord`, or null when
 *  the city at the centre is nearer than every unit slot. */
export function pickOnHex(
  point: { x: number; y: number },
  coord: Axial,
  here: readonly Unit[],
  offsets: ReadonlyMap<string, StackOffset>,
  cityHere: boolean,
  hexSize: number,
): Unit | null {
  const centre = axialToPixel(coord, hexSize);
  let best: Unit | null = null;
  let bestDist = cityHere ? Math.hypot(point.x - centre.x, point.y - centre.y) : Infinity;
  for (const unit of here) {
    const off = offsets.get(unit.id) ?? { x: 0, y: 0 };
    const dist = Math.hypot(point.x - centre.x - off.x, point.y - centre.y - off.y);
    if (dist < bestDist) {
      best = unit;
      bestDist = dist;
    }
  }
  return best;
}
