// ─── RepoCiv — Hex & Tile drawing ────────────────────────────────────────────
import { type Axial, axialToPixel } from './hex.ts';
import { type Terrain, type Tile, type City } from './types.ts';
import { TERRAIN_COLOR } from './map.ts';

const HEX_SIZE = 52;

export class HexRenderer {
  private patterns: Record<string, CanvasPattern | null> = {};
  private assetsLoaded = false;

  constructor(private ctx: CanvasRenderingContext2D) {}

  async loadAssets() {
    const assets = [
      { name: 'plains', url: '/assets/terrain_plains.png' },
      { name: 'forest', url: '/assets/terrain_forest.png' },
      { name: 'desert', url: '/assets/terrain_desert.png' },
      { name: 'ocean', url: '/assets/terrain_ocean.png' },
      { name: 'mountain', url: '/assets/terrain_mountain.png' },
      { name: 'ice', url: '/assets/terrain_ice.png' },
      { name: 'fog', url: '/assets/fog_parchment.png' },
      { name: 'hill_sprite', url: '/assets/hill_sprite.png' },
      { name: 'mountain_sprite', url: '/assets/mountain_sprite.png' },
      { name: 'forest_sprite', url: '/assets/forest_sprite.png' },
    ];

    const spriteImages: Record<string, HTMLImageElement> = {};

    const promises = assets.map(asset => {
      return new Promise<void>((resolve) => {
        const img = new Image();
        img.src = asset.url;
        img.onload = () => {
          if (asset.name.includes('sprite')) {
            spriteImages[asset.name] = img;
          } else {
            this.patterns[asset.name] = this.ctx.createPattern(img, 'repeat');
          }
          resolve();
        };
        img.onerror = () => {
          console.warn(`Failed to load asset: ${asset.url}`);
          resolve();
        };
      });
    });

    await Promise.all(promises);
    this.spriteImages = spriteImages;
    this.assetsLoaded = true;
  }

  private spriteImages: Record<string, HTMLImageElement> = {};

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

  drawTileSurface(tile: Tile, fogEnabled: boolean, neighbors: Tile[]) {
    const { ctx } = this;
    const pos = axialToPixel(tile.coord, HEX_SIZE);
    const colors = TERRAIN_COLOR[tile.terrain] || TERRAIN_COLOR.plains;
    const alpha = (tile.inFog && fogEnabled) ? 0.35 : 1;

    ctx.save();
    ctx.globalAlpha = alpha;

    const pattern = this.patterns[tile.terrain] || this.patterns['plains'];
    if (this.assetsLoaded && pattern) {
      ctx.fillStyle = pattern;
    } else if (colors.gradient) {
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
    
    // Shoreline effect (Ocean tiles touching land)
    if (tile.terrain === 'ocean') {
      const touchesLand = neighbors.some(n => n.terrain !== 'ocean');
      if (touchesLand) {
        ctx.strokeStyle = 'rgba(150, 220, 255, 0.4)';
        ctx.lineWidth = 4;
        this.drawHexOutlineRaw(pos.x, pos.y, HEX_SIZE * 0.95);
      }
    }

    // Subtle edge
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    this.drawHexOutlineRaw(pos.x, pos.y, HEX_SIZE);

    ctx.restore();

    // Fog of War
    if (!tile.revealed && this.patterns['fog']) {
      ctx.save();
      ctx.fillStyle = this.patterns['fog']!;
      this.fillHex(pos.x, pos.y, HEX_SIZE);
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#000';
      this.fillHex(pos.x, pos.y, HEX_SIZE);
      ctx.restore();
    } else if (tile.inFog && fogEnabled) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#0d0d1a';
      this.fillHex(pos.x, pos.y, HEX_SIZE);
      ctx.restore();
    }
  }

  drawTileDecor(tile: Tile, fogEnabled: boolean) {
    if (!tile.revealed) return;
    const pos = axialToPixel(tile.coord, HEX_SIZE);
    const alpha = (tile.inFog && fogEnabled) ? 0.35 : 1;

    this.drawTerrainDecor(tile.terrain, pos, alpha);

    if (tile.city && tile.skillHealth) {
      const skillColor = tile.skillHealth === 'ok' ? '#5b9b5b'
        : tile.skillHealth === 'stale' ? '#c8a84b' : '#d45b5b';
      const { ctx } = this;
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
    ctx.globalAlpha = alpha;
    
    switch (terrain) {
      case 'forest': {
        const sprite = this.spriteImages['forest_sprite'];
        if (sprite) {
          // Draw multiple small trees from sprite
          const sw = sprite.width / 2;
          const sh = sprite.height / 2;
          ctx.drawImage(sprite, 0, 0, sw, sh, pos.x - 25, pos.y - 25, 40, 40);
          ctx.drawImage(sprite, sw, 0, sw, sh, pos.x + 5, pos.y - 15, 30, 30);
          ctx.drawImage(sprite, 0, sh, sw, sh, pos.x - 10, pos.y + 5, 35, 35);
        } else {
          // Fallback to vector trees
          ctx.fillStyle = '#1e4d2b';
          for (let i = 0; i < 3; i++) {
             const tx = pos.x + (i - 1) * 12;
             const ty = pos.y + (i % 2) * 5;
             ctx.beginPath();
             ctx.moveTo(tx, ty - 15);
             ctx.lineTo(tx + 8, ty + 5);
             ctx.lineTo(tx - 8, ty + 5);
             ctx.fill();
          }
        }
        break;
      }
      case 'mountain': {
        const sprite = this.spriteImages['mountain_sprite'];
        if (sprite) {
          const sw = sprite.width / 2;
          const sh = sprite.height;
          ctx.drawImage(sprite, 0, 0, sw, sh, pos.x - 30, pos.y - 45, 60, 70);
          ctx.drawImage(sprite, sw, 0, sw, sh, pos.x + 5, pos.y - 30, 45, 55);
        } else {
          // Fallback
          ctx.fillStyle = '#4a4a4a';
          ctx.beginPath();
          ctx.moveTo(pos.x, pos.y - 30);
          ctx.lineTo(pos.x + 20, pos.y + 10);
          ctx.lineTo(pos.x - 20, pos.y + 10);
          ctx.fill();
        }
        break;
      }
      case 'hills': {
        const sprite = this.spriteImages['hill_sprite'];
        if (sprite) {
          const sw = sprite.width / 2;
          const sh = sprite.height;
          ctx.drawImage(sprite, 0, 0, sw, sh, pos.x - 25, pos.y - 20, 50, 40);
          ctx.drawImage(sprite, sw, 0, sw, sh, pos.x + 5, pos.y - 10, 40, 30);
        } else {
          ctx.fillStyle = 'rgba(0,0,0,0.1)';
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, 15, 0, Math.PI, true);
          ctx.fill();
        }
        break;
      }
      case 'ocean': {
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        for (let w = 0; w < 2; w++) {
          ctx.beginPath();
          const wy = pos.y - 8 + w * 14;
          const wx = pos.x - 20 + (w % 2) * 10;
          ctx.moveTo(wx, wy);
          ctx.bezierCurveTo(wx + 8, wy - 4, wx + 12, wy + 4, wx + 20, wy);
          ctx.stroke();
        }
        break;
      }
    }
    ctx.restore();
  }

  private drawHexOutlineRaw(cx: number, cy: number, size: number) {
    const { ctx } = this;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 180) * (60 * i - 30);
      const x = cx + size * 0.92 * Math.cos(angle);
      const y = cy + size * 0.92 * Math.sin(angle);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
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
    const label = city.name.toUpperCase();
    ctx.save();
    ctx.font = `bold ${HEX_SIZE * 0.26}px 'Cinzel', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const metrics = ctx.measureText(label);
    const bw = metrics.width + 16;
    const bh = HEX_SIZE * 0.38;
    const bx = pos.x - bw / 2;
    const by = pos.y + HEX_SIZE * 0.58;
    
    // Background with Art Deco Gradient
    const grad = ctx.createLinearGradient(bx, by - bh, bx, by);
    grad.addColorStop(0, '#2a2218');
    grad.addColorStop(0.5, '#1a1208');
    grad.addColorStop(1, '#0a0500');
    ctx.fillStyle = grad;
    
    // Rounded-ish background
    ctx.beginPath();
    ctx.moveTo(bx, by - bh);
    ctx.lineTo(bx + bw, by - bh);
    ctx.lineTo(bx + bw - 4, by);
    ctx.lineTo(bx + 4, by);
    ctx.closePath();
    ctx.fill();

    // Metallic Border
    ctx.strokeStyle = '#c8a84b';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    
    // Text Shadow for readability
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 3;
    
    ctx.fillStyle = '#e8d5a0';
    ctx.fillText(label, pos.x, by - 5);
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
