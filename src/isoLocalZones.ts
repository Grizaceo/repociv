import type { LocalWorld, ZoneType } from './types.ts';
import { isoTileCorners } from './isoGeometry.ts';
import { monoFont } from './isoRenderStyle.ts';

// Only the state consumed by zones; no dependency back to the renderer.
interface IsoZoneOverlayState {
  ctx: CanvasRenderingContext2D;
  tokens: Record<string, string>;
  zonePaintMode: ZoneType | null;
  zonePaintStart: { x: number; y: number } | null;
  zonePaintCurrent: { x: number; y: number } | null;
}

export function drawIsoZones(
  state: Pick<IsoZoneOverlayState, 'ctx' | 'tokens'>,
  world: Pick<LocalWorld, 'zones'>,
  view: { x0: number; y0: number; x1: number; y1: number },
) {
  const { ctx } = state;
  if (!world.zones) return;
  const zoneColors: Record<string, string> = {
    stockpile: '#8B5A2B',
    growing: '#4A7C2E',
    recreation: '#D4A537',
    bedroom: '#6B4F8A',
    dining: '#C46B3B',
    hospital: '#C0392B',
  };
  for (const zone of world.zones) {
    const color = zoneColors[zone.type] || '#888';
    ctx.save();
    ctx.globalAlpha = 0.2;
    for (const tile of zone.tiles) {
      if (tile.x < view.x0 || tile.x > view.x1 || tile.y < view.y0 || tile.y > view.y1) continue;
      const corners = isoTileCorners(tile.x, tile.y);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(corners[0]!.x, corners[0]!.y);
      ctx.lineTo(corners[1]!.x, corners[1]!.y);
      ctx.lineTo(corners[2]!.x, corners[2]!.y);
      ctx.lineTo(corners[3]!.x, corners[3]!.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    if (zone.tiles.length > 0) {
      const xs = zone.tiles.map((t) => t.x);
      const ys = zone.tiles.map((t) => t.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      const c1 = isoTileCorners(minX, minY);
      const c2 = isoTileCorners(maxX, maxY);
      ctx.beginPath();
      ctx.moveTo(c1[0]!.x, c1[0]!.y);
      ctx.lineTo(c1[1]!.x, c1[1]!.y);
      ctx.lineTo(c2[2]!.x, c2[2]!.y);
      ctx.lineTo(c2[3]!.x, c2[3]!.y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = `bold 9px ${monoFont(state)}`;
      ctx.textAlign = 'left';
      ctx.fillText(zone.type.toUpperCase(), c1[0]!.x, c1[0]!.y - 4);
    }
  }
}

export function drawIsoZonePaintPreview(
  state: IsoZoneOverlayState,
  view: { x0: number; y0: number; x1: number; y1: number },
) {
  const { ctx } = state;
  if (!state.zonePaintStart || !state.zonePaintCurrent) return;
  const x0 = Math.min(state.zonePaintStart.x, state.zonePaintCurrent.x);
  const y0 = Math.min(state.zonePaintStart.y, state.zonePaintCurrent.y);
  const x1 = Math.max(state.zonePaintStart.x, state.zonePaintCurrent.x);
  const y1 = Math.max(state.zonePaintStart.y, state.zonePaintCurrent.y);

  const zoneColors: Record<string, string> = {
    stockpile: '#8B5A2B',
    growing: '#4A7C2E',
    recreation: '#D4A537',
    bedroom: '#6B4F8A',
    dining: '#C46B3B',
    hospital: '#C0392B',
  };
  const color = zoneColors[state.zonePaintMode || 'stockpile'] || '#888';

  ctx.save();
  ctx.globalAlpha = 0.25;
  for (let y = y0; y <= y1; y++) {
    if (y < view.y0 || y > view.y1) continue;
    for (let x = x0; x <= x1; x++) {
      if (x < view.x0 || x > view.x1) continue;
      const corners = isoTileCorners(x, y);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(corners[0]!.x, corners[0]!.y);
      ctx.lineTo(corners[1]!.x, corners[1]!.y);
      ctx.lineTo(corners[2]!.x, corners[2]!.y);
      ctx.lineTo(corners[3]!.x, corners[3]!.y);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();

  const c1 = isoTileCorners(x0, y0);
  const c2 = isoTileCorners(x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.beginPath();
  ctx.moveTo(c1[0]!.x, c1[0]!.y);
  ctx.lineTo(c1[1]!.x, c1[1]!.y);
  ctx.lineTo(c2[2]!.x, c2[2]!.y);
  ctx.lineTo(c2[3]!.x, c2[3]!.y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  ctx.fillStyle = color;
  ctx.font = `bold 10px ${monoFont(state)}`;
  ctx.textAlign = 'center';
  ctx.fillText(`${w}×${h} (${w * h} tiles)`, (c1[0]!.x + c2[2]!.x) / 2, c1[0]!.y - 8);
}
