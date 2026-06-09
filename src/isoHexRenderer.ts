// ─── RepoCiv — Isometric hex renderer (global map 2.5D) ─────────────────────
import { AXIAL_DIRECTIONS, type Axial } from './hex.ts';
import {
  type Terrain,
  type Tile,
  type City,
  tileKey,
} from './types.ts';
import { TERRAIN_COLOR } from './map.ts';
import { HEX_SIZE } from './constants.ts';
import {
  axialToIsoPixel,
  terrainElevation,
  isoDepthKey,
  isoHexCorners,
  ISO_EXTRUDE_H,
} from './isoHex.ts';
import { type HexRenderer } from './hexRenderer.ts';
import { type GameState } from './game.ts';

export interface IsoRenderOptions {
  fogEnabled: boolean;
  animTime: number;
  zoom: number;
  lod: 'low' | 'medium' | 'high';
  cleanMode: boolean;
  showStructure: boolean;
  showOps: boolean;
  showLabels: boolean;
  showKnowledge: boolean;
  showLabs: boolean;
  showSecurity: boolean;
}

export class IsoHexRenderer {
  constructor(
    private ctx: CanvasRenderingContext2D,
    private hexR: HexRenderer,
  ) {}

  async loadAssets(): Promise<void> {
    // Iso decor uses vector fallback only (atlas sprites have opaque backgrounds).
  }

  /** Tile center on extruded top face (for units / overlays). */
  getTileCenter(coord: Axial, tile: Tile | undefined): { x: number; y: number } {
    const elev = tile ? terrainElevation(tile.terrain) : 0;
    return axialToIsoPixel(coord.q, coord.r, HEX_SIZE, elev);
  }

  renderWorld(state: GameState, opts: IsoRenderOptions): void {
    const tiles = this.sortTilesDepth(state);
    const getTile = (c: Axial) => state.world.tiles.get(tileKey(c));
    const getNeighbors = (tile: Tile) =>
      AXIAL_DIRECTIONS.map((d) => getTile({ q: tile.coord.q + d.q, r: tile.coord.r + d.r })).filter(
        (t): t is Tile => !!t,
      );

    for (const tile of tiles) {
      const neighbors = getNeighbors(tile);
      this.drawExtrudedTile(tile, neighbors, opts);
    }

    if (opts.showStructure) {
      for (const city of state.world.cities) {
        this.drawCityTerritoryIso(city, getTile, opts.animTime);
      }
    }

    const showDecor = opts.zoom >= 1.0 && opts.lod === 'high' && !opts.cleanMode;
    if (showDecor && (opts.showStructure || opts.showOps)) {
      for (const tile of tiles) {
        if (!tile.revealed) continue;
        this.drawTerrainDecorIso(tile, opts);
      }
    }

    for (const tile of tiles) {
      if (!tile.revealed) continue;
      if (tile.city) {
        this.drawCityMarker(tile, state, opts);
      }
      if (tile.district?.type === 'wonder' && tile.district.wonderType && opts.lod === 'high') {
        const pos = this.getTileCenter(tile.coord, tile);
        this.hexR.drawWonderDistrict(tile.district, pos, opts.animTime);
      }
    }
  }

  private sortTilesDepth(state: GameState): Tile[] {
    return Array.from(state.world.tiles.values()).sort((a, b) => {
      const ea = terrainElevation(a.terrain);
      const eb = terrainElevation(b.terrain);
      return isoDepthKey(a.coord.q, a.coord.r, ea) - isoDepthKey(b.coord.q, b.coord.r, eb);
    });
  }

  private drawExtrudedTile(tile: Tile, neighbors: Tile[], opts: IsoRenderOptions): void {
    const { ctx } = this;
    const elev = terrainElevation(tile.terrain);
    const center = axialToIsoPixel(tile.coord.q, tile.coord.r, HEX_SIZE, elev);
    const colors = TERRAIN_COLOR[tile.terrain] || TERRAIN_COLOR.plains;
    const alpha = tile.inFog && opts.fogEnabled ? 0.35 : 1;
    const showSides = opts.zoom >= 0.4 && opts.lod !== 'low';

    ctx.save();
    ctx.globalAlpha = alpha;

    if (showSides && elev > -1) {
      this.drawSideFaces(tile, neighbors, center, elev, colors.side, alpha);
    }

    const topCorners = isoHexCorners(center.x, center.y, HEX_SIZE, elev);
    ctx.beginPath();
    topCorners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
    ctx.closePath();

    if (colors.gradient) {
      const grad = ctx.createRadialGradient(
        center.x - HEX_SIZE * 0.15,
        center.y - HEX_SIZE * 0.2,
        HEX_SIZE * 0.1,
        center.x,
        center.y,
        HEX_SIZE * 0.85,
      );
      grad.addColorStop(0, colors.gradient[0]!);
      grad.addColorStop(1, colors.gradient[1]!);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = colors.fill;
    }
    ctx.fill();

    this.drawTopNoise(tile.terrain, topCorners, center, alpha * 0.35);
    this.drawBiomeTexture(tile.terrain, topCorners, center, tile.coord.q, tile.coord.r, alpha);

    // NW light bevel on top face
    ctx.save();
    ctx.beginPath();
    topCorners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
    ctx.closePath();
    ctx.clip();
    const lightGrad = ctx.createLinearGradient(
      center.x - HEX_SIZE,
      center.y - HEX_SIZE,
      center.x + HEX_SIZE * 0.5,
      center.y + HEX_SIZE * 0.5,
    );
    lightGrad.addColorStop(0, 'rgba(255,255,255,0.14)');
    lightGrad.addColorStop(0.6, 'rgba(255,255,255,0)');
    lightGrad.addColorStop(1, 'rgba(0,0,0,0.1)');
    ctx.fillStyle = lightGrad;
    ctx.fillRect(center.x - HEX_SIZE, center.y - HEX_SIZE, HEX_SIZE * 2, HEX_SIZE * 2);
    ctx.restore();

    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (tile.terrain === 'ocean') {
      this.drawShorelineIso(tile, neighbors, center, elev, opts.animTime);
    }

    ctx.restore();

    if (!tile.revealed) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#0a0a14';
      ctx.beginPath();
      topCorners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else if (tile.inFog && opts.fogEnabled) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#0d0d1a';
      ctx.beginPath();
      topCorners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  private drawSideFaces(
    tile: Tile,
    neighbors: Tile[],
    center: { x: number; y: number },
    elev: number,
    sideColor: string,
    alpha: number,
  ): void {
    const { ctx } = this;
    const top = isoHexCorners(center.x, center.y, HEX_SIZE, elev);

    for (let d = 0; d < 6; d++) {
      const dir = AXIAL_DIRECTIONS[d]!;
      const neighbor = neighbors.find(
        (n) => n.coord.q === tile.coord.q + dir.q && n.coord.r === tile.coord.r + dir.r,
      );
      const nElev = neighbor ? terrainElevation(neighbor.terrain) : -1;
      if (nElev >= elev) continue;

      const bottomElev = Math.max(nElev, -1);
      const bottom = isoHexCorners(center.x, center.y, HEX_SIZE, bottomElev);
      const ci = d;
      const cj = (d + 1) % 6;

      const shade = 0.85 + (d % 3) * 0.05;
      ctx.fillStyle = sideColor;
      ctx.globalAlpha = alpha * shade;
      ctx.beginPath();
      ctx.moveTo(top[ci]!.x, top[ci]!.y);
      ctx.lineTo(top[cj]!.x, top[cj]!.y);
      ctx.lineTo(bottom[cj]!.x, bottom[cj]!.y);
      ctx.lineTo(bottom[ci]!.x, bottom[ci]!.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
  }

  private drawBiomeTexture(
    terrain: Terrain,
    corners: Array<{ x: number; y: number }>,
    center: { x: number; y: number },
    q: number,
    r: number,
    alpha: number,
  ): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;

    // Clip to hex top face
    ctx.beginPath();
    corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
    ctx.closePath();
    ctx.clip();

    const seed = q * 17 + r * 31;

    switch (terrain) {
      case 'plains': {
        // Grass tufts
        for (let i = 0; i < 5; i++) {
          const angle = ((seed + i * 47) % 360) * (Math.PI / 180);
          const dist = HEX_SIZE * (0.15 + ((seed >> i) & 3) * 0.08);
          const tx = center.x + Math.cos(angle) * dist;
          const ty = center.y + Math.sin(angle) * dist * 0.6;
          ctx.strokeStyle = 'rgba(90, 130, 60, 0.45)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - 1, ty - 4);
          ctx.moveTo(tx + 1, ty);
          ctx.lineTo(tx + 2, ty - 3);
          ctx.stroke();
        }
        break;
      }
      case 'forest': {
        // Dark canopy speckle + small tree silhouettes
        ctx.fillStyle = 'rgba(20, 50, 20, 0.2)';
        for (let i = 0; i < 6; i++) {
          const tx = center.x + ((seed + i * 13) % 7 - 3) * 4;
          const ty = center.y + ((seed + i * 19) % 5 - 2) * 3;
          ctx.beginPath();
          ctx.arc(tx, ty, 3 + (i % 2), 0, Math.PI * 2);
          ctx.fill();
        }
        for (let i = 0; i < 2; i++) {
          const tx = center.x + (i === 0 ? -8 : 6);
          const ty = center.y + (i === 0 ? 2 : -2);
          ctx.fillStyle = 'rgba(15, 45, 15, 0.55)';
          ctx.beginPath();
          ctx.moveTo(tx, ty - 10);
          ctx.lineTo(tx + 7, ty + 2);
          ctx.lineTo(tx - 7, ty + 2);
          ctx.closePath();
          ctx.fill();
        }
        break;
      }
      case 'hills': {
        ctx.fillStyle = 'rgba(100, 90, 60, 0.25)';
        ctx.beginPath();
        ctx.ellipse(center.x - 4, center.y + 2, HEX_SIZE * 0.25, HEX_SIZE * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(120, 110, 70, 0.2)';
        ctx.beginPath();
        ctx.ellipse(center.x + 6, center.y - 3, HEX_SIZE * 0.18, HEX_SIZE * 0.1, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'mountain': {
        ctx.fillStyle = 'rgba(60, 60, 60, 0.35)';
        ctx.beginPath();
        ctx.moveTo(center.x, center.y - HEX_SIZE * 0.35);
        ctx.lineTo(center.x + HEX_SIZE * 0.28, center.y + 4);
        ctx.lineTo(center.x - HEX_SIZE * 0.28, center.y + 4);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(220, 230, 240, 0.5)';
        ctx.beginPath();
        ctx.moveTo(center.x, center.y - HEX_SIZE * 0.35);
        ctx.lineTo(center.x + 8, center.y - 10);
        ctx.lineTo(center.x - 8, center.y - 10);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'desert': {
        ctx.strokeStyle = 'rgba(180, 140, 90, 0.35)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
          const oy = center.y + (i - 1) * 6;
          ctx.beginPath();
          ctx.moveTo(center.x - HEX_SIZE * 0.3, oy);
          ctx.quadraticCurveTo(center.x, oy - 3, center.x + HEX_SIZE * 0.3, oy);
          ctx.stroke();
        }
        break;
      }
      case 'ocean': {
        ctx.strokeStyle = 'rgba(180, 220, 255, 0.35)';
        ctx.lineWidth = 1.2;
        for (let i = 0; i < 3; i++) {
          const oy = center.y + (i - 1) * 5;
          ctx.beginPath();
          ctx.moveTo(center.x - HEX_SIZE * 0.35, oy);
          ctx.quadraticCurveTo(center.x, oy + 2, center.x + HEX_SIZE * 0.35, oy);
          ctx.stroke();
        }
        break;
      }
      case 'ice': {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.beginPath();
        ctx.moveTo(center.x - 6, center.y);
        ctx.lineTo(center.x, center.y - 8);
        ctx.lineTo(center.x + 6, center.y);
        ctx.lineTo(center.x, center.y + 8);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'sacred': {
        ctx.strokeStyle = 'rgba(200, 168, 75, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(center.x, center.y, HEX_SIZE * 0.2, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }

  private drawTopNoise(
    terrain: Terrain,
    _corners: Array<{ x: number; y: number }>,
    center: { x: number; y: number },
    alpha: number,
  ): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.8;
    const seed = (center.x * 17 + center.y * 31) | 0;
    for (let i = 0; i < 4; i++) {
      const angle = ((seed + i * 73) % 360) * (Math.PI / 180);
      const len = HEX_SIZE * (0.15 + ((seed >> i) & 3) * 0.05);
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      ctx.lineTo(center.x + Math.cos(angle) * len, center.y + Math.sin(angle) * len * 0.5);
      ctx.stroke();
    }
    if (terrain === 'sacred') {
      ctx.fillStyle = 'rgba(200, 168, 75, 0.12)';
      ctx.beginPath();
      ctx.arc(center.x, center.y, HEX_SIZE * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawShorelineIso(
    _tile: Tile,
    neighbors: Tile[],
    center: { x: number; y: number },
    elev: number,
    animTime: number,
  ): void {
    const touchesLand = neighbors.some((n) => n.terrain !== 'ocean');
    if (!touchesLand) return;
    const { ctx } = this;
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const wave = prefersReducedMotion ? 0.95 : 0.92 + 0.03 * Math.sin(animTime * 2);
    const corners = isoHexCorners(center.x, center.y, HEX_SIZE * wave, elev);
    ctx.save();
    ctx.strokeStyle = 'rgba(150, 220, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  private drawEllipseShadow(x: number, y: number, rx: number, ry: number, alpha = 0.28): void {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.beginPath();
    ctx.ellipse(x, y + HEX_SIZE * 0.08, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawTerrainDecorIso(tile: Tile, opts: IsoRenderOptions): void {
    const elev = terrainElevation(tile.terrain);
    const pos = axialToIsoPixel(tile.coord.q, tile.coord.r, HEX_SIZE, elev);
    const alpha = tile.inFog && opts.fogEnabled ? 0.35 : 1;
    this.drawEllipseShadow(pos.x, pos.y, HEX_SIZE * 0.22, HEX_SIZE * 0.08);

    switch (tile.terrain) {
      case 'forest':
        this.drawDecorSprite('forest_sprite', pos, alpha, opts.animTime, 0.55);
        break;
      case 'mountain':
        this.drawDecorSprite('mountain_sprite', pos, alpha, opts.animTime, 0.75, -HEX_SIZE * 0.15);
        break;
      case 'hills':
        this.drawDecorSprite('hill_sprite', pos, alpha, opts.animTime, 0.45);
        break;
      case 'plains':
        if ((tile.coord.q + tile.coord.r) % 5 === 0) {
          this.drawDecorSprite('farm_patch', pos, alpha * 0.8, opts.animTime, 0.35);
        }
        break;
      default:
        break;
    }
  }

  private drawDecorSprite(
    name: string,
    pos: { x: number; y: number },
    alpha: number,
    animTime: number,
    scale: number,
    yOffset = 0,
  ): void {
    const { ctx } = this;
    const size = HEX_SIZE * scale;
    const sway =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 0
        : Math.sin(animTime * 1.5 + pos.x * 0.02) * 2;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(pos.x, pos.y + yOffset + sway);

    // Vector decor only in iso mode — photo atlas rects have opaque backgrounds.
    this.drawVectorDecorFallback(name, size);
    ctx.restore();
  }

  private drawVectorDecorFallback(name: string, size: number): void {
    const { ctx } = this;
    switch (name) {
      case 'forest_sprite':
      case 'hill_sprite':
        ctx.fillStyle = name === 'forest_sprite' ? '#1e4d2b' : '#6a8a4b';
        ctx.beginPath();
        ctx.moveTo(0, -size * 0.6);
        ctx.lineTo(size * 0.35, size * 0.1);
        ctx.lineTo(-size * 0.35, size * 0.1);
        ctx.fill();
        break;
      case 'mountain_sprite':
        ctx.fillStyle = '#4a4a4a';
        ctx.beginPath();
        ctx.moveTo(0, -size * 0.7);
        ctx.lineTo(size * 0.4, size * 0.15);
        ctx.lineTo(-size * 0.4, size * 0.15);
        ctx.fill();
        break;
      case 'farm_patch':
        ctx.fillStyle = '#8a9a5a';
        ctx.fillRect(-size * 0.3, -size * 0.1, size * 0.6, size * 0.25);
        break;
      case 'city_block': {
        ctx.fillStyle = '#5a4a38';
        ctx.fillRect(-size * 0.22, -size * 0.55, size * 0.44, size * 0.55);
        ctx.fillStyle = '#7a6a52';
        ctx.fillRect(-size * 0.16, -size * 0.9, size * 0.32, size * 0.38);
        ctx.fillStyle = 'rgba(255, 220, 150, 0.5)';
        ctx.fillRect(-size * 0.08, -size * 0.75, size * 0.06, size * 0.08);
        ctx.fillRect(size * 0.02, -size * 0.65, size * 0.06, size * 0.08);
        break;
      }
      default:
        break;
    }
  }

  drawCityTerritoryIso(
    city: City,
    getTile: (c: Axial) => Tile | undefined,
    animTime: number,
  ): void {
    const { ctx } = this;
    if (city.territory.length === 0) return;

    const inTerritory = new Set(city.territory.map((c) => `${c.q},${c.r}`));
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const pulse = prefersReducedMotion ? 0.95 : 0.75 + 0.25 * Math.sin(animTime * 3);
    const borderColor = city.isCapital
      ? `rgba(200, 168, 75, ${pulse})`
      : `rgba(122, 90, 46, ${pulse * 0.95})`;
    const borderWidth = city.isCapital ? 3 : 2;

    ctx.save();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = borderWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const coord of city.territory) {
      const tile = getTile(coord);
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      const center = axialToIsoPixel(coord.q, coord.r, HEX_SIZE, elev);
      const corners = isoHexCorners(center.x, center.y, HEX_SIZE, elev);

      for (let d = 0; d < 6; d++) {
        const dir = AXIAL_DIRECTIONS[d]!;
        const neighbor = `${coord.q + dir.q},${coord.r + dir.r}`;
        if (inTerritory.has(neighbor)) continue;
        const ci = d;
        const cj = (d + 1) % 6;
        ctx.beginPath();
        ctx.moveTo(corners[ci]!.x, corners[ci]!.y);
        ctx.lineTo(corners[cj]!.x, corners[cj]!.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawCityMarker(tile: Tile, state: GameState, opts: IsoRenderOptions): void {
    if (!tile.city) return;
    const city = tile.city;
    const elev = terrainElevation(tile.terrain);
    const pos = axialToIsoPixel(tile.coord.q, tile.coord.r, HEX_SIZE, elev);
    const { zoom, lod, showLabels } = opts;
    const activeBuilding = state.world.buildings.find(
      (b) => b.cityId === city.id && b.state === 'building',
    );

    if (zoom < 0.5) {
      this.drawEllipseShadow(pos.x, pos.y, HEX_SIZE * 0.18, HEX_SIZE * 0.06, 0.35);
      const { ctx } = this;
      ctx.save();
      ctx.fillStyle = city.isCapital ? '#f0d060' : '#c8a84b';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y - HEX_SIZE * 0.05, HEX_SIZE * 0.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (city.isCapital && showLabels && lod !== 'low') {
        this.hexR.drawCityLabel(city, pos, activeBuilding);
      }
      return;
    }

    if (zoom < 1.2) {
      this.drawCityBuildingCluster(pos, city, 3, opts.animTime);
      if (showLabels && lod !== 'low') {
        this.hexR.drawCityLabel(city, pos, activeBuilding);
      }
      return;
    }

    this.drawCityBuildingCluster(pos, city, 5, opts.animTime);
    if (showLabels) {
      this.hexR.drawCityLabel(city, pos, activeBuilding);
    }
    if (tile.district && lod === 'high') {
      this.hexR.drawDistrictLabel(tile.district.name, pos);
    }
    if (tile.skillHealth && showLabels) {
      this.hexR.drawSkillHealth(tile, pos);
    }
  }

  private drawCityBuildingCluster(
    pos: { x: number; y: number },
    city: City,
    count: number,
    animTime: number,
  ): void {
    this.drawEllipseShadow(pos.x, pos.y, HEX_SIZE * 0.28, HEX_SIZE * 0.1, 0.32);
    const { ctx } = this;
    const offsets = [
      { dx: 0, dy: 0, s: 0.42 },
      { dx: -14, dy: 4, s: 0.32 },
      { dx: 12, dy: 6, s: 0.28 },
      { dx: -6, dy: -8, s: 0.25 },
      { dx: 10, dy: -6, s: 0.22 },
    ];

    for (let i = 0; i < Math.min(count, offsets.length); i++) {
      const off = offsets[i]!;
      const bx = pos.x + off.dx;
      const by = pos.y + off.dy - ISO_EXTRUDE_H * 0.3;
      const size = HEX_SIZE * off.s;
      ctx.save();
      ctx.translate(bx, by);
      this.drawVectorDecorFallback('city_block', size);
      ctx.restore();
    }

    if (city.isCapital) {
      ctx.save();
      ctx.fillStyle = '#c8a84b';
      ctx.font = `${HEX_SIZE * 0.35}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('★', pos.x, pos.y - HEX_SIZE * 0.45 - Math.sin(animTime) * 1.5);
      ctx.restore();
    }
  }

  /** Draw hex outline on extruded top face (selection / hover). */
  drawHexOutlineIso(coord: Axial, tile: Tile | undefined, color: string, lw: number): void {
    const elev = tile ? terrainElevation(tile.terrain) : 0;
    const center = axialToIsoPixel(coord.q, coord.r, HEX_SIZE, elev);
    const corners = isoHexCorners(center.x, center.y, HEX_SIZE, elev);
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}
