// ─── RepoCiv — Unit, Building & path drawing ─────────────────────────────────
import { axialToPixel } from './hex.ts';
import { type Unit, type Building, tileKey } from './types.ts';
import { type GameState } from './game.ts';

const HEX_SIZE = 52;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class UnitRenderer {
  constructor(
    private ctx: CanvasRenderingContext2D,
    private state: GameState,
  ) {}

  drawUnit(unit: Unit, animTime: number, selectedUnitId: string | null) {
    const { ctx } = this;
    let ux: number, uy: number;
    if (unit.state === 'moving' && unit.path.length > 0 && unit.pathIndex < unit.path.length) {
      const from = axialToPixel(unit.path[unit.pathIndex]!, HEX_SIZE);
      const to   = axialToPixel(unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!, HEX_SIZE);
      ux = lerp(from.x, to.x, unit.pathProgress);
      uy = lerp(from.y, to.y, unit.pathProgress);
    } else {
      const p = axialToPixel(unit.coord, HEX_SIZE);
      ux = p.x; uy = p.y;
    }

    const floatY = Math.sin(animTime * 2.5 + ux * 0.01) * 2;
    ctx.save();
    ctx.translate(ux, uy + floatY);

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(2, HEX_SIZE * 0.35, HEX_SIZE * 0.22, HEX_SIZE * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();

    if (selectedUnitId === unit.id) {
      ctx.strokeStyle = '#f0c050';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, HEX_SIZE * 0.45, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Unit Cluster (Diamond formation)
    const offsets = [
      { dx: 0, dy: -8 },
      { dx: -10, dy: 2 },
      { dx: 10, dy: 2 },
      { dx: 0, dy: 12 },
    ];

    const initials = unit.name.split(/[\s-_]/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase();

    offsets.forEach((off, _i) => {
      ctx.save();
      ctx.translate(off.dx, off.dy);
      
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath();
      ctx.ellipse(1, 10, 8, 3, 0, 0, Math.PI * 2);
      ctx.fill();

      // Body
      ctx.beginPath();
      ctx.arc(0, 0, HEX_SIZE * 0.18, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1208';
      ctx.fill();
      ctx.strokeStyle = unit.color;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // Initials (only on the front-most unit or all if small)
      ctx.fillStyle = unit.color;
      ctx.font = `bold ${HEX_SIZE * 0.14}px 'Cinzel', serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials, 0, 0);
      
      ctx.restore();
    });

    if (unit.state === 'working' && unit.workProgress !== undefined) {
      ctx.strokeStyle = '#5b9b5b';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, HEX_SIZE * 0.38, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * unit.workProgress / 100));
      ctx.stroke();
    }

    if (unit.state === 'sleeping') {
      ctx.font = `${HEX_SIZE * 0.25}px serif`;
      ctx.fillText('💤', 0, -HEX_SIZE * 0.5);
    }

    ctx.restore();
  }

  drawMoveRange(unit: Unit) {
    const { ctx } = this;
    const range = Math.floor(unit.movesLeft);
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#c8a84b';
    for (let q = -range; q <= range; q++) {
      for (let r = Math.max(-range, -q - range); r <= Math.min(range, -q + range); r++) {
        const coord = { q: unit.coord.q + q, r: unit.coord.r + r };
        const tile = this.state.world.tiles.get(tileKey(coord));
        if (tile && !tile.inFog) {
          const pos = axialToPixel(coord, HEX_SIZE);
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const angle = (Math.PI / 180) * (60 * i - 30);
            const x = pos.x + HEX_SIZE * 0.92 * Math.cos(angle);
            const y = pos.y + HEX_SIZE * 0.92 * Math.sin(angle);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  drawMovementPath(unit: Unit) {
    if (unit.path.length === 0) return;
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = '#c8a84b';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    const start = axialToPixel(unit.path[0]!, HEX_SIZE);
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i < unit.path.length; i++) {
      const p = axialToPixel(unit.path[i]!, HEX_SIZE);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawBuilding(building: Building) {
    if (building.state === 'complete') return;
    const city = this.state.world.cities.find(c => c.id === building.cityId);
    if (!city) return;
    const pos = axialToPixel(city.coord, HEX_SIZE);
    const barW = HEX_SIZE * 1.6;
    const barH = 8;
    const barX = pos.x - barW / 2;
    const barY = pos.y + HEX_SIZE * 0.5;
    const pct = building.progress / 100;
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = '#2a1e0a';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = building.type === 'wonder' ? '#c8a84b' : '#5b9b5b';
    ctx.fillRect(barX, barY, barW * pct, barH);
    ctx.strokeStyle = building.type === 'wonder' ? '#f0c050' : '#7ab87a';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, barH);
    ctx.fillStyle = '#e8d5a0';
    ctx.font = `${Math.max(8, HEX_SIZE * 0.18)}px 'Cinzel', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${building.name} ${Math.round(building.progress)}%`, pos.x, barY - 2);
    ctx.restore();
  }
}
