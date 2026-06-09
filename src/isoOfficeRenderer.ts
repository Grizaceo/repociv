export type IsoProjectFn = (x: number, y: number, z?: number) => { px: number; py: number };

export function darkenHex(hex: string, pct: number): string {
  if (!hex.startsWith('#') || hex.length !== 7) return hex;
  const f = (n: number) => Math.max(0, Math.min(255, Math.floor(n * (1 - pct / 100))));
  const r = f(parseInt(hex.slice(1, 3), 16));
  const g = f(parseInt(hex.slice(3, 5), 16));
  const b = f(parseInt(hex.slice(5, 7), 16));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export function drawIsoPrism(
  ctx: CanvasRenderingContext2D,
  cx: number,
  zBase: number,
  zTop: number,
  hw: number,
  hd: number,
  color: string,
  scale: number,
) {
  const bY = -zBase * scale;
  const tY = -zTop * scale;
  const bx1 = cx + hw * scale, by1 = bY;
  const bx2 = cx, by2 = bY + hd * scale;
  const bx3 = cx - hw * scale, by3 = bY;
  const tx0 = cx, ty0 = tY - hd * scale;
  const tx1 = cx + hw * scale, ty1 = tY;
  const tx2 = cx, ty2 = tY + hd * scale;
  const tx3 = cx - hw * scale, ty3 = tY;

  ctx.fillStyle = darkenHex(color, 20);
  ctx.beginPath();
  ctx.moveTo(bx3, by3);
  ctx.lineTo(bx2, by2);
  ctx.lineTo(tx2, ty2);
  ctx.lineTo(tx3, ty3);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = darkenHex(color, 10);
  ctx.beginPath();
  ctx.moveTo(bx2, by2);
  ctx.lineTo(bx1, by1);
  ctx.lineTo(tx1, ty1);
  ctx.lineTo(tx2, ty2);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tx0, ty0);
  ctx.lineTo(tx1, ty1);
  ctx.lineTo(tx2, ty2);
  ctx.lineTo(tx3, ty3);
  ctx.closePath();
  ctx.fill();
}

export function drawIsoSofa(ctx: CanvasRenderingContext2D, isoProject: IsoProjectFn, gx: number, gy: number) {
  const base = isoProject(gx, gy);
  ctx.fillStyle = '#B08090';
  ctx.beginPath();
  ctx.moveTo(base.px - 10, base.py);
  ctx.lineTo(base.px, base.py - 6);
  ctx.lineTo(base.px + 10, base.py);
  ctx.lineTo(base.px, base.py + 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#A07080';
  ctx.beginPath();
  ctx.moveTo(base.px - 8, base.py - 2);
  ctx.lineTo(base.px, base.py - 8);
  ctx.lineTo(base.px + 8, base.py - 2);
  ctx.lineTo(base.px, base.py + 4);
  ctx.closePath();
  ctx.fill();
}

export function drawIsoServerRack(ctx: CanvasRenderingContext2D, isoProject: IsoProjectFn, gx: number, gy: number) {
  const base = isoProject(gx, gy);
  const now = performance.now();
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(base.px - 8, base.py - 18, 16, 18);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(base.px - 8, base.py - 18, 16, 18);
  const ledColors = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444'];
  for (let i = 0; i < 3; i++) {
    const ry = base.py - 16 + i * 6;
    for (let j = 0; j < 3; j++) {
      const blink = Math.sin(now / 200 + i * 3 + j * 2) > 0;
      ctx.fillStyle = blink ? ledColors[(i + j) % ledColors.length]! : '#1e293b';
      ctx.fillRect(base.px - 6 + j * 5, ry, 3, 2);
    }
  }
}

export function drawIsoMeetingTable(ctx: CanvasRenderingContext2D, isoProject: IsoProjectFn, gx: number, gy: number) {
  const base = isoProject(gx, gy);
  ctx.fillStyle = 'rgba(232, 197, 150, 0.7)';
  ctx.beginPath();
  ctx.ellipse(base.px, base.py, 10, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 170, 140, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.fillStyle = '#D0C0A0';
  ctx.beginPath();
  ctx.ellipse(base.px - 12, base.py, 3, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(base.px + 12, base.py, 3, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#D0D0D0';
  ctx.beginPath();
  ctx.arc(base.px + 3, base.py + 1, 1.5, 0, Math.PI * 2);
  ctx.fill();
}

export function drawIsoPhoneBooth(ctx: CanvasRenderingContext2D, isoProject: IsoProjectFn, gx: number, gy: number) {
  const base = isoProject(gx, gy);
  ctx.fillStyle = '#B0C0B0';
  ctx.beginPath();
  ctx.moveTo(base.px - 8, base.py);
  ctx.lineTo(base.px, base.py - 6);
  ctx.lineTo(base.px + 8, base.py);
  ctx.lineTo(base.px, base.py + 6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(168, 213, 162, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
  const now = performance.now();
  ctx.fillStyle = now % 2000 < 1000 ? '#608860' : '#D4E8D0';
  ctx.beginPath();
  ctx.arc(base.px, base.py - 10, 2, 0, Math.PI * 2);
  ctx.fill();
}

export function drawIsoBreakArea(ctx: CanvasRenderingContext2D, isoProject: IsoProjectFn, gx: number, gy: number) {
  const base = isoProject(gx, gy);
  ctx.fillStyle = '#FAF0E6';
  ctx.fillRect(base.px - 10, base.py - 4, 20, 6);
  ctx.fillStyle = '#D8DCE0';
  ctx.fillRect(base.px - 8, base.py - 14, 6, 8);
  const now = performance.now();
  ctx.fillStyle = `rgba(212, 165, 116, ${0.4 + 0.2 * Math.sin(now / 300)})`;
  ctx.fillRect(base.px - 6, base.py - 12, 2, 2);
  ctx.fillStyle = '#E2E8F0';
  ctx.fillRect(base.px + 4, base.py - 12, 6, 5);
}

export function drawIsoStairs(ctx: CanvasRenderingContext2D, isoProject: IsoProjectFn, gx: number, gy: number) {
  const base = isoProject(gx, gy);
  for (let i = 0; i < 4; i++) {
    const r = 232 + i * 3;
    const g = 197 + i * 2;
    const b = 150 + i * 2;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(base.px - 8 + i * 4, base.py - 4 + i * 2, 8, 3);
  }
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(base.px + 8, base.py - 4);
  ctx.lineTo(base.px + 8, base.py + 8);
  ctx.stroke();
}
