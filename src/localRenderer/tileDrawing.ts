// ─── Tile rendering (floor, walls, iso tiles, canvas drawing) ──────────────
import type { LocalTile, LocalUnit, LocalWorld } from '../types.ts';
import {
  EXT_COLOR,
  adjustBrightness as _adjustBrightness,
  drawSofaTile as drawSofaTileModule,
  drawWatercoolerTile as drawWatercoolerTileModule,
  drawWindowTile as drawWindowTileModule,
} from '../local2dAssets.ts';

const TILE_SIZE = 32;

// ─── Floor Background ──────────────────────────────────────────────────────

export function drawFloorBackground(
  ctx: CanvasRenderingContext2D,
  tile: LocalTile,
  px: number,
  py: number,
  s: number,
  inRoom: boolean,
  zone?: string,
): void {
  if (!inRoom) {
    const isAvenue = tile.type === 'path';
    const brightness = ((tile.x * 7 + tile.y * 3) % 5) - 2;
    let baseR = isAvenue ? 253 : 252;
    let baseG = isAvenue ? 246 : 244;
    let baseB = isAvenue ? 236 : 234;
    baseR += brightness * 1.5;
    baseG += brightness * 1.5;
    baseB += brightness * 1.5;
    ctx.fillStyle = `rgb(${Math.round(baseR)},${Math.round(baseG)},${Math.round(baseB)})`;
    ctx.fillRect(px, py, s, s);
    ctx.strokeStyle = 'rgba(220, 200, 190, 0.25)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
    if (isAvenue) {
      ctx.fillStyle = 'rgba(245, 208, 197, 0.2)';
      ctx.fillRect(px + s / 2 - 2, py, 4, s);
    }
    return;
  }

  const baseColors: Record<string, string> = {
    team_cluster: '#F5D0C5',
    meeting: '#B09060',
    focus: '#E8F5D6',
    break: '#D0C0A0',
    infra: '#E2E8F0',
    reception: '#F5F0E8',
    biophilic: '#D4E8D0',
  };
  const baseColor = baseColors[zone ?? 'team_cluster'] ?? '#F5D0C5';
  const delta = ((tile.x * 7 + tile.y * 3) % 5) * 2 - 4;
  ctx.fillStyle = _adjustBrightness(baseColor, delta);
  ctx.fillRect(px, py, s, s);
  ctx.strokeStyle = 'rgba(200, 180, 170, 0.15)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);

  if (zone === 'team_cluster' && (tile.x + tile.y) % 2 === 0) {
    ctx.fillStyle = 'rgba(252, 232, 224, 0.4)';
    ctx.fillRect(px + 2, py + 2, s - 4, s - 4);
  }
  if (zone === 'meeting') {
    ctx.strokeStyle = 'rgba(180, 150, 120, 0.12)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(px + s / 3, py);
    ctx.lineTo(px + s / 3, py + s);
    ctx.moveTo(px + (2 * s) / 3, py);
    ctx.lineTo(px + (2 * s) / 3, py + s);
    ctx.stroke();
  }
  if (zone === 'focus') {
    ctx.fillStyle = 'rgba(168, 213, 162, 0.15)';
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 2; c++) ctx.fillRect(px + 6 + c * 14, py + 6 + r * 14, 3, 3);
  }
  if (zone === 'break') {
    ctx.strokeStyle = 'rgba(220, 190, 140, 0.15)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(px + s / 2, py);
    ctx.lineTo(px + s / 2, py + s);
    ctx.moveTo(px, py + s / 2);
    ctx.lineTo(px + s, py + s / 2);
    ctx.stroke();
  }
  if (zone === 'infra') {
    ctx.strokeStyle = 'rgba(160, 170, 185, 0.2)';
    ctx.beginPath();
    ctx.moveTo(px + s / 2, py);
    ctx.lineTo(px + s / 2, py + s);
    ctx.moveTo(px, py + s / 2);
    ctx.lineTo(px + s, py + s / 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(160, 170, 185, 0.25)';
    ctx.fillRect(px + s / 2 - 1, py + s / 2 - 1, 2, 2);
  }
  if (zone === 'reception') {
    ctx.strokeStyle = 'rgba(200, 190, 180, 0.1)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(px + 4, py + s - 4);
    ctx.quadraticCurveTo(px + s / 2, py + s / 2, px + s - 4, py + 4);
    ctx.stroke();
  }
  if (zone === 'biophilic') {
    ctx.fillStyle = 'rgba(168, 213, 162, 0.1)';
    ctx.beginPath();
    ctx.arc(px + s / 2, py + s / 2, s * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
}

// ─── Path Background ──────────────────────────────────────────────────────

export function drawPathBackground(
  ctx: CanvasRenderingContext2D,
  tile: LocalTile,
  px: number,
  py: number,
  s: number,
  getTileFn: (dx: number, dy: number) => import('../types.ts').LocalTile | null,
  fontMono: string,
): void {
  const brightness = ((tile.x * 7 + tile.y * 3) % 7) - 3;
  let baseR = 253,
    baseG = 245,
    baseB = 235;
  baseR += brightness * 1.5;
  baseG += brightness * 1.5;
  baseB += brightness * 1.5;
  ctx.fillStyle = `rgb(${Math.round(baseR)},${Math.round(baseG)},${Math.round(baseB)})`;
  ctx.fillRect(px, py, s, s);
  ctx.strokeStyle = 'rgba(220, 200, 190, 0.25)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  for (let i = 2; i < s; i += 4) {
    ctx.moveTo(px + i, py + 2);
    ctx.lineTo(px + i, py + s - 2);
  }
  ctx.stroke();

  ctx.fillStyle = 'rgba(245, 208, 197, 0.18)';
  ctx.fillRect(px + s / 2 - 2, py, 4, s);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(px + s / 2 - 1, py, 2, s);

  const lightX = px + s / 2;
  const lightY = py + s / 2;
  const lightGrad = ctx.createRadialGradient(lightX, lightY, 0, lightX, lightY, s * 0.7);
  lightGrad.addColorStop(0, 'rgba(255, 248, 240, 0.1)');
  lightGrad.addColorStop(1, 'rgba(255, 248, 240, 0)');
  ctx.fillStyle = lightGrad;
  ctx.fillRect(px, py, s, s);

  if ((tile.x + tile.y * 3) % 11 === 0) {
    ctx.fillStyle = 'rgba(212, 165, 116, 0.2)';
    ctx.font = `bold ${s * 0.2}px ${fontMono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▸', px + s / 2, py + s / 2);
  }

  const warmShadow = 'rgba(180, 150, 130, 0.1)';
  const wallNearby = (dx: number, dy: number) => {
    const t = getTileFn(tile.x + dx, tile.y + dy);
    return t?.type === 'wall' || t?.type === 'door';
  };
  if (wallNearby(0, -1)) {
    const shadowGrad = ctx.createLinearGradient(px, py + 5, px, py);
    shadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
    shadowGrad.addColorStop(1, warmShadow);
    ctx.fillStyle = shadowGrad;
    ctx.fillRect(px, py, s, 5);
  }
  if (wallNearby(0, 1)) {
    const shadowGrad = ctx.createLinearGradient(px, py + s - 5, px, py + s);
    shadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
    shadowGrad.addColorStop(1, warmShadow);
    ctx.fillStyle = shadowGrad;
    ctx.fillRect(px, py + s - 5, s, 5);
  }
  if (wallNearby(-1, 0)) {
    const shadowGrad = ctx.createLinearGradient(px + 5, py, px, py);
    shadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
    shadowGrad.addColorStop(1, warmShadow);
    ctx.fillStyle = shadowGrad;
    ctx.fillRect(px, py, 5, s);
  }
  if (wallNearby(1, 0)) {
    const shadowGrad = ctx.createLinearGradient(px + s - 5, py, px + s, py);
    shadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
    shadowGrad.addColorStop(1, warmShadow);
    ctx.fillStyle = shadowGrad;
    ctx.fillRect(px + s - 5, py, 5, s);
  }
}

// ─── Wall Facade ───────────────────────────────────────────────────────────

export function drawWallFacade(
  ctx: CanvasRenderingContext2D,
  tile: LocalTile,
  px: number,
  py: number,
  s: number,
  zone: string | undefined,
  getTileFn: (x: number, y: number) => import('../types.ts').LocalTile | null,
): void {
  const isOpen = (x: number, y: number) => {
    const t = getTileFn(x, y);
    return (
      t !== null &&
      (t.type === 'floor' ||
        t.type === 'door' ||
        t.type === 'path' ||
        t.type === 'workbench' ||
        t.type === 'kiosk')
    );
  };
  const north = isOpen(tile.x, tile.y - 1);
  const south = isOpen(tile.x, tile.y + 1);
  const east = isOpen(tile.x + 1, tile.y);
  const west = isOpen(tile.x - 1, tile.y);
  const isCorner = (east && south) || (east && north) || (west && south) || (west && north);
  const isGlass = zone === 'team_cluster' || zone === 'meeting';
  const isAcoustic = zone === 'focus';
  const isWood = zone === 'break' || zone === 'biophilic';
  const isConcrete = zone === 'infra';

  if (isCorner) {
    ctx.fillStyle = isConcrete ? '#E2E8F0' : isWood ? '#F5E6D3' : '#FDFBF7';
    ctx.fillRect(px, py, s, s);
    ctx.fillStyle = isConcrete ? '#E8EDF2' : isWood ? '#FAF0E6' : '#D0D0D0';
    ctx.fillRect(px + 3, py + 3, s - 6, s - 6);
    ctx.strokeStyle = 'rgba(200, 190, 180, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px + 3, py + 3, s - 6, s - 6);
  } else {
    if (isGlass) {
      ctx.fillStyle = 'rgba(200, 230, 255, 0.2)';
      ctx.fillRect(px, py, s, s);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(px + 1, py + s / 2 - 2, s - 2, 4);
    } else if (isAcoustic) {
      ctx.fillStyle = '#B0C0B0';
      ctx.fillRect(px, py, s, s);
      ctx.fillStyle = 'rgba(168, 213, 162, 0.3)';
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++) {
          ctx.beginPath();
          ctx.arc(px + 6 + c * 8, py + 6 + r * 8, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      ctx.strokeStyle = 'rgba(200, 220, 200, 0.4)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
    } else if (isWood) {
      ctx.fillStyle = '#F5E6D3';
      ctx.fillRect(px, py, s, s);
      ctx.strokeStyle = 'rgba(200, 170, 140, 0.3)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(px + s / 3, py);
      ctx.lineTo(px + s / 3, py + s);
      ctx.moveTo(px + (2 * s) / 3, py);
      ctx.lineTo(px + (2 * s) / 3, py + s);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(200, 170, 140, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
    } else {
      ctx.fillStyle = isConcrete ? '#D8DCE0' : '#FDFBF7';
      ctx.fillRect(px, py, s, s);
      ctx.strokeStyle = 'rgba(220, 210, 200, 0.25)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(px, py + s / 2);
      ctx.lineTo(px + s, py + s / 2);
      ctx.stroke();
    }
  }

  const moldingColor = isWood ? '#B09060' : isGlass ? '#E0E8F0' : '#F5E6D3';
  ctx.fillStyle = moldingColor;
  ctx.fillRect(px, py + s - 3, s, 3);

  if (east) {
    const shadowGrad = ctx.createLinearGradient(px + s - 4, py, px + s, py);
    shadowGrad.addColorStop(0, 'rgba(180, 150, 130, 0)');
    shadowGrad.addColorStop(1, 'rgba(180, 150, 130, 0.12)');
    ctx.fillStyle = shadowGrad;
    ctx.fillRect(px + s - 4, py, 4, s);
  }
  if (south) {
    const shadowGrad = ctx.createLinearGradient(px, py + s - 4, px, py + s);
    shadowGrad.addColorStop(0, 'rgba(180, 150, 130, 0)');
    shadowGrad.addColorStop(1, 'rgba(180, 150, 130, 0.12)');
    ctx.fillStyle = shadowGrad;
    ctx.fillRect(px, py + s - 4, s, 4);
  }
  ctx.strokeStyle = isGlass ? 'rgba(148,163,184,0.4)' : '#1d1a17';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
}

// ─── Door Tile (static) ────────────────────────────────────────────────────

export function drawDoorTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
  zone?: string,
): void {
  const isGlass = zone === 'team_cluster' || zone === 'meeting';
  ctx.fillStyle = isGlass ? 'rgba(200, 230, 255, 0.4)' : '#F5E6D3';
  ctx.fillRect(px, py, 4, s);
  ctx.fillRect(px + s - 4, py, 4, s);
  if (isGlass) {
    ctx.fillStyle = 'rgba(220, 240, 255, 0.35)';
    ctx.fillRect(px + 4, py + s / 2 - 3, s - 8, 6);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px + 4, py + s / 2 - 3, s - 8, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(px + 4, py + s / 2 - 1, s - 8, 2);
  } else {
    ctx.fillStyle = '#B09060';
    ctx.fillRect(px + 4, py + s / 2 - 3, s - 8, 6);
    ctx.strokeStyle = 'rgba(200, 170, 140, 0.5)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px + 4, py + s / 2 - 3, s - 8, 6);
  }
  ctx.fillStyle = isGlass ? '#E0E8F0' : '#A07840';
  ctx.fillRect(px + s / 2 - 2, py + s / 2 - 1, 4, 2);
}

// ─── Debris Tile ───────────────────────────────────────────────────────────

export function drawDebrisTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.fillRect(px + 4, py + 4, s - 8, s - 8);
  ctx.fillStyle = '#443d35';
  ctx.fillRect(px + 6, py + 8, 4, 3);
  ctx.fillStyle = '#5e544b';
  ctx.fillRect(px + 14, py + 10, 5, 4);
  ctx.fillStyle = '#3a342f';
  ctx.fillRect(px + 10, py + 18, 6, 3);
  ctx.strokeStyle = '#2d2722';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px + 4, py + 4);
  ctx.lineTo(px + 12, py + 12);
  ctx.lineTo(px + s - 6, py + s - 10);
  ctx.stroke();
}

// ─── Kiosk Tile ────────────────────────────────────────────────────────────

export function drawKioskTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
  fontMono: string,
): void {
  ctx.fillStyle = '#F5E6D3';
  ctx.beginPath();
  ctx.roundRect(px + 4, py + 6, s - 8, s - 12, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 170, 140, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = '#B09060';
  ctx.fillRect(px + 8, py + s - 10, s - 16, 2);
  ctx.fillStyle = '#D8DCE0';
  ctx.beginPath();
  ctx.roundRect(px + 6, py + 8, s - 12, 10, 1);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
  ctx.stroke();
  ctx.fillStyle = 'rgba(212, 165, 116, 0.8)';
  ctx.font = `bold 6px ${fontMono}`;
  ctx.fillText('SYS', px + 10, py + 14);
}

// ─── Workbench Tile ────────────────────────────────────────────────────────

export function drawWorkbenchTile(
  ctx: CanvasRenderingContext2D,
  wb: { extension: string; isTest?: boolean; fileName?: string },
  px: number,
  py: number,
  s: number,
  fontMono: string,
): void {
  ctx.fillStyle = '#B09060';
  ctx.beginPath();
  ctx.roundRect(px + 3, py + 4, s - 6, 16, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 170, 140, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = '#E2E8F0';
  ctx.fillRect(px + s / 2 - 2, py + 14, 4, 3);
  ctx.fillStyle = '#D0D0D0';
  ctx.beginPath();
  ctx.roundRect(px + 5, py + 5, s - 10, 10, 1);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = 'rgba(140, 170, 190, 0.3)';
  ctx.fillRect(px + 6, py + 6, s - 12, 8);

  const extColor = EXT_COLOR[wb.extension] ?? '#888';
  ctx.fillStyle = extColor;
  ctx.font = `bold 7px ${fontMono}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(wb.extension.toUpperCase().slice(0, 3), px + s / 2, py + 10);

  ctx.fillStyle = '#E2E8F0';
  ctx.fillRect(px + 9, py + 21, s - 18, 3);
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(px + 9.5, py + 21.5, s - 19, 2);

  if (wb.isTest) {
    ctx.fillStyle = '#A07840';
    ctx.beginPath();
    ctx.arc(px + s - 7, py + 7, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  const chairX = px + s / 2;
  const chairY = py + s - 6;
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(chairX, chairY);
  ctx.lineTo(chairX - 3, chairY + 3);
  ctx.moveTo(chairX, chairY);
  ctx.lineTo(chairX + 3, chairY + 3);
  ctx.stroke();
  ctx.fillStyle = '#B08090';
  ctx.beginPath();
  ctx.arc(chairX, chairY, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(248, 187, 208, 0.5)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

// ─── Power Source Tile ─────────────────────────────────────────────────────

export function drawPowerSourceTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
  fontMono: string,
): void {
  const centerX = px + s / 2;
  const centerY = py + s / 2;
  ctx.fillStyle = '#D8DCE0';
  ctx.beginPath();
  ctx.roundRect(px + 3, py + 3, s - 6, s - 6, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.4)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(px + 6, py + 8 + i * 4);
    ctx.lineTo(px + s - 6, py + 8 + i * 4);
    ctx.stroke();
  }
  const now = performance.now();
  const pulse = 0.5 + 0.5 * Math.sin(now / 400);
  ctx.fillStyle = `rgba(168, 213, 162, ${0.5 + 0.2 * pulse})`;
  ctx.beginPath();
  ctx.arc(centerX, centerY + 4, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(180, 190, 200, 0.6)';
  ctx.font = `bold 6px ${fontMono}`;
  ctx.textAlign = 'center';
  ctx.fillText('PWR', centerX, centerY - 4);
}

// ─── Power Consumer Tile ───────────────────────────────────────────────────

export function drawPowerConsumerTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  ctx.fillStyle = '#E2E8F0';
  ctx.beginPath();
  ctx.roundRect(px + s / 2 - 5, py + s / 2 - 5, 10, 10, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  const now = performance.now();
  ctx.fillStyle = now % 1000 < 500 ? 'rgba(168, 213, 162, 0.6)' : 'rgba(180, 190, 200, 0.3)';
  ctx.beginPath();
  ctx.arc(px + s / 2, py + s / 2, 2, 0, Math.PI * 2);
  ctx.fill();
}

// ─── Bed Tile ──────────────────────────────────────────────────────────────

export function drawBedTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  const frameColor = '#B09060';
  const sheetColor = '#D0D0D0';
  const blanketColor = '#FCE4EC';

  ctx.fillStyle = frameColor;
  ctx.beginPath();
  ctx.roundRect(px + 2, py + 2, s - 4, 3, 1);
  ctx.fill();
  ctx.fillStyle = frameColor;
  ctx.beginPath();
  ctx.arc(px + 2, py + 3, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px + s - 2, py + 3, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = sheetColor;
  ctx.beginPath();
  ctx.roundRect(px + 3, py + 5, s - 6, s - 8, 2);
  ctx.fill();
  ctx.fillStyle = '#D0D0D0';
  ctx.beginPath();
  ctx.roundRect(px + 5, py + 6, s - 10, 4, 1);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 200, 200, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = blanketColor;
  ctx.beginPath();
  ctx.roundRect(px + 3, py + s - 14, s - 6, 10, 2);
  ctx.fill();
  ctx.fillStyle = '#B08090';
  ctx.fillRect(px + 3, py + s - 14, s - 6, 2);
  ctx.fillStyle = frameColor;
  ctx.beginPath();
  ctx.roundRect(px + 2, py + s - 3, s - 4, 2, 1);
  ctx.fill();
}

// ─── Heater Tile ───────────────────────────────────────────────────────────

export function drawHeaterTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  ctx.fillStyle = '#FAF0E6';
  ctx.beginPath();
  ctx.roundRect(px + 4, py + 4, s - 8, s - 8, 3);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 180, 160, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  const now = performance.now();
  const glowIntensity = 0.3 + 0.15 * Math.sin(now / 200);
  ctx.fillStyle = `rgba(255, 200, 150, ${glowIntensity})`;
  ctx.fillRect(px + 7, py + 7, s - 14, s - 14);
  ctx.strokeStyle = 'rgba(200, 180, 160, 0.4)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const gx = px + 8 + i * 4;
    ctx.beginPath();
    ctx.moveTo(gx, py + 7);
    ctx.lineTo(gx, py + s - 7);
    ctx.stroke();
  }
}

// ─── Cooler Tile ───────────────────────────────────────────────────────────

export function drawCoolerTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  const centerX = px + s / 2;
  const centerY = py + s / 2;
  ctx.fillStyle = '#D8DCE0';
  ctx.beginPath();
  ctx.roundRect(px + 4, py + 4, s - 8, s - 8, 3);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = '#E2E8F0';
  ctx.beginPath();
  ctx.arc(centerX, centerY, 8, 0, Math.PI * 2);
  ctx.fill();
  const now = performance.now();
  const angle = (now / 150) % (Math.PI * 2);
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.6)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const bladeAngle = angle + (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.lineTo(centerX + Math.cos(bladeAngle) * 6, centerY + Math.sin(bladeAngle) * 6);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(186, 230, 253, 0.6)';
  ctx.beginPath();
  ctx.arc(px + 7, py + 7, 1.5, 0, Math.PI * 2);
  ctx.fill();
}

// ─── Vent Tile ─────────────────────────────────────────────────────────────

export function drawVentTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
  fontMono: string,
): void {
  const centerX = px + s / 2;
  const centerY = py + s / 2;
  ctx.fillStyle = '#D8DCE0';
  ctx.beginPath();
  ctx.roundRect(px + 2, py + 2, s - 4, s - 4, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = 'rgba(180, 190, 200, 0.4)';
  for (let i = 0; i < 4; i++) ctx.fillRect(px + 5, py + 5 + i * 5, s - 10, 2);
  const now = performance.now();
  ctx.fillStyle = `rgba(168, 213, 162, ${0.4 + 0.2 * Math.sin(now / 200)})`;
  ctx.font = `${s * 0.22}px ${fontMono}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('↔', centerX, centerY);
}

// ─── Office Furniture Tiles ────────────────────────────────────────────────

export function drawStandingDeskTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  ctx.fillStyle = '#B09060';
  ctx.beginPath();
  ctx.roundRect(px + 2, py + 4, s - 4, 10, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 170, 140, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = '#D8DCE0';
  ctx.beginPath();
  ctx.roundRect(px + 5, py + 2, s - 10, 7, 1);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = 'rgba(140, 170, 190, 0.3)';
  ctx.fillRect(px + 6, py + 3, s - 12, 5);
  ctx.fillStyle = '#608860';
  ctx.beginPath();
  ctx.arc(px + s - 5, py + 12, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#B09060';
  ctx.beginPath();
  ctx.arc(px + s - 5, py + 14, 2, 0, Math.PI);
  ctx.fill();
}

export function drawPhoneBoothTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  ctx.fillStyle = '#B0C0B0';
  ctx.beginPath();
  ctx.roundRect(px + 3, py + 3, s - 6, s - 6, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(168, 213, 162, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(168, 213, 162, 0.25)';
  ctx.lineWidth = 0.5;
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(px + 5, py + 5 + i * 7);
    ctx.lineTo(px + s - 5, py + 5 + i * 7);
    ctx.stroke();
  }
  ctx.fillStyle = '#F5E6D3';
  ctx.beginPath();
  ctx.roundRect(px + 6, py + s - 10, s - 12, 4, 1);
  ctx.fill();
  const now = performance.now();
  ctx.fillStyle = now % 2000 < 1000 ? '#608860' : '#D4E8D0';
  ctx.beginPath();
  ctx.arc(px + s / 2, py + 6, 2, 0, Math.PI * 2);
  ctx.fill();
}

export function drawBreakAreaTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  ctx.fillStyle = '#FAF0E6';
  ctx.beginPath();
  ctx.roundRect(px + 2, py + 10, s - 4, s - 12, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 180, 160, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = '#F5E6D3';
  ctx.fillRect(px + 1, py + 8, s - 2, 4);
  ctx.fillStyle = '#D8DCE0';
  ctx.beginPath();
  ctx.roundRect(px + 4, py + 2, 8, 8, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.4)';
  ctx.stroke();
  const now = performance.now();
  ctx.fillStyle = `rgba(212, 165, 116, ${0.4 + 0.2 * Math.sin(now / 300)})`;
  ctx.fillRect(px + 6, py + 4, 2, 2);
  ctx.fillStyle = '#E2E8F0';
  ctx.beginPath();
  ctx.roundRect(px + s - 10, py + 3, 7, 6, 1);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
  ctx.stroke();
}

export function drawMeetingRoomTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  ctx.fillStyle = 'rgba(232, 197, 150, 0.5)';
  ctx.beginPath();
  ctx.ellipse(px + s / 2, py + s / 2, (s - 8) / 2, (s - 12) / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 170, 140, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = '#B09060';
  ctx.beginPath();
  ctx.roundRect(px + 8, py + s - 6, 3, 4, 1);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(px + s - 11, py + s - 6, 3, 4, 1);
  ctx.fill();
  ctx.fillStyle = '#D0C0A0';
  ctx.beginPath();
  ctx.roundRect(px + 2, py + s / 2 - 3, 4, 6, 2);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(px + s - 6, py + s / 2 - 3, 4, 6, 2);
  ctx.fill();
  ctx.fillStyle = '#D0D0D0';
  ctx.beginPath();
  ctx.arc(px + s / 2, py + s / 2 + 2, 2, 0, Math.PI * 2);
  ctx.fill();
}

export function drawWhiteboardTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  ctx.fillStyle = '#D0D0D0';
  ctx.beginPath();
  ctx.roundRect(px + 2, py + 3, s - 4, s - 6, 3);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 190, 180, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  const colors = [
    'rgba(248, 187, 208, 0.4)',
    'rgba(168, 213, 162, 0.4)',
    'rgba(186, 230, 253, 0.4)',
  ];
  ctx.lineWidth = 0.5;
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = colors[i]!;
    ctx.beginPath();
    ctx.moveTo(px + 5, py + 7 + i * 5);
    ctx.lineTo(px + s - 5 - i * 2, py + 7 + i * 5 + (i % 2));
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(248, 187, 208, 0.6)';
  ctx.fillRect(px + s - 8, py + 5, 4, 4);
  ctx.fillStyle = 'rgba(168, 213, 162, 0.6)';
  ctx.fillRect(px + s - 8, py + 11, 4, 4);
  ctx.fillStyle = '#F5E6D3';
  ctx.beginPath();
  ctx.roundRect(px + 3, py + s - 5, s - 6, 3, 1);
  ctx.fill();
}

export function drawServerRackTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(px + 2, py + 2, s - 4, s - 4);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 2, py + 2, s - 4, s - 4);
  const now = performance.now();
  for (let i = 0; i < 4; i++) {
    const ry = py + 4 + i * 7;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(px + 4, ry, s - 8, 5);
    const ledColors = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444'];
    for (let j = 0; j < 3; j++) {
      const blink = Math.sin(now / 200 + i * 3 + j * 2) > 0;
      ctx.fillStyle = blink ? ledColors[(i + j) % ledColors.length]! : '#1e293b';
      ctx.fillRect(px + 6 + j * 7, ry + 1.5, 3, 2);
    }
  }
  ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(px + 4, py + s - 4);
  ctx.lineTo(px + s / 2, py + s - 1);
  ctx.lineTo(px + s - 4, py + s - 4);
  ctx.stroke();
}

export function drawPlanterTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  ctx.fillStyle = '#B09060';
  ctx.beginPath();
  ctx.moveTo(px + 5, py + s - 3);
  ctx.lineTo(px + s - 5, py + s - 3);
  ctx.lineTo(px + s - 4, py + s - 10);
  ctx.lineTo(px + 4, py + s - 10);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 170, 140, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = '#608860';
  ctx.beginPath();
  ctx.ellipse(px + s / 2, py + s / 2 - 2, s * 0.32, s * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#90B090';
  ctx.beginPath();
  ctx.ellipse(px + s / 2 - 2, py + s / 2 - 5, s * 0.2, s * 0.18, -0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#D4E8D0';
  ctx.beginPath();
  ctx.ellipse(px + s / 2 + 3, py + s / 2 - 3, s * 0.12, s * 0.1, 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(180, 150, 130, 0.1)';
  ctx.beginPath();
  ctx.ellipse(px + s / 2, py + s - 2, s * 0.25, 2, 0, 0, Math.PI * 2);
  ctx.fill();
}

export function drawReceptionTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  ctx.fillStyle = '#B09060';
  ctx.beginPath();
  ctx.moveTo(px + 4, py + s - 4);
  ctx.lineTo(px + s - 4, py + s - 4);
  ctx.lineTo(px + s - 5, py + 10);
  ctx.quadraticCurveTo(px + s / 2, py + 4, px + 5, py + 10);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 170, 140, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = '#FAF0E6';
  ctx.beginPath();
  ctx.moveTo(px + 3, py + s - 4);
  ctx.lineTo(px + s - 3, py + s - 4);
  ctx.lineTo(px + s - 4, py + 10);
  ctx.quadraticCurveTo(px + s / 2, py + 5, px + 4, py + 10);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#D8DCE0';
  ctx.beginPath();
  ctx.roundRect(px + s / 2 - 3, py + 8, 6, 5, 1);
  ctx.fill();
  ctx.fillStyle = 'rgba(186, 230, 253, 0.6)';
  ctx.fillRect(px + s / 2 - 2, py + 9, 4, 3);
}

export function drawStairsTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  const steps = 4;
  const stepH = (s - 4) / steps;
  for (let i = 0; i < steps; i++) {
    const sy = py + 2 + i * stepH;
    ctx.fillStyle = `rgb(${232 + i * 3},${197 + i * 2},${150 + i * 2})`;
    ctx.fillRect(px + 2, sy, s - 4, stepH - 0.5);
    ctx.strokeStyle = 'rgba(200, 170, 140, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(px + 2, sy + stepH - 0.5);
    ctx.lineTo(px + s - 2, sy + stepH - 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px + s - 3, py + 2);
  ctx.lineTo(px + s - 3, py + s - 2);
  ctx.stroke();
}

// ─── Dynamic Tiles (doors, workbench glow) ──────────────────────────────────

export function drawDynamicDoorTile(
  ctx: CanvasRenderingContext2D,
  tile: LocalTile,
  dt: number,
  localUnits: LocalUnit[],
  world: LocalWorld | null,
  doorOpenStates: Map<string, number>,
): void {
  const px = tile.x * TILE_SIZE;
  const py = tile.y * TILE_SIZE;
  const s = TILE_SIZE;
  const key = `${tile.x},${tile.y}`;
  const room = tile.roomId ? world?.rooms.find((r) => r.id === tile.roomId) : undefined;
  const zone = room?.zoneType;
  const isGlass = zone === 'team_cluster' || zone === 'meeting';
  const dpx = px + s / 2;
  const dpy = py + s / 2;

  let minD = Infinity;
  for (const unit of localUnits) {
    let ux: number, uy: number;
    if (unit.path.length > 0 && unit.pathIndex < unit.path.length) {
      const from = unit.path[unit.pathIndex]!;
      const to = unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!;
      const t = unit.pathProgress;
      ux = (from.x + (to.x - from.x) * t) * TILE_SIZE + TILE_SIZE / 2;
      uy = (from.y + (to.y - from.y) * t) * TILE_SIZE + TILE_SIZE / 2;
    } else {
      ux = unit.gridX * TILE_SIZE + TILE_SIZE / 2;
      uy = unit.gridY * TILE_SIZE + TILE_SIZE / 2;
    }
    const d = Math.hypot(ux - dpx, uy - dpy) / TILE_SIZE;
    if (d < minD) minD = d;
  }

  const openPct = Math.max(0, Math.min(1, (1.8 - minD) * 1.5));
  let currentOpen = doorOpenStates.get(key) ?? 0;
  currentOpen = currentOpen + (openPct - currentOpen) * (1 - Math.exp(-dt * 12));
  doorOpenStates.set(key, currentOpen);

  const panelW = s / 2;
  const offset = panelW * currentOpen;

  ctx.save();
  if (isGlass) {
    ctx.fillStyle = 'rgba(220, 240, 255, 0.3)';
    ctx.fillRect(px - offset, py + 1, panelW, s - 2);
    ctx.fillRect(px + panelW + offset, py + 1, panelW, s - 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px - offset + 0.5, py + 1.5, panelW - 1, s - 3);
    ctx.strokeRect(px + panelW + offset + 0.5, py + 1.5, panelW - 1, s - 3);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(px - offset, py + s / 2 - 1, panelW, 2);
    ctx.fillRect(px + panelW + offset, py + s / 2 - 1, panelW, 2);
  } else {
    ctx.fillStyle = '#F5E6D3';
    ctx.fillRect(px - offset, py + 1, panelW, s - 2);
    ctx.strokeStyle = 'rgba(212, 165, 116, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px - offset + 0.5, py + 1.5, panelW - 1, s - 3);
    ctx.fillRect(px + panelW + offset, py + 1, panelW, s - 2);
    ctx.strokeRect(px + panelW + offset + 0.5, py + 1.5, panelW - 1, s - 3);
  }
  ctx.restore();
}

export function drawDynamicWorkbenchTile(
  ctx: CanvasRenderingContext2D,
  tile: LocalTile,
  localUnits: LocalUnit[],
  spawnSparkFn: (x: number, y: number, color: string) => void,
): void {
  const wb = tile.workbench;
  if (!wb) return;
  const activeUnit = localUnits.find(
    (u) => u.state === 'working_on_file' && u.currentWorkbenchId === wb.id,
  );
  if (!activeUnit) return;

  const px = tile.x * TILE_SIZE;
  const py = tile.y * TILE_SIZE;
  const s = TILE_SIZE;
  const now = performance.now();
  const extColor = EXT_COLOR[wb.extension] ?? '#888';

  ctx.save();
  ctx.shadowColor = extColor;
  ctx.shadowBlur = 10 + 4 * Math.sin(now / 250);
  ctx.fillStyle = '#0f0f12';
  ctx.fillRect(px + 6, py + 5, s - 12, 9);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(px + 6, py + 5, s - 12, 9);
  ctx.clip();
  ctx.fillStyle = extColor;
  ctx.globalAlpha = 0.75;
  const scrollY = (now / 35) % 6;
  for (let i = 0; i < 3; i++) {
    const ly = py + 6 + i * 4 - scrollY;
    if (ly >= py + 5 && ly <= py + 14) ctx.fillRect(px + 7, ly, s - 14, 1.5);
  }
  ctx.restore();

  if (Math.random() < 0.15) spawnSparkFn(px + s / 2, py + 15, extColor);
}

// ─── Main tile dispatcher ───────────────────────────────────────────────────

export interface TileDrawContext {
  ctx: CanvasRenderingContext2D;
  tokens: Record<string, string>;
  world: LocalWorld | null;
  getTileFn: (x: number, y: number) => import('../types.ts').LocalTile | null;
  localUnits: LocalUnit[];
  doorOpenStates: Map<string, number>;
  spawnSparkFn: (x: number, y: number, color: string) => void;
}

export function drawTileModule(
  ctx: CanvasRenderingContext2D,
  tile: LocalTile,
  d: TileDrawContext,
): void {
  const px = tile.x * TILE_SIZE;
  const py = tile.y * TILE_SIZE;
  const s = TILE_SIZE;
  const inRoom = tile.roomId !== null;
  const room = tile.roomId ? d.world?.rooms.find((r) => r.id === tile.roomId) : undefined;
  const zone = room?.zoneType;
  const fontMono = d.tokens.fontMono ?? "'JetBrains Mono', monospace";

  if (tile.type === 'floor') {
    drawFloorBackground(ctx, tile, px, py, s, inRoom, zone);
  } else if (tile.type === 'door') {
    drawFloorBackground(ctx, tile, px, py, s, inRoom, zone);
    drawDoorTile(ctx, px, py, s, zone);
  } else if (tile.type === 'path') {
    drawPathBackground(
      ctx,
      tile,
      px,
      py,
      s,
      (dx, dy) => d.getTileFn(tile.x + dx, tile.y + dy),
      fontMono,
    );
  } else if (tile.type === 'wall') {
    drawWallFacade(ctx, tile, px, py, s, zone, d.getTileFn);
  } else {
    if (inRoom) drawFloorBackground(ctx, tile, px, py, s, true, zone);
    else
      drawPathBackground(
        ctx,
        tile,
        px,
        py,
        s,
        (dx, dy) => d.getTileFn(tile.x + dx, tile.y + dy),
        fontMono,
      );

    switch (tile.type) {
      case 'debris':
        drawDebrisTile(ctx, px, py, s);
        break;
      case 'kiosk':
        drawKioskTile(ctx, px, py, s, fontMono);
        break;
      case 'workbench': {
        const room2 = tile.roomId ? d.world?.rooms.find((r) => r.id === tile.roomId) : undefined;
        if (!room2 || room2.workbenches.length < 3)
          drawWorkbenchTile(ctx, tile.workbench ?? { extension: '' }, px, py, s, fontMono);
        break;
      }
      case 'conduit':
        drawConduitTile(ctx, px, py, s);
        break;
      case 'power_source':
        drawPowerSourceTile(ctx, px, py, s, fontMono);
        break;
      case 'power_consumer':
        drawPowerConsumerTile(ctx, px, py, s);
        break;
      case 'bed':
        drawBedTile(ctx, px, py, s);
        break;
      case 'heater':
        drawHeaterTile(ctx, px, py, s);
        break;
      case 'cooler':
        drawCoolerTile(ctx, px, py, s);
        break;
      case 'vent':
        drawVentTile(ctx, px, py, s, fontMono);
        break;
      case 'standing_desk':
        drawStandingDeskTile(ctx, px, py, s);
        break;
      case 'phone_booth':
        drawPhoneBoothTile(ctx, px, py, s);
        break;
      case 'break_area':
        drawBreakAreaTile(ctx, px, py, s);
        break;
      case 'meeting_room':
        drawMeetingRoomTile(ctx, px, py, s);
        break;
      case 'whiteboard':
        drawWhiteboardTile(ctx, px, py, s);
        break;
      case 'server_rack':
        drawServerRackTile(ctx, px, py, s);
        break;
      case 'planter':
        drawPlanterTile(ctx, px, py, s);
        break;
      case 'reception':
        drawReceptionTile(ctx, px, py, s);
        break;
      case 'stairs':
        drawStairsTile(ctx, px, py, s);
        break;
      case 'window':
        drawWindowTileModule({ ctx, fontMono, tileSize: TILE_SIZE }, px, py, s);
        break;
      case 'sofa':
        drawSofaTileModule({ ctx, fontMono, tileSize: TILE_SIZE }, px, py, s);
        break;
      case 'watercooler':
        drawWatercoolerTileModule({ ctx, fontMono, tileSize: TILE_SIZE }, px, py, s);
        break;
    }
  }
}

// ─── Small utilities ────────────────────────────────────────────────────────

export function drawConduitTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  s: number,
): void {
  ctx.strokeStyle = 'rgba(217, 119, 6, 0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(px, py + s / 2);
  ctx.lineTo(px + s, py + s / 2);
  ctx.moveTo(px + s / 2, py);
  ctx.lineTo(px + s / 2, py + s);
  ctx.stroke();
  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(px + s / 2 - 2, py + s / 2 - 2, 4, 4);
}
