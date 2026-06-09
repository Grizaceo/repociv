// ─── RepoCiv — Isometric office sprite drawing (atlas + procedural fallback) ───

import type { LocalTile } from './types.ts';
import { getOfficeSprite, isOfficeAtlasLoaded } from './officeAtlas.ts';

export const ISO_TILE_W = 64;
export const ISO_TILE_H = 32;
export const ISO_WALL_H = 24;
export const ISO_PARTITION_H = 12;

export function isoProject(x: number, y: number, z = 0): { px: number; py: number } {
  return {
    px: (x - y) * ISO_TILE_W / 2,
    py: (x + y) * ISO_TILE_H / 2 - z * ISO_WALL_H,
  };
}

export interface IsoOfficeDrawContext {
  ctx: CanvasRenderingContext2D;
  fontMono: string;
  extColor: Record<string, string>;
}

function drawSpriteOrFallback(
  dctx: IsoOfficeDrawContext,
  gx: number,
  gy: number,
  spriteName: string,
  fallback: () => void,
  flip = false,
): void {
  const { ctx } = dctx;
  const base = isoProject(gx, gy);
  const sprite = isOfficeAtlasLoaded() ? getOfficeSprite(spriteName as never) : null;
  if (sprite) {
    ctx.save();
    ctx.translate(base.px, base.py - ISO_TILE_H / 2);
    if (flip) {
      ctx.scale(-1, 1);
      ctx.drawImage(sprite, -sprite.width / 2, 0, sprite.width, sprite.height);
    } else {
      ctx.drawImage(sprite, -sprite.width / 2, 0, sprite.width, sprite.height);
    }
    ctx.restore();
    return;
  }
  fallback();
}

/** Low cubicle partition (extruded, shorter than full wall). */
export function drawIsoCubiclePartition(
  dctx: IsoOfficeDrawContext,
  gx: number,
  gy: number,
  facing: 'n' | 's' | 'e' | 'w' = 'n',
): void {
  const { ctx } = dctx;
  const base = isoProject(gx, gy);
  const h = ISO_PARTITION_H;
  const isHorizontal = facing === 'n' || facing === 's';

  drawSpriteOrFallback(dctx, gx, gy, isHorizontal ? 'partition_h' : 'partition_v', () => {
    ctx.fillStyle = '#A8B0C0';
    ctx.beginPath();
    if (isHorizontal) {
      ctx.moveTo(base.px - 14, base.py - 2);
      ctx.lineTo(base.px + 14, base.py - 2);
      ctx.lineTo(base.px + 12, base.py - h);
      ctx.lineTo(base.px - 12, base.py - h);
    } else {
      ctx.moveTo(base.px - 4, base.py - 6);
      ctx.lineTo(base.px + 4, base.py - 2);
      ctx.lineTo(base.px + 4, base.py - h);
      ctx.lineTo(base.px - 4, base.py - h - 4);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(80, 90, 100, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  });
}

function drawProceduralDesk(
  dctx: IsoOfficeDrawContext,
  gx: number,
  gy: number,
  facing: 'n' | 's' | 'e' | 'w',
  extLabel?: string,
  extColor = '#888',
  isActive = false,
): void {
  const { ctx, fontMono } = dctx;
  const base = isoProject(gx, gy);
  const flip = facing === 'w' || facing === 'n';

  drawSpriteOrFallback(
    dctx,
    gx,
    gy,
    facing === 'e' || facing === 's' ? 'desk_r' : 'desk_l',
    () => {
      const deskH = 10;
      ctx.fillStyle = '#B09060';
      ctx.beginPath();
      ctx.moveTo(base.px - 10, base.py - deskH);
      ctx.lineTo(base.px, base.py - 6 - deskH);
      ctx.lineTo(base.px + 10, base.py - deskH);
      ctx.lineTo(base.px, base.py + 6 - deskH);
      ctx.closePath();
      ctx.fill();

      if (isActive) {
        ctx.shadowColor = extColor;
        ctx.shadowBlur = 8;
      }
      ctx.fillStyle = '#D0D0D0';
      ctx.fillRect(base.px - 6, base.py - 22, 12, 10);
      ctx.shadowBlur = 0;
      ctx.fillStyle = isActive ? extColor : 'rgba(140, 170, 190, 0.3)';
      ctx.fillRect(base.px - 5, base.py - 21, 10, 8);

      if (extLabel) {
        ctx.fillStyle = extColor;
        ctx.font = `bold 5px ${fontMono}`;
        ctx.textAlign = 'center';
        ctx.fillText(extLabel, base.px, base.py - 16);
      }

      ctx.fillStyle = '#B08090';
      ctx.beginPath();
      const chairOff = flip ? -8 : 8;
      ctx.ellipse(base.px + chairOff, base.py + 6, 4, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    },
    flip,
  );
}

function drawProceduralChair(dctx: IsoOfficeDrawContext, gx: number, gy: number): void {
  drawSpriteOrFallback(dctx, gx, gy, 'chair', () => {
    const { ctx } = dctx;
    const base = isoProject(gx, gy);
    ctx.fillStyle = '#B08090';
    ctx.beginPath();
    ctx.ellipse(base.px, base.py + 2, 5, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#888';
    ctx.beginPath();
    ctx.ellipse(base.px, base.py + 8, 2, 2, 0, 0, Math.PI * 2);
    ctx.fill();
  });
}

/** Unified office sprite renderer with procedural fallback. */
export function drawIsoOfficeSprite(
  dctx: IsoOfficeDrawContext,
  tile: LocalTile,
  gx: number,
  gy: number,
  activeWbIds?: Set<string | null>,
): void {
  const wb = tile.workbench;
  const facing = tile.facing ?? 's';
  const extColor = wb ? (dctx.extColor[wb.extension] ?? '#888') : '#888';
  const isActive = wb ? (activeWbIds?.has(wb.id) ?? false) : false;

  switch (tile.type) {
    case 'workbench':
      drawProceduralDesk(
        dctx,
        gx,
        gy,
        facing,
        wb?.extension.toUpperCase().slice(0, 3),
        extColor,
        isActive,
      );
      break;
    case 'chair':
      drawProceduralChair(dctx, gx, gy);
      break;
    case 'cubicle_partition':
      drawIsoCubiclePartition(dctx, gx, gy, facing);
      break;
    case 'standing_desk':
      drawProceduralDesk(dctx, gx, gy, 'e');
      break;
    case 'reception':
      drawSpriteOrFallback(dctx, gx, gy, 'reception_desk', () => {
        const { ctx } = dctx;
        const base = isoProject(gx, gy);
        ctx.fillStyle = '#B09060';
        ctx.fillRect(base.px - 12, base.py - 4, 24, 8);
        ctx.fillStyle = '#D8DCE0';
        ctx.fillRect(base.px - 4, base.py - 14, 8, 6);
      });
      break;
    case 'watercooler':
      drawSpriteOrFallback(dctx, gx, gy, 'watercooler', () => {
        const { ctx } = dctx;
        const base = isoProject(gx, gy);
        ctx.fillStyle = '#B0C8E0';
        ctx.fillRect(base.px - 6, base.py - 12, 12, 14);
      });
      break;
    case 'planter':
      drawSpriteOrFallback(dctx, gx, gy, 'plant', () => {
        const { ctx } = dctx;
        const base = isoProject(gx, gy);
        ctx.fillStyle = '#608860';
        ctx.beginPath();
        ctx.ellipse(base.px, base.py - 6, 8, 6, 0, 0, Math.PI * 2);
        ctx.fill();
      });
      break;
    case 'whiteboard':
      drawSpriteOrFallback(dctx, gx, gy, 'whiteboard', () => {});
      break;
    default:
      break;
  }
}

/** Carpet overlay for aisle tiles (static layer) — procedural only to avoid atlas bleed. */
export function drawIsoCarpetTile(dctx: IsoOfficeDrawContext, gx: number, gy: number): void {
  const { ctx } = dctx;
  const base = isoProject(gx, gy);
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = 'rgba(120, 100, 90, 0.35)';
  ctx.beginPath();
  ctx.moveTo(base.px, base.py - ISO_TILE_H / 2);
  ctx.lineTo(base.px + ISO_TILE_W / 2, base.py);
  ctx.lineTo(base.px, base.py + ISO_TILE_H / 2);
  ctx.lineTo(base.px - ISO_TILE_W / 2, base.py);
  ctx.closePath();
  ctx.fill();
  // Runner stripe down the corridor center
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(base.px, base.py - ISO_TILE_H / 2);
  ctx.lineTo(base.px, base.py + ISO_TILE_H / 2);
  ctx.stroke();
  ctx.restore();
}

/** Ceiling light pool on static layer (soft gradient only — no sprite rect). */
export function drawIsoCeilingLight(dctx: IsoOfficeDrawContext, gx: number, gy: number): void {
  const { ctx } = dctx;
  const base = isoProject(gx, gy, 1);
  ctx.save();
  const grad = ctx.createRadialGradient(base.px, base.py, 0, base.px, base.py, ISO_TILE_W * 0.75);
  grad.addColorStop(0, 'rgba(255, 248, 220, 0.14)');
  grad.addColorStop(0.5, 'rgba(255, 248, 220, 0.05)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(base.px, base.py, ISO_TILE_W * 0.75, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 240, 200, 0.35)';
  ctx.beginPath();
  ctx.ellipse(base.px, base.py - ISO_TILE_H * 0.3, 4, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Exterior facade windows on grid perimeter (static layer). */
export function drawIsoExteriorFacade(
  dctx: IsoOfficeDrawContext,
  gx: number,
  gy: number,
  worldW: number,
  worldH: number,
): void {
  const onPerimeter = gx === 0 || gy === 0 || gx === worldW - 1 || gy === worldH - 1;
  if (!onPerimeter) return;
  const { ctx } = dctx;
  const base = isoProject(gx, gy);
  const WH = ISO_WALL_H + 8;
  ctx.fillStyle = 'rgba(140, 175, 210, 0.35)';
  ctx.fillRect(base.px - 8, base.py - WH, 16, WH * 0.6);
  ctx.strokeStyle = 'rgba(200, 220, 240, 0.5)';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(base.px - 8, base.py - WH, 16, WH * 0.6);
  ctx.beginPath();
  ctx.moveTo(base.px, base.py - WH);
  ctx.lineTo(base.px, base.py - WH + WH * 0.6);
  ctx.moveTo(base.px - 8, base.py - WH + WH * 0.3);
  ctx.lineTo(base.px + 8, base.py - WH + WH * 0.3);
  ctx.stroke();
}

/** Door signage plate with room zone label. */
export function drawIsoDoorSignage(
  dctx: IsoOfficeDrawContext,
  gx: number,
  gy: number,
  label: string,
): void {
  const { ctx, fontMono } = dctx;
  const base = isoProject(gx, gy, 1);
  const text = label.slice(0, 12);
  ctx.font = `bold 6px ${fontMono}`;
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(50, 55, 65, 0.72)';
  ctx.fillRect(base.px - tw / 2 - 3, base.py - ISO_WALL_H - 14, tw + 6, 10);
  ctx.fillStyle = '#E8ECF0';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, base.px, base.py - ISO_WALL_H - 9);
}
