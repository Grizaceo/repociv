import type { LocalRoom } from './types.ts';

export const EXT_COLOR: Record<string, string> = {
  ts: '#4a9bd4',
  tsx: '#4a9bd4',
  js: '#e8c44a',
  jsx: '#e8c44a',
  py: '#4ab4d4',
  rs: '#b4a04a',
  go: '#4ad4b4',
  json: '#a04ab4',
  md: '#b4a04a',
  css: '#4ad44a',
  html: '#d44a4a',
  yaml: '#4a4ad4',
  yml: '#4a4ad4',
  sh: '#4ad4a0',
  bash: '#4ad4a0',
  toml: '#d4a04a',
  png: '#888',
  svg: '#888',
};

export function adjustBrightness(hex: string, delta: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, v + delta));
  const toHex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${toHex(clamp(r))}${toHex(clamp(g))}${toHex(clamp(b))}`;
}

export interface Local2DAssetState {
  ctx: CanvasRenderingContext2D;
  fontMono: string;
  tileSize: number;
}

export function drawWindowTile(state: Local2DAssetState, px: number, py: number, s: number) {
  const { ctx } = state;
  ctx.fillStyle = '#D0D0D0';
  ctx.fillRect(px + 1, py + 1, s - 2, s - 2);
  ctx.strokeStyle = '#F5E6D3';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 1, py + 1, s - 2, s - 2);

  const skyGrad = ctx.createLinearGradient(px, py, px, py + s);
  skyGrad.addColorStop(0, 'rgba(186, 230, 253, 0.6)');
  skyGrad.addColorStop(0.5, 'rgba(224, 242, 254, 0.4)');
  skyGrad.addColorStop(1, 'rgba(255, 250, 245, 0.3)');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(px + 4, py + 4, s - 8, s - 8);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px + s / 2, py + 4);
  ctx.lineTo(px + s / 2, py + s - 4);
  ctx.moveTo(px + 4, py + s / 2);
  ctx.lineTo(px + s - 4, py + s / 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(248, 187, 208, 0.7)';
  ctx.fillRect(px + 2, py + 2, 5, s - 4);
  ctx.fillRect(px + s - 7, py + 2, 5, s - 4);

  ctx.fillStyle = 'rgba(212, 165, 116, 0.6)';
  ctx.fillRect(px + 5, py + s / 2 - 2, 3, 4);
  ctx.fillRect(px + s - 8, py + s / 2 - 2, 3, 4);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.beginPath();
  ctx.moveTo(px + 4, py + 4);
  ctx.lineTo(px + s / 2 - 3, py + 4);
  ctx.lineTo(px + 4, py + s / 2 - 3);
  ctx.closePath();
  ctx.fill();
}

export function drawSofaTile(state: Local2DAssetState, px: number, py: number, s: number) {
  const { ctx } = state;
  ctx.fillStyle = '#B08090';
  ctx.beginPath();
  ctx.roundRect(px + 2, py + 6, s - 4, s - 8, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(248, 187, 208, 0.5)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = '#FCE4EC';
  ctx.beginPath();
  ctx.roundRect(px + 4, py + 10, s - 8, s - 14, 2);
  ctx.fill();
  ctx.fillStyle = '#B08090';
  ctx.beginPath();
  ctx.roundRect(px + 3, py + 6, s - 6, 5, 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(px + 5, py + 8, s - 10, 1.5);
  ctx.fillStyle = '#A07080';
  ctx.beginPath();
  ctx.roundRect(px + 2, py + 8, 3, 8, 1.5);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(px + s - 5, py + 8, 3, 8, 1.5);
  ctx.fill();
}

export function drawWatercoolerTile(state: Local2DAssetState, px: number, py: number, s: number) {
  const { ctx } = state;
  ctx.fillStyle = '#E3F2FD';
  ctx.beginPath();
  ctx.roundRect(px + s / 2 - 4, py + s - 8, 8, 6, 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(180, 200, 220, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = 'rgba(186, 230, 253, 0.4)';
  ctx.beginPath();
  ctx.ellipse(px + s / 2, py + s / 2 + 2, 5, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(186, 230, 253, 0.6)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = 'rgba(186, 230, 253, 0.6)';
  ctx.beginPath();
  ctx.ellipse(px + s / 2, py + s / 2 + 4, 4, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#D0D0D0';
  ctx.beginPath();
  ctx.roundRect(px + s - 7, py + s - 6, 3, 4, 1);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 200, 200, 0.3)';
  ctx.stroke();
  const now = performance.now();
  ctx.fillStyle = `rgba(186, 230, 253, ${0.15 + 0.08 * Math.sin(now / 400)})`;
  ctx.beginPath();
  ctx.arc(px + s / 2, py + s / 2 + 2, 10, 0, Math.PI * 2);
  ctx.fill();
}

export function drawRoomLabel(state: Local2DAssetState, room: LocalRoom) {
  const { ctx, fontMono, tileSize } = state;
  const px = room.x * tileSize;
  const py = room.y * tileSize;
  const pw = room.width * tileSize;

  const primary = (room.zoneLabel ?? room.folderName).toUpperCase();
  const secondary = room.zoneLabel ? room.folderName.toUpperCase() : '';
  ctx.save();

  const zoneColors: Record<string, string> = {
    team_cluster: '#F5D0C5',
    meeting: '#B09060',
    focus: '#E8F5D6',
    break: '#D0C0A0',
    infra: '#E2E8F0',
    reception: '#F5F0E8',
    biophilic: '#D4E8D0',
  };
  const plaqueColor = zoneColors[room.zoneType ?? 'team_cluster'] ?? '#F5D0C5';

  ctx.fillStyle = plaqueColor;
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 0.5;

  const plaqueW = Math.min(pw - 4, Math.max(80, primary.length * 7 + 12));
  ctx.beginPath();
  ctx.moveTo(px + 4, py + 2);
  ctx.lineTo(px + plaqueW, py + 2);
  ctx.lineTo(px + plaqueW + 2, py + 4);
  ctx.lineTo(px + plaqueW + 2, py + 14);
  ctx.lineTo(px + plaqueW, py + 16);
  ctx.lineTo(px + 4, py + 16);
  ctx.lineTo(px + 2, py + 14);
  ctx.lineTo(px + 2, py + 4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.font = `bold 9px ${fontMono}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#5C4033';
  ctx.fillText(primary.slice(0, 12), px + 6, py + 4);

  if (secondary) {
    ctx.font = `7px ${fontMono}`;
    ctx.fillStyle = 'rgba(92, 64, 51, 0.6)';
    ctx.fillText(secondary.slice(0, 14), px + 6, py + 18);
  }

  ctx.restore();
}
