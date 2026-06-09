// ─── RepoCiv — Hex & Tile drawing (flat legacy mode) ────────────────────────
// Photo atlas patterns used only when renderer worldRenderMode === 'flat'.
// Default iso25d path uses IsoHexRenderer + procedural TERRAIN_COLOR fills.
import { logger } from './logger.ts';
import { type Axial, axialToPixel, AXIAL_DIRECTIONS } from './hex.ts';
import { type Terrain, type Tile, type City, type Building, type District } from './types.ts';
import { TERRAIN_COLOR } from './map.ts';
import { HEX_SIZE } from './constants.ts';

export class HexRenderer {
  private patterns: Record<string, CanvasPattern | null> = {};
  private assetsLoaded = false;
  private readonly _labelWidthCache = new Map<string, number>();

  constructor(private ctx: CanvasRenderingContext2D) {}

  private spriteImages: Record<string, HTMLImageElement | HTMLCanvasElement> = {};

  async loadAssets() {
    // ── Load atlas manifest ──
    let manifest: {
      terrainAtlas: string;
      decorAtlas: string;
      cellSize: number;
      terrainRects: Record<string, number[]>;
      decorRects: Record<string, number[]>;
    };
    try {
      const res = await fetch('/assets/asset-atlas.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      logger.warn('Failed to load asset atlas manifest:', err);
      this.assetsLoaded = false;
      return;
    }

    const spriteImages: Record<string, HTMLImageElement | HTMLCanvasElement> = {};

    // ── Helper: load an image from URL ──
    const loadImage = (url: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.src = url;
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load ${url}`));
      });

    // ── Helper: extract a subrect from an image into a NxN canvas ──
    const extractToCanvas = (
      src: HTMLImageElement,
      rect: number[],
      targetSize: number,
    ): HTMLCanvasElement => {
      const canvas = document.createElement('canvas');
      canvas.width = targetSize;
      canvas.height = targetSize;
      const cctx = canvas.getContext('2d')!;
      cctx.drawImage(
        src,
        rect[0]!,
        rect[1]!,
        rect[2]! - rect[0]!,
        rect[3]! - rect[1]!,
        0,
        0,
        targetSize,
        targetSize,
      );
      return canvas;
    };

    try {
      // ── Terrain atlas → CanvasPatterns ──
      const terrainImg = await loadImage(manifest.terrainAtlas);
      const cellSize = manifest.cellSize;
      for (const [name, rect] of Object.entries(manifest.terrainRects)) {
        const tileCanvas = extractToCanvas(terrainImg, rect, cellSize);
        const pattern = this.ctx.createPattern(tileCanvas, 'repeat');
        if (pattern) {
          this.patterns[name] = pattern;
        }
      }

      // ── Decor atlas → individual sprite canvases ──
      const decorImg = await loadImage(manifest.decorAtlas);
      for (const [name, rect] of Object.entries(manifest.decorRects)) {
        spriteImages[name] = extractToCanvas(decorImg, rect, cellSize);
      }

      this.spriteImages = spriteImages;
      this.assetsLoaded = true;
    } catch (err) {
      logger.warn('Failed to load asset atlas images:', err);
      this.assetsLoaded = false;
    }
  }

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

  drawTileSurface(tile: Tile, fogEnabled: boolean, neighbors: Tile[], animTime?: number) {
    const { ctx } = this;
    const pos = axialToPixel(tile.coord, HEX_SIZE);
    const colors = TERRAIN_COLOR[tile.terrain] || TERRAIN_COLOR.plains;
    const alpha = tile.inFog && fogEnabled ? 0.35 : 1;

    ctx.save();
    ctx.globalAlpha = alpha;

    const pattern = this.patterns[tile.terrain] || this.patterns['plains'];
    if (this.assetsLoaded && pattern) {
      ctx.fillStyle = pattern;
    } else if (colors.gradient) {
      const grad = ctx.createRadialGradient(
        pos.x - HEX_SIZE * 0.2,
        pos.y - HEX_SIZE * 0.2,
        HEX_SIZE * 0.1,
        pos.x,
        pos.y,
        HEX_SIZE * 0.85,
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
      const touchesLand = neighbors.some((n) => n.terrain !== 'ocean');
      if (touchesLand) {
        const time = animTime || 0;
        const prefersReducedMotion =
          typeof window !== 'undefined' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        // Two concentric pulsating wave rings
        const wave1 = prefersReducedMotion ? 0.95 : 0.92 + 0.03 * Math.sin(time * 2.0);
        const wave2 = prefersReducedMotion ? 0.88 : 0.86 + 0.04 * Math.sin(time * 2.0 + Math.PI);

        ctx.strokeStyle = 'rgba(150, 220, 255, 0.35)';
        ctx.lineWidth = 2.5;
        this.drawHexOutlineRaw(pos.x, pos.y, HEX_SIZE * wave1);

        ctx.strokeStyle = 'rgba(150, 220, 255, 0.16)';
        ctx.lineWidth = 1.5;
        this.drawHexOutlineRaw(pos.x, pos.y, HEX_SIZE * wave2);
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

  drawTileDecor(tile: Tile, fogEnabled: boolean, activeBuilding?: Building, animTime?: number) {
    if (!tile.revealed) return;
    const pos = axialToPixel(tile.coord, HEX_SIZE);
    const alpha = tile.inFog && fogEnabled ? 0.35 : 1;

    this.drawTerrainDecor(tile.terrain, pos, alpha, animTime);
    this.drawTileResources(tile, pos, alpha, animTime);

    if (tile.city && tile.skillHealth) {
      const skillColor =
        tile.skillHealth === 'ok'
          ? '#5b9b5b'
          : tile.skillHealth === 'stale'
            ? '#c8a84b'
            : '#d45b5b';
      const { ctx } = this;
      ctx.save();
      ctx.font = `${HEX_SIZE * 0.22}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = skillColor;
      ctx.fillText('⚡', pos.x + HEX_SIZE * 0.55, pos.y - HEX_SIZE * 0.55);
      ctx.restore();
    }

    if (tile.city) this.drawCityLabel(tile.city, pos, activeBuilding);
    // Wonder districts get rich building visuals instead of plain text labels
    if (tile.district?.type === 'wonder' && tile.district.wonderType) {
      this.drawWonderDistrict(tile.district, pos, animTime);
    } else if (tile.district) {
      this.drawDistrictLabel(tile.district.name, pos);
    }
  }

  private drawTileResources(
    tile: Tile,
    pos: { x: number; y: number },
    alpha: number,
    animTime?: number,
  ) {
    const { ctx } = this;
    const res = tile.resources;
    if (!tile.revealed) return;

    const icons: string[] = [];
    if (res.gold >= 8) icons.push('🪙');
    if (res.science >= 4) icons.push('⚗');
    if (res.production >= 3) icons.push('⚙');
    if (icons.length === 0) return;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const time = animTime || 0;
    // Gentle floating offset
    const floatY = prefersReducedMotion ? 0 : Math.sin(time * 2.5 + pos.x * 0.05) * 4;

    ctx.save();
    ctx.globalAlpha = alpha * 0.85;
    ctx.font = `${HEX_SIZE * 0.22}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const spacing = HEX_SIZE * 0.28;
    const startX = pos.x - (spacing * (icons.length - 1)) / 2;
    const iconY = pos.y + HEX_SIZE * 0.42 + floatY;
    for (let i = 0; i < icons.length; i++) {
      ctx.fillText(icons[i]!, startX + i * spacing, iconY);
    }
    ctx.restore();
  }

  private drawTerrainDecor(
    terrain: Terrain,
    pos: { x: number; y: number },
    alpha: number,
    animTime?: number,
  ) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;

    switch (terrain) {
      case 'forest': {
        const sprite = this.spriteImages['forest_sprite'];
        const prefersReducedMotion =
          typeof window !== 'undefined' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const time = animTime || 0;
        const sway = prefersReducedMotion ? 0 : Math.sin(time * 1.8 + pos.x * 0.02) * 0.05;

        ctx.save();
        ctx.translate(pos.x, pos.y);
        ctx.transform(1, 0, sway, 1, 0, 0); // GPU-accelerated wind sway shear transform
        ctx.translate(-pos.x, -pos.y);

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
        ctx.restore();
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
      case 'sacred': {
        // Golden ethereal particles floating on sacred ground
        const time = animTime || 0;
        const prefersReducedMotion =
          typeof window !== 'undefined' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        ctx.save();
        for (let p = 0; p < 5; p++) {
          const angle = (p / 5) * Math.PI * 2 + time * 0.5;
          const radius = HEX_SIZE * (0.25 + 0.15 * Math.sin(time * 1.2 + p * 1.5));
          const px = pos.x + Math.cos(angle) * radius;
          const py = pos.y + Math.sin(angle) * radius;
          const particleAlpha = prefersReducedMotion ? 0.3 : 0.15 + 0.2 * Math.sin(time * 2.0 + p);
          ctx.fillStyle = `rgba(200, 168, 75, ${particleAlpha})`;
          ctx.beginPath();
          ctx.arc(px, py, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
        // Subtle golden glow ring
        const glowAlpha = prefersReducedMotion ? 0.08 : 0.04 + 0.04 * Math.sin(time * 1.5);
        ctx.strokeStyle = `rgba(200, 168, 75, ${glowAlpha})`;
        ctx.lineWidth = 2;
        this.drawHexOutlineRaw(pos.x, pos.y, HEX_SIZE * 0.7);
        ctx.restore();
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

  private static readonly EDGE_CORNERS: [number, number][] = [
    [0, 1], // E  (dir 0)
    [5, 0], // NE (dir 1)
    [4, 5], // NW (dir 2)
    [3, 4], // W  (dir 3)
    [2, 3], // SW (dir 4)
    [1, 2], // SE (dir 5)
  ];

  drawCityTerritory(city: City, animTime?: number) {
    const { ctx } = this;
    if (city.territory.length === 0) return;

    // Build fast lookup set
    const inTerritory = new Set(city.territory.map((c) => `${c.q},${c.r}`));
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const time = animTime || 0;

    // Pulsating border opacity
    const pulse = prefersReducedMotion ? 0.95 : 0.75 + 0.25 * Math.sin(time * 3.0);
    const borderColor = city.isCapital
      ? `rgba(200, 168, 75, ${pulse})`
      : `rgba(122, 90, 46, ${pulse * 0.95})`;

    const borderWidth = city.isCapital ? 3.0 : 2.0;

    ctx.save();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = borderWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = city.isCapital ? 'rgba(245, 213, 128, 0.45)' : 'transparent';
    ctx.shadowBlur = city.isCapital && !prefersReducedMotion ? 6 + 2.5 * Math.sin(time * 3.0) : 0;
    ctx.setLineDash([]);

    for (const coord of city.territory) {
      const pos = axialToPixel(coord, HEX_SIZE);
      // Compute the 6 corner positions of this hex
      const corners: { x: number; y: number }[] = [];
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 180) * (60 * i - 30);
        corners.push({
          x: pos.x + HEX_SIZE * 0.92 * Math.cos(angle),
          y: pos.y + HEX_SIZE * 0.92 * Math.sin(angle),
        });
      }

      // Check each of the 6 directions
      for (let d = 0; d < 6; d++) {
        const dir = AXIAL_DIRECTIONS[d]!;
        const neighbor = `${coord.q + dir.q},${coord.r + dir.r}`;
        if (inTerritory.has(neighbor)) continue; // shared border — skip

        // Draw this external edge
        const [ci, cj] = HexRenderer.EDGE_CORNERS[d]!;
        const a = corners[ci]!;
        const b = corners[cj]!;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  /** Public: draw city label (used by renderer for LOD/clean-mode paths). */
  drawCityLabel(city: City, pos: { x: number; y: number }, activeBuilding?: Building) {
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
    let cachedW = this._labelWidthCache.get(label);
    if (cachedW === undefined) {
      cachedW = ctx.measureText(label).width;
      this._labelWidthCache.set(label, cachedW);
    }
    const bw = cachedW + 16;
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

    // ─── A2: Production bar ─────────────────────────────────────────────────
    if (activeBuilding && activeBuilding.state === 'building') {
      this.drawProductionBar(activeBuilding, pos, bx, by, bw);
    }
  }

  // ─── A2: Production bar drawn below city label ────────────────────────────
  private drawProductionBar(
    b: Building,
    _pos: { x: number; y: number },
    bx: number,
    by: number,
    bw: number,
  ) {
    const { ctx } = this;
    const pct = Math.max(0, Math.min(1, b.progress / 100));
    const barH = 7;
    const barY = by + 3;
    const padding = 2;

    ctx.save();

    // Bar background
    ctx.fillStyle = 'rgba(10,8,4,0.85)';
    ctx.strokeStyle = '#5a3e1e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(bx, barY, bw, barH);
    ctx.fill();
    ctx.stroke();

    // Bar fill (gold gradient)
    if (pct > 0) {
      const fillGrad = ctx.createLinearGradient(bx + padding, 0, bx + bw - padding, 0);
      fillGrad.addColorStop(0, '#c8a84b');
      fillGrad.addColorStop(1, '#f0d060');
      ctx.fillStyle = fillGrad;
      ctx.fillRect(bx + padding, barY + padding, (bw - padding * 2) * pct, barH - padding * 2);
    }

    // Project name truncated
    const nameY = barY + barH + 10;
    const maxNameW = bw - 4;
    ctx.font = `${HEX_SIZE * 0.19}px 'Cinzel', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#c8a84b';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 2;
    // Truncate name to fit
    let name = `⚙ ${b.name}`;
    while (ctx.measureText(name).width > maxNameW && name.length > 4) {
      name = name.slice(0, -1);
    }
    if (name.length < `⚙ ${b.name}`.length) name += '…';
    ctx.fillText(name, bx + bw / 2, nameY);

    ctx.restore();
  }

  /** Public: draw district label (used by renderer for LOD/clean-mode paths). */
  drawDistrictLabel(name: string, pos: { x: number; y: number }) {
    const { ctx } = this;
    const short = name.split('/').pop() ?? name;
    ctx.save();
    ctx.font = `${HEX_SIZE * 0.2}px 'Georgia', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(232,213,160,0.75)';
    ctx.fillText(short, pos.x, pos.y + HEX_SIZE * 0.15);
    ctx.restore();
  }

  /** Public: draw skill health indicator (used by renderer for clean-mode paths). */
  drawSkillHealth(tile: Tile, pos: { x: number; y: number }) {
    if (!tile.city || !tile.skillHealth) return;
    const skillColor =
      tile.skillHealth === 'ok' ? '#5b9b5b' : tile.skillHealth === 'stale' ? '#c8a84b' : '#d45b5b';
    const { ctx } = this;
    ctx.save();
    ctx.font = `${HEX_SIZE * 0.22}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = skillColor;
    ctx.fillText('⚡', pos.x + HEX_SIZE * 0.55, pos.y - HEX_SIZE * 0.55);
    ctx.restore();
  }

  // ─── Wonder District: rich building visuals on dedicated hex tiles ──────────
  drawWonderDistrict(district: District, pos: { x: number; y: number }, animTime?: number) {
    const { ctx } = this;
    const time = animTime || 0;
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wType = district.wonderType;

    ctx.save();

    if (wType === 'bibliotheca') {
      // ── Bibliotheca Alexandrina: Temple with columns ──────────────────────
      const glow = prefersReducedMotion ? 0.35 : 0.25 + 0.15 * Math.sin(time * 1.5);

      // Outer glow
      ctx.shadowColor = `rgba(74, 144, 200, ${glow})`;
      ctx.shadowBlur = 12;

      // Temple base (trapezoid)
      const bw = HEX_SIZE * 0.7;
      const bh = HEX_SIZE * 0.35;
      const topW = bw * 0.7;
      ctx.fillStyle = '#1a3a5c';
      ctx.beginPath();
      ctx.moveTo(pos.x - topW / 2, pos.y - bh * 0.4);
      ctx.lineTo(pos.x + topW / 2, pos.y - bh * 0.4);
      ctx.lineTo(pos.x + bw / 2, pos.y + bh * 0.5);
      ctx.lineTo(pos.x - bw / 2, pos.y + bh * 0.5);
      ctx.closePath();
      ctx.fill();

      // Columns (3 pillars)
      ctx.fillStyle = '#4a90c8';
      const colW = 3;
      const colH = bh * 0.65;
      for (let c = -1; c <= 1; c++) {
        const cx = pos.x + c * (topW / 3);
        ctx.fillRect(cx - colW / 2, pos.y - bh * 0.35, colW, colH);
      }

      // Triangular roof
      ctx.fillStyle = '#2a6aa0';
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y - bh * 0.7);
      ctx.lineTo(pos.x + topW / 2 + 4, pos.y - bh * 0.35);
      ctx.lineTo(pos.x - topW / 2 - 4, pos.y - bh * 0.35);
      ctx.closePath();
      ctx.fill();

      // Roof border glow
      ctx.strokeStyle = `rgba(74, 144, 200, ${glow + 0.2})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.shadowBlur = 0;

      // Book icon
      ctx.font = `${HEX_SIZE * 0.3}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('📚', pos.x, pos.y + 2);

      // Label
      ctx.font = `bold ${HEX_SIZE * 0.18}px 'Cinzel', serif`;
      ctx.fillStyle = '#8ac4e8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('BIBLIOTHECA', pos.x, pos.y + HEX_SIZE * 0.45);
    } else if (wType === 'institutum') {
      // ── Institutum / LabHub: Laboratory flask shape ────────────────────────
      const glow = prefersReducedMotion ? 0.35 : 0.25 + 0.15 * Math.sin(time * 2.0);

      // Outer glow
      ctx.shadowColor = `rgba(34, 197, 94, ${glow})`;
      ctx.shadowBlur = 12;

      // Flask body (rounded rectangle base)
      const fw = HEX_SIZE * 0.5;
      const fh = HEX_SIZE * 0.4;
      const radius = 6;
      ctx.fillStyle = '#1a3d1a';
      ctx.beginPath();
      ctx.moveTo(pos.x - fw / 2 + radius, pos.y - fh * 0.2);
      ctx.arcTo(pos.x + fw / 2, pos.y - fh * 0.2, pos.x + fw / 2, pos.y + fh * 0.6, radius);
      ctx.arcTo(pos.x + fw / 2, pos.y + fh * 0.6, pos.x - fw / 2, pos.y + fh * 0.6, radius);
      ctx.arcTo(pos.x - fw / 2, pos.y + fh * 0.6, pos.x - fw / 2, pos.y - fh * 0.2, radius);
      ctx.arcTo(pos.x - fw / 2, pos.y - fh * 0.2, pos.x + fw / 2, pos.y - fh * 0.2, radius);
      ctx.closePath();
      ctx.fill();

      // Flask neck
      const neckW = fw * 0.3;
      ctx.fillStyle = '#2d5a27';
      ctx.fillRect(pos.x - neckW / 2, pos.y - fh * 0.65, neckW, fh * 0.5);

      // Flask border
      ctx.strokeStyle = `rgba(34, 197, 94, ${glow + 0.2})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Bubbles (animated)
      if (!prefersReducedMotion) {
        for (let b = 0; b < 3; b++) {
          const bx = pos.x + (b - 1) * 8;
          const by = pos.y + fh * 0.2 - ((time * 15 + b * 20) % (fh * 0.6));
          const br = 2 + Math.sin(time * 3 + b) * 0.5;
          ctx.fillStyle = `rgba(34, 197, 94, ${0.3 + 0.2 * Math.sin(time * 2 + b)})`;
          ctx.beginPath();
          ctx.arc(bx, by, br, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.shadowBlur = 0;

      // Lab icon
      ctx.font = `${HEX_SIZE * 0.3}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🧪', pos.x, pos.y + 2);

      // Label
      ctx.font = `bold ${HEX_SIZE * 0.18}px 'Cinzel', serif`;
      ctx.fillStyle = '#6bc86b';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('LABHUB', pos.x, pos.y + HEX_SIZE * 0.45);
    } else {
      // Fallback: generic wonder
      ctx.font = `${HEX_SIZE * 0.35}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🏛', pos.x, pos.y);

      ctx.font = `bold ${HEX_SIZE * 0.18}px 'Cinzel', serif`;
      ctx.fillStyle = '#c8a84b';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(district.name.toUpperCase(), pos.x, pos.y + HEX_SIZE * 0.4);
    }

    ctx.restore();
  }
}
