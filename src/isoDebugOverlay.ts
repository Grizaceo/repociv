import type { LocalUnit } from './types.ts';
import { ISO_WALL_H, isoProject } from './isoGeometry.ts';
import { monoFont } from './isoRenderStyle.ts';

interface IsoDebugOverlayState {
  ctx: CanvasRenderingContext2D;
  tokens: Record<string, string>;
  fpsValue: number;
}

interface IsoDebugWorld {
  rooms: { workbenches: readonly unknown[] }[];
}

type IsoDebugUnit = Pick<
  LocalUnit,
  | 'path'
  | 'pathIndex'
  | 'color'
  | 'gridX'
  | 'gridY'
  | 'name'
  | 'state'
  | 'fatigue'
  | 'effectiveSpeed'
  | 'mission'
  | 'currentWorkbenchId'
>;

export function drawIsoDebugOverlay(
  state: IsoDebugOverlayState,
  world: IsoDebugWorld,
  localUnits: IsoDebugUnit[],
) {
  const { ctx } = state;
  for (const unit of localUnits) {
    if (unit.path.length === 0 || unit.pathIndex >= unit.path.length) continue;
    const remaining = unit.path.slice(unit.pathIndex);
    if (remaining.length < 2) continue;

    ctx.strokeStyle = unit.color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    const start = isoProject(remaining[0]!.x, remaining[0]!.y);
    ctx.moveTo(start.px, start.py);
    for (let i = 1; i < remaining.length; i++) {
      const p = isoProject(remaining[i]!.x, remaining[i]!.y);
      ctx.lineTo(p.px, p.py);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = unit.color;
    for (const wp of remaining) {
      const p = isoProject(wp.x, wp.y);
      ctx.beginPath();
      ctx.arc(p.px, p.py, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const unit of localUnits) {
    const base = isoProject(unit.gridX, unit.gridY);
    const lines: string[] = [
      `${unit.name}`,
      `st: ${unit.state}`,
      `pos: ${unit.gridX},${unit.gridY}`,
      `fat: ${Math.round(unit.fatigue)}`,
      `spd: ${unit.effectiveSpeed.toFixed(1)}`,
    ];
    if (unit.mission) lines.push(`mission: ${unit.mission.slice(0, 12)}`);
    if (unit.currentWorkbenchId) lines.push(`wb: ${unit.currentWorkbenchId.slice(0, 8)}`);

    const lineH = 9;
    const cardW = 72;
    const cardH = lines.length * lineH + 4;
    const cx = base.px - cardW / 2;
    const cy = base.py - ISO_WALL_H - 34 - cardH;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.beginPath();
    ctx.roundRect(cx, cy, cardW, cardH, 2);
    ctx.fill();
    ctx.strokeStyle = unit.color;
    ctx.lineWidth = 0.5;
    ctx.stroke();

    ctx.fillStyle = '#E2E8F0';
    ctx.font = `bold 7px ${monoFont(state)}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i]!, cx + 3, cy + 2 + i * lineH);
    }
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(8, 8, 90, 40);
  ctx.strokeStyle = '#606060';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(8, 8, 90, 40);

  ctx.fillStyle = '#E2E8F0';
  ctx.font = `bold 10px ${monoFont(state)}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`FPS: ${state.fpsValue}`, 14, 14);
  ctx.fillText(`Ticks: ${world.rooms.reduce((n, r) => n + r.workbenches.length, 0)}`, 14, 26);
  ctx.fillText(`Units: ${localUnits.length}`, 14, 38);
  ctx.restore();
}
