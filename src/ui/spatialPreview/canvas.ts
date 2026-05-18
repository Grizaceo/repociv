// ─── Canvas overlay drawing (drag ghosts, area select, drop target) ────────
// Pure functions over CanvasRenderingContext2D — sin DOM, sin estado.
import { HEX_SIZE } from '../../constants.ts';

function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    const x = cx + size * Math.cos(a);
    const y = cy + size * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Drag-ghost for a unit (circle + first-letter label). */
export function renderDragGhost(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  unitColor: string,
  unitLabel: string,
): void {
  ctx.save();
  ctx.globalAlpha = 0.65;
  ctx.beginPath();
  ctx.arc(screenX, screenY, 18, 0, Math.PI * 2);
  ctx.fillStyle = unitColor;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(unitLabel[0] ?? '?', screenX, screenY);
  ctx.restore();
}

/** Ghost for relocating a city (larger than unit ghost, flat-top hex + label). */
export function renderCityDragGhost(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  cityName: string,
): void {
  ctx.save();
  ctx.globalAlpha = 0.65;
  const size = HEX_SIZE * 1.2;
  hexPath(ctx, screenX, screenY, size);
  ctx.fillStyle = '#d4a574';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cityName.slice(0, 8), screenX, screenY);
  ctx.restore();
}

/** Area-select rubber-band rectangle. */
export function renderAreaSelect(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  ctx.save();
  ctx.strokeStyle = '#c8a84b';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(200,168,75,0.08)';
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/** Hex outline highlight for a drag-drop target tile. */
export function renderDropTarget(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  valid: boolean,
): void {
  ctx.save();
  ctx.strokeStyle = valid ? '#5b9b5b' : '#d45b5b';
  ctx.lineWidth = 3;
  ctx.shadowColor = valid ? '#5b9b5b' : '#d45b5b';
  ctx.shadowBlur = 12;
  hexPath(ctx, cx, cy, size);
  ctx.stroke();
  ctx.restore();
}
