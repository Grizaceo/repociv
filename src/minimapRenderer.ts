// ─── RepoCiv — Minimap rendering ─────────────────────────────────────────────
import { type Camera } from './hex.ts';
import { type GameState } from './game.ts';
import { TERRAIN_COLOR } from './map.ts';

const HEX_SIZE = 52;

export class MinimapRenderer {
  private bounds = { minQ: 0, maxQ: 0, minR: 0, maxR: 0 };

  constructor(private state: GameState) {}

  private computeBounds() {
    let minQ = Infinity, maxQ = -Infinity, minR = Infinity, maxR = -Infinity;
    for (const tile of this.state.world.tiles.values()) {
      if (tile.terrain === 'ocean' && !tile.revealed) continue;
      if (tile.coord.q < minQ) minQ = tile.coord.q;
      if (tile.coord.q > maxQ) maxQ = tile.coord.q;
      if (tile.coord.r < minR) minR = tile.coord.r;
      if (tile.coord.r > maxR) maxR = tile.coord.r;
    }
    this.bounds = { minQ, maxQ, minR, maxR };
  }

  draw(cam: Camera, mainCanvas: HTMLCanvasElement, fogEnabled: boolean) {
    const mm = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
    if (!mm) return;
    const ctx = mm.getContext('2d');
    if (!ctx) return;

    this.computeBounds();
    const { minQ, maxQ, minR, maxR } = this.bounds;
    if (!isFinite(minQ)) return;

    const padX = 2, padY = 2;
    const cellW = (mm.width  - padX * 2) / Math.max(1, maxQ - minQ + 1);
    const cellH = (mm.height - padY * 2) / Math.max(1, maxR - minR + 1);

    ctx.fillStyle = '#0a0804';
    ctx.fillRect(0, 0, mm.width, mm.height);

    for (const tile of this.state.world.tiles.values()) {
      const c = TERRAIN_COLOR[tile.terrain]!;
      ctx.fillStyle = tile.inFog && fogEnabled ? '#1a1208' : c.fill;
      const x = padX + (tile.coord.q - minQ) * cellW;
      const y = padY + (tile.coord.r - minR) * cellH + (tile.coord.q - minQ) * cellH * 0.5;
      ctx.fillRect(x, y, Math.max(1, cellW), Math.max(1, cellH));
      if (tile.city) {
        ctx.fillStyle = tile.city.isCapital ? '#f0c050' : '#c8a84b';
        ctx.fillRect(x - 1, y - 1, Math.max(2, cellW + 2), Math.max(2, cellH + 2));
      }
    }

    for (const u of this.state.world.units) {
      const x = padX + (u.coord.q - minQ) * cellW;
      const y = padY + (u.coord.r - minR) * cellH + (u.coord.q - minQ) * cellH * 0.5;
      ctx.fillStyle = u.color;
      ctx.fillRect(x - 1, y - 1, 4, 4);
    }

    // Viewport indicator
    const tlWorld = {
      x: cam.x - (mainCanvas.width / 2) / cam.zoom,
      y: cam.y - (mainCanvas.height / 2) / cam.zoom,
    };
    const brWorld = {
      x: cam.x + (mainCanvas.width / 2) / cam.zoom,
      y: cam.y + (mainCanvas.height / 2) / cam.zoom,
    };
    const worldQ = (px: number) => px / (HEX_SIZE * 1.5);
    const tlQ = worldQ(tlWorld.x), brQ = worldQ(brWorld.x);
    const x1 = padX + (tlQ - minQ) * cellW;
    const x2 = padX + (brQ - minQ) * cellW;
    ctx.strokeStyle = '#c8a84b88';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.max(0, Math.min(mm.width, x1)),
      padY,
      Math.max(2, x2 - x1),
      Math.max(2, mm.height - padY * 2),
    );
  }

  click(mx: number, my: number, cam: Camera) {
    const mm = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
    if (!mm) return;
    const { minQ, maxQ, minR, maxR } = this.bounds;
    if (!isFinite(minQ)) return;
    const padX = 2, padY = 2;
    const cellW = (mm.width  - padX * 2) / Math.max(1, maxQ - minQ + 1);
    const cellH = (mm.height - padY * 2) / Math.max(1, maxR - minR + 1);
    const q = (mx - padX) / cellW + minQ;
    const r = (my - padY - (q - minQ) * cellH * 0.5) / cellH + minR;
    cam.x = HEX_SIZE * 1.5 * q;
    cam.y = HEX_SIZE * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  }
}
