// ─── RepoCiv — Hex & Tile drawing ────────────────────────────────────────────
import { type Axial, axialToPixel } from './hex.ts';
import { type Terrain, type Tile, type City } from './types.ts';
import { TERRAIN_COLOR } from './map.ts';

const HEX_SIZE = 52;

export class HexRenderer {
  constructor(private ctx: CanvasRenderingContext2D) {}

  fillHex(cx: number, cy: number, size: number) {
    const { ctx } = this;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i - 30);
      const x = cx + size * 0.92 * Math.cos(angle);
      const y = cy + size * 0.92 * Math.sin(angle);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  drawHexOutline(coord: Axial, color: string, lw: number) {
    const { ctx } = this;
    const pos = axialToPixel(coord, HEX_SIZE);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    this.fillHex(pos.x, pos.y, HEX_SIZE);
    ctx.stroke();
    ctx.restore();
  }

  drawTile(tile: Tile, fogEnabled: boolean) {
    const { ctx } = this;
    const pos = axialToPixel(tile.coord, HEX_SIZE);
    const colors = TERRAIN_COLOR[tile.terrain]!;
    const alpha = (tile.inFog && fogEnabled) ? 0.35 : 1;

    ctx.save();
    ctx.globalAlpha = alpha;

    if (colors.gradient) {
      const grad = ctx.createRadialGradient(
        pos.x - HEX_SIZE * 0.2, pos.y - HEX_SIZE * 0.2, HEX_SIZE * 0.1,
        pos.x, pos.y, HEX_SIZE * 0.85
      );
      grad.addColorStop(0, colors.gradient[0]!);
      grad.addColorStop(1, colors.gradient[1]!);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = colors.fill;
    }

    this.fillHex(pos.x, pos.y, HEX_SIZE);
    ctx.fillStyle = colors.fill;
    this.fillHex(pos.x, pos.y, HEX_SIZE);
    this.drawTerrainDecor(tile.terrain, pos, alpha);
    ctx.restore();

    if (tile.sessionTint === 'fog') {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#3a4a6a';
      this.fillHex(pos.x, pos.y, HEX_SIZE);
      ctx.restore();
    }

    if (tile.city && tile.skillHealth) {
      const skillColor = tile.skillHealth === 'ok' ? '#5b9b5b'
        : tile.skillHealth === 'stale' ? '#c8a84b' : '#d45b5b';
      ctx.save();
      ctx.font = `${HEX_SIZE * 0.22}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = skillColor;
      ctx.fillText('⚡', pos.x + HEX_SIZE * 0.55, pos.y - HEX_SIZE * 0.55);
      ctx.restore();
    }

    if (tile.city) this.drawCityLabel(tile.city, pos);
    if (tile.district) this.drawDistrictLabel(tile.district.name, pos);
  }

  private drawTerrainDecor(terrain: Terrain, pos: { x: number; y: number }, alpha: number) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha * 0.5;
    switch (terrain) {
      case 'forest': {
        ctx.fillStyle = '#1a3d15';
        for (let i = 0; i < 3; i++) {
          const tx = pos.x + (i - 1) * HEX_SIZE * 0.28;
          const ty = pos.y + HEX_SIZE * 0.1;
          ctx.beginPath();
          ctx.moveTo(tx, ty - HEX_SIZE * 0.28);
          ctx.lineTo(tx + HEX_SIZE * 0.14, ty + HEX_SIZE * 0.12);
          ctx.lineTo(tx - HEX_SIZE * 0.14, ty + HEX_SIZE * 0.12);
          ctx.closePath();
          ctx.fill();
        }
        break;
      }
      case 'mountain': {
        ctx.fillStyle = '#4a4a4a';
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - HEX_SIZE * 0.38);
        ctx.lineTo(pos.x + HEX_SIZE * 0.28, pos.y + HEX_SIZE * 0.15);
        ctx.lineTo(pos.x - HEX_SIZE * 0.28, pos.y + HEX_SIZE * 0.15);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#c0c0c0';
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - HEX_SIZE * 0.38);
        ctx.lineTo(pos.x + HEX_SIZE * 0.10, pos.y - HEX_SIZE * 0.15);
        ctx.lineTo(pos.x - HEX_SIZE * 0.10, pos.y - HEX_SIZE * 0.15);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'ocean': {
        ctx.strokeStyle = '#3a8bc8';
        ctx.lineWidth = 1.2;
        for (let w = 0; w < 2; w++) {
          ctx.beginPath();
          const wy = pos.y - HEX_SIZE * 0.1 + w * HEX_SIZE * 0.22;
          ctx.moveTo(pos.x - HEX_SIZE * 0.4, wy);
          ctx.bezierCurveTo(
            pos.x - HEX_SIZE * 0.2, wy - 4,
            pos.x + HEX_SIZE * 0.2, wy + 4,
            pos.x + HEX_SIZE * 0.4, wy
          );
          ctx.stroke();
        }
        break;
      }
      case 'ice': {
        ctx.fillStyle = '#a0b0c0';
        ctx.font = `${HEX_SIZE * 0.35}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('❄', pos.x, pos.y);
        break;
      }
    }
    ctx.restore();
  }

  drawCityTerritory(city: City) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = city.isCapital ? '#c8a84b' : '#5a3e1e';
    ctx.lineWidth = 2;
    ctx.setLineDash(city.isCapital ? [] : [4, 4]);
    for (const coord of city.territory) {
      const pos = axialToPixel(coord, HEX_SIZE);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 180) * (60 * i - 30);
        const x = pos.x + HEX_SIZE * 0.90 * Math.cos(angle);
        const y = pos.y + HEX_SIZE * 0.90 * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawCityLabel(city: City, pos: { x: number; y: number }) {
    const { ctx } = this;
    if (city.isCapital) {
      ctx.save();
      ctx.fillStyle = '#c8a84b';
      ctx.font = `${HEX_SIZE * 0.45}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('★', pos.x, pos.y - HEX_SIZE * 0.25);
      ctx.restore();
    }
    const label = city.name;
    ctx.save();
    ctx.font = `bold ${HEX_SIZE * 0.26}px 'Cinzel', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const metrics = ctx.measureText(label);
    const bw = metrics.width + 10;
    const bh = HEX_SIZE * 0.35;
    const bx = pos.x - bw / 2;
    const by = pos.y + HEX_SIZE * 0.55;
    ctx.fillStyle = 'rgba(26,18,8,0.82)';
    ctx.fillRect(bx, by - bh, bw, bh);
    ctx.strokeStyle = '#5a3e1e';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by - bh, bw, bh);
    ctx.fillStyle = '#e8d5a0';
    ctx.fillText(label, pos.x, by - 3);
    ctx.restore();
  }

  private drawDistrictLabel(name: string, pos: { x: number; y: number }) {
    const { ctx } = this;
    const short = name.split('/').pop() ?? name;
    ctx.save();
    ctx.font = `${HEX_SIZE * 0.20}px 'Georgia', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(232,213,160,0.75)';
    ctx.fillText(short, pos.x, pos.y + HEX_SIZE * 0.15);
    ctx.restore();
  }
}
