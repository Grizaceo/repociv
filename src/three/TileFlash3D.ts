// ─── Tile flash: yellow ring on tile traversal ──────────────────────────────
// When a unit steps onto a tile, a yellow hex ring flashes for 200ms.
// The flash is driven by tickTileFlash(dt), called every frame. Flash
// requests are queued via flashTile(q, r, elev) — typically called from
// the movement tween when pathProgress wraps past 1.
import {
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Group,
} from 'three';
import { HEX_SIZE } from '../constants.ts';
import { hexCornerAngle3D, axialToWorld3D } from './axialToWorld3D.ts';

const flashGroup = new Group();
flashGroup.name = 'tile-flash';

const FLASH_DURATION = 0.2; // 200ms
const FLASH_COLOR = 0xffe040;
const FLASH_MAX_OPACITY = 0.8;

interface FlashEntry {
  q: number;
  r: number;
  /** Remaining time in seconds. */
  timeLeft: number;
  lines: LineSegments;
}

const activeFlashes: FlashEntry[] = [];

export function getTileFlashGroup(): Group {
  return flashGroup;
}

/** Queue a yellow ring flash on a tile. Called when a unit traverses it. */
export function flashTile(q: number, r: number, elev: number): void {
  // Skip if there's already a flash on this tile.
  const key = `${q},${r}`;
  for (const f of activeFlashes) {
    if (`${f.q},${f.r}` === key) return;
  }

  const center = axialToWorld3D(q, r, elev);
  const segments: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a1 = hexCornerAngle3D(i);
    const a2 = hexCornerAngle3D((i + 1) % 6);
    const y = center.y + 1.5;
    segments.push(
      center.x + HEX_SIZE * Math.cos(a1),
      y,
      center.z + HEX_SIZE * Math.sin(a1),
      center.x + HEX_SIZE * Math.cos(a2),
      y,
      center.z + HEX_SIZE * Math.sin(a2),
    );
  }

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(segments, 3));
  const mat = new LineBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: FLASH_MAX_OPACITY,
    linewidth: 3,
  });
  const lines = new LineSegments(geom, mat);
  flashGroup.add(lines);

  activeFlashes.push({ q, r, timeLeft: FLASH_DURATION, lines });
}

/** Per-frame: advance flash timers, fade opacity, remove expired flashes.
 *  Frozen dt=0 keeps goldens stable (flashes freeze but don't disappear). */
export function tickTileFlash(dt: number): void {
  for (let i = activeFlashes.length - 1; i >= 0; i--) {
    const flash = activeFlashes[i]!;
    flash.timeLeft -= dt;
    if (flash.timeLeft <= 0) {
      flashGroup.remove(flash.lines);
      flash.lines.geometry.dispose();
      (flash.lines.material as LineBasicMaterial).dispose();
      activeFlashes.splice(i, 1);
      continue;
    }
    // Fade opacity linearly.
    const alpha = flash.timeLeft / FLASH_DURATION;
    (flash.lines.material as LineBasicMaterial).opacity = FLASH_MAX_OPACITY * alpha;
  }
}

export function clearTileFlash(): void {
  for (const flash of activeFlashes) {
    flashGroup.remove(flash.lines);
    flash.lines.geometry.dispose();
    (flash.lines.material as LineBasicMaterial).dispose();
  }
  activeFlashes.length = 0;
}
