import type { LocalWorld } from './types.ts';
import { ISO_TILE_W, ISO_TILE_H, ISO_WALL_H, isoProject } from './isoGeometry.ts';
import { monoFont } from './isoRenderStyle.ts';

interface IsoPowerOverlayState {
  ctx: CanvasRenderingContext2D;
  tokens: Record<string, string>;
}

export function drawIsoPowerOverlay(
  state: IsoPowerOverlayState,
  world: Pick<LocalWorld, 'powerGrid'>,
  view: { x0: number; y0: number; x1: number; y1: number },
) {
  const { ctx } = state;
  const pg = world.powerGrid;
  if (!pg) return;
  ctx.save();
  ctx.globalAlpha = 0.6;

  for (const key of pg.conduits) {
    const parts = key.split(',');
    if (parts.length < 2) continue;
    const sx = Number(parts[0]);
    const sy = Number(parts[1]);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
    if (sx < view.x0 || sx > view.x1 || sy < view.y0 || sy > view.y1) continue;
    const base = isoProject(sx, sy);
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(base.px, base.py - ISO_TILE_H / 2);
    ctx.lineTo(base.px, base.py + ISO_TILE_H / 2);
    ctx.moveTo(base.px - ISO_TILE_W / 2, base.py);
    ctx.lineTo(base.px + ISO_TILE_W / 2, base.py);
    ctx.stroke();
    ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
    ctx.beginPath();
    ctx.arc(base.px, base.py, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const src of pg.sources) {
    if (src.tileX < view.x0 || src.tileX > view.x1 || src.tileY < view.y0 || src.tileY > view.y1)
      continue;
    const base = isoProject(src.tileX, src.tileY);
    const now = performance.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 500);
    const glowR = ISO_TILE_W * 0.5 + 10 * pulse;
    const grad = ctx.createRadialGradient(base.px, base.py, 0, base.px, base.py, glowR);
    grad.addColorStop(0, `rgba(245, 158, 11, ${0.4 * pulse})`);
    grad.addColorStop(1, 'rgba(245, 158, 11, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(base.px - glowR, base.py - glowR, glowR * 2, glowR * 2);
    ctx.fillStyle = '#F59E0B';
    ctx.font = `bold 9px ${monoFont(state)}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${src.outputWatts}W`, base.px, base.py - 8);
  }

  for (const cons of pg.consumers) {
    if (
      cons.tileX < view.x0 ||
      cons.tileX > view.x1 ||
      cons.tileY < view.y0 ||
      cons.tileY > view.y1
    )
      continue;
    const base = isoProject(cons.tileX, cons.tileY);
    const barW = ISO_TILE_W * 0.6;
    const barH = 3;
    const bx = base.px - barW / 2;
    const by = base.py + ISO_TILE_H / 2 + 4;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(bx, by, barW, barH);
    const loadPct = Math.min(1, cons.watts / 200);
    ctx.fillStyle = loadPct > 0.8 ? '#EF4444' : loadPct > 0.5 ? '#F59E0B' : '#22C55E';
    ctx.fillRect(bx, by, barW * loadPct, barH);
  }

  if (pg.generatedWatts > 0 || pg.consumedWatts > 0) {
    const statsBase = isoProject(view.x0, view.y0);
    ctx.fillStyle = 'rgba(13, 13, 20, 0.9)';
    ctx.fillRect(statsBase.px - 5, statsBase.py - ISO_WALL_H - 55, 160, 50);
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
    ctx.strokeRect(statsBase.px - 5, statsBase.py - ISO_WALL_H - 55, 160, 50);
    ctx.fillStyle = '#22C55E';
    ctx.font = `11px ${monoFont(state)}`;
    ctx.textAlign = 'left';
    ctx.fillText(`⚡ Gen: ${pg.generatedWatts}W`, statsBase.px, statsBase.py - ISO_WALL_H - 40);
    ctx.fillStyle = '#EF4444';
    ctx.fillText(`🔌 Con: ${pg.consumedWatts}W`, statsBase.px, statsBase.py - ISO_WALL_H - 24);
    ctx.fillStyle = pg.storedWatts > 0 ? '#3B82F6' : '#6B7280';
    ctx.fillText(`🔋 Bat: ${pg.storedWatts}W`, statsBase.px, statsBase.py - ISO_WALL_H - 8);
  }

  ctx.restore();
}
