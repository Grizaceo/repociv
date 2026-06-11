// ─── RepoCiv — Unit, Building & path drawing ─────────────────────────────────
import { axialToPixel, type Axial } from './hex.ts';
import { type Unit, type Building, tileKey } from './types.ts';
import { type GameState } from './game.ts';
import { HEX_SIZE } from './constants.ts';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class UnitRenderer {
  private coordProjector: (coord: Axial) => { x: number; y: number } = (coord) =>
    axialToPixel(coord, HEX_SIZE);

  constructor(
    private ctx: CanvasRenderingContext2D,
    private state: GameState,
  ) {}

  /** Project axial coords to canvas world space (flat or iso extruded). */
  setCoordProjector(fn: (coord: Axial) => { x: number; y: number }): void {
    this.coordProjector = fn;
  }

  resetCoordProjector(): void {
    this.coordProjector = (coord) => axialToPixel(coord, HEX_SIZE);
  }

  private tilePos(coord: Axial): { x: number; y: number } {
    return this.coordProjector(coord);
  }

  drawUnitTrail(unit: Unit) {
    if (!unit.trailPositions || unit.trailPositions.length === 0) return;
    const { ctx } = this;
    ctx.save();
    unit.trailPositions.forEach((pos, i) => {
      const alpha = ((i + 1) / unit.trailPositions!.length) * 0.4;
      const p = this.tilePos(pos);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = unit.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1.0;
    ctx.restore();
  }

  drawUnitBadge(unit: Unit, animTime: number) {
    const { ctx } = this;
    const p = this.tilePos(unit.coord);
    const bx = p.x + HEX_SIZE * 0.45;
    const by = p.y - HEX_SIZE * 0.45;
    const r = 7;
    ctx.save();
    switch (unit.state) {
      case 'idle': {
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'moving': {
        const angle = animTime * 4;
        ctx.strokeStyle = '#f09030';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(bx, by, r, angle, angle + Math.PI * 1.3);
        ctx.stroke();
        break;
      }
      case 'working': {
        const alpha = 0.6 + 0.4 * Math.sin(animTime * 2.5);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#4080e0';
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
        break;
      }
      case 'sleeping': {
        ctx.fillStyle = 'rgba(160,160,160,0.5)';
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ccc';
        ctx.font = `${r + 2}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('z', bx + 1, by - 1);
        break;
      }
      case 'building': {
        const pct = (unit.workProgress ?? 0) / 100;
        ctx.fillStyle = '#2a1e0a';
        ctx.fillRect(bx - r, by - r, r * 2, r * 2);
        ctx.fillStyle = '#c8a84b';
        ctx.fillRect(bx - r, by - r + r * 2 * (1 - pct), r * 2, r * 2 * pct);
        ctx.strokeStyle = '#f0c050';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx - r, by - r, r * 2, r * 2);
        break;
      }
    }
    ctx.restore();
  }

  drawSubagentLink(parent: Unit, child: Unit, animTime: number) {
    const { ctx } = this;
    const pp = this.tilePos(parent.coord);
    const cp = this.tilePos(child.coord);
    const pulse = 0.25 + 0.15 * Math.sin(animTime * 2 + pp.x);
    ctx.save();
    ctx.strokeStyle = `rgba(139, 180, 248, ${pulse})`;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(pp.x, pp.y);
    ctx.lineTo(cp.x, cp.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  drawSubagentCountBadge(parent: Unit, childCount: number, animTime: number) {
    const { ctx } = this;
    const p = this.tilePos(parent.coord);
    const bx = p.x - HEX_SIZE * 0.5;
    const by = p.y - HEX_SIZE * 0.55;
    const label = childCount > 5 ? `+${childCount - 5}` : String(childCount);
    ctx.save();
    ctx.fillStyle = 'rgba(20, 30, 60, 0.85)';
    ctx.strokeStyle = '#8ab4f8';
    ctx.lineWidth = 1.5;
    const w = label.length > 2 ? 22 : 16;
    ctx.beginPath();
    ctx.roundRect(bx - w / 2, by - 8, w, 16, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#cfe2ff';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.85 + 0.15 * Math.sin(animTime * 3);
    ctx.fillText(label, bx, by);
    ctx.restore();
  }

  drawUnit(unit: Unit, animTime: number, selectedUnitId: string | null, ephemeral = false) {
    const { ctx } = this;
    const isEphemeral = ephemeral || unit.ephemeral;
    let ux: number, uy: number;
    if (unit.state === 'moving' && unit.path.length > 0 && unit.pathIndex < unit.path.length) {
      const from = this.tilePos(unit.path[unit.pathIndex]!);
      const to = this.tilePos(
        unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!,
      );
      ux = lerp(from.x, to.x, unit.pathProgress);
      uy = lerp(from.y, to.y, unit.pathProgress);
    } else {
      const p = this.tilePos(unit.coord);
      ux = p.x;
      uy = p.y;
    }

    const floatY = Math.sin(animTime * 2.5 + ux * 0.01) * 2;
    ctx.save();
    ctx.translate(ux, uy + floatY);
    const scale = isEphemeral ? 0.8 : 1;
    if (scale !== 1) ctx.scale(scale, scale);

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

    if (isEphemeral) {
      const run = unit.subagentRunId ? this.state.subagents.get(unit.subagentRunId) : undefined;
      const kind = run?.kind ?? unit.type;
      const glyph =
        kind === 'explore' || unit.type === 'scout' ? '◈' : unit.type === 'caravan' ? '⛟' : '◆';
      const borderColor = unit.type === 'caravan' ? '#e8a040' : '#8ab4f8';
      ctx.beginPath();
      ctx.arc(0, 0, HEX_SIZE * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = '#1a1208';
      ctx.fill();
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = borderColor;
      ctx.font = `bold ${HEX_SIZE * 0.2}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(glyph, 0, 0);
      ctx.restore();
      return;
    }

    // Unit Cluster (Diamond formation)
    const offsets = [
      { dx: 0, dy: -8 },
      { dx: -10, dy: 2 },
      { dx: 10, dy: 2 },
      { dx: 0, dy: 12 },
    ];

    const initials = unit.name
      .split(/[\s-_]/)
      .map((w) => w[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase();

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
      ctx.arc(
        0,
        0,
        HEX_SIZE * 0.38,
        -Math.PI / 2,
        -Math.PI / 2 + (Math.PI * 2 * unit.workProgress) / 100,
      );
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
          const pos = this.tilePos(coord);
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
    const start = this.tilePos(unit.path[0]!);
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i < unit.path.length; i++) {
      const p = this.tilePos(unit.path[i]!);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawBuilding(building: Building) {
    if (building.state === 'complete') return;
    const city = this.state.world.cities.find((c) => c.id === building.cityId);
    if (!city) return;
    const pos = this.tilePos(city.coord);
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
