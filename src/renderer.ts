// ─── RepoCiv — Canvas Renderer ─────────────────────────────────────────────────

import {
  type Axial,
  worldToAxial,
  axialToPixel,
  type Camera,
} from './hex.ts';
import {
  type Terrain,
  type Tile,
  type City,
  type Unit,
  type Building,
} from './types.ts';
import { type GameState } from './game.ts';
import { TERRAIN_COLOR } from './map.ts';

const HEX_SIZE = 52; // circumradius in pixels

// ─── Lerp ────────────────────────────────────────────────────────────────────
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ─── Renderer ────────────────────────────────────────────────────────────────
export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: GameState;

  private cam: Camera = { x: 0, y: 0, cx: 0, cy: 0, zoom: 1 };
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private camStart = { x: 0, y: 0 };

  private hoveredHex: Axial | null = null;
  private selectedUnit: Unit | null = null;
  private actionMode: 'none' | 'move' | 'build' = 'none';
  private showGrid = false;
  private showDebug = false;
  private fogEnabled = true;
  private animTime = 0;

  private resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, state: GameState) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.state = state;

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(document.body);

    this.setupInput();
  }

  // ─── Resize ────────────────────────────────────────────────────────────────
  private resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.cam.cx = this.canvas.width / 2;
    this.cam.cy = this.canvas.height / 2;
    // Center camera on world origin
    this.cam.x = 0;
    this.cam.y = 0;
  }

  // ─── Input ────────────────────────────────────────────────────────────────
  private setupInput() {
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.isDragging = true;
        this.dragStart = { x: e.clientX, y: e.clientY };
        this.camStart = { x: this.cam.x, y: this.cam.y };
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;

      const newHex = worldToAxial(wx, wy, HEX_SIZE, this.cam);
      this.hoveredHex = newHex;

      if (this.isDragging) {
        const dx = (wx - this.dragStart.x) / this.cam.zoom;
        const dy = (wy - this.dragStart.y) / this.cam.zoom;
        this.cam.x = this.camStart.x - dx;
        this.cam.y = this.camStart.y - dy;
      }

      // Update cursor
      this.canvas.style.cursor = this.isDragging ? 'grabbing' :
        this.getTileAt(wx, wy) ? 'pointer' : 'default';
    });

    this.canvas.addEventListener('mouseup', (e) => {
      if (e.button === 0 && !this.wasDrag(e)) {
        this.handleClick(e);
      }
      this.isDragging = false;
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.15, Math.min(4, this.cam.zoom * zoomFactor));
      // Zoom towards mouse
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const worldBefore = {
        x: (mx - this.cam.cx) / this.cam.zoom + this.cam.x,
        y: (my - this.cam.cy) / this.cam.zoom + this.cam.y,
      };
      this.cam.zoom = newZoom;
      const worldAfter = {
        x: (mx - this.cam.cx) / this.cam.zoom + this.cam.x,
        y: (my - this.cam.cy) / this.cam.zoom + this.cam.y,
      };
      this.cam.x += worldBefore.x - worldAfter.x;
      this.cam.y += worldBefore.y - worldAfter.y;
    }, { passive: false });

    // Right click to cancel action
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.actionMode = 'none';
      this.selectedUnit = null;
    });
  }

  private wasDrag(e: MouseEvent): boolean {
    return (
      Math.abs(e.clientX - this.dragStart.x) > 4 ||
      Math.abs(e.clientY - this.dragStart.y) > 4
    );
  }

  private getTileAt(wx: number, wy: number): Tile | null {
    const coord = worldToAxial(wx, wy, HEX_SIZE, this.cam);
    return this.state.world.tiles.get(tileKey(coord)) ?? null;
  }

  private handleClick(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const wx = e.clientX - rect.left;
    const wy = e.clientY - rect.top;
    const coord = worldToAxial(wx, wy, HEX_SIZE, this.cam);
    const tile = this.state.world.tiles.get(tileKey(coord));

    if (this.actionMode === 'move' && this.selectedUnit) {
      // Move selected unit to clicked hex
      this.state.moveUnit(this.selectedUnit.id, coord);
      this.actionMode = 'none';
      return;
    }

    if (this.actionMode === 'build' && this.selectedUnit && tile?.city) {
      // Start building on the city's current project
      const proj = tile.city.currentProject;
      this.state.startBuilding(
        tile.city.id,
        proj?.id ?? `building-${Date.now()}`,
        proj?.name ?? 'New Building',
        proj?.durationSeconds ?? 60,
      );
      this.actionMode = 'none';
      return;
    }

    // Select unit if present
    const unit = this.state.getUnitAt(coord);
    if (unit) {
      this.selectedUnit = unit;
      this.state.selectUnit(unit);
      this.canvas.style.cursor = 'pointer';
      this.onUnitSelect?.(unit);
      return;
    }

    // Click on city tile → select city + emit tile_inspected
    if (tile?.city) {
      this.onCitySelect?.(tile.city.id);
      this.onTileInspect?.(tile.city.name, coord, tile.city.id);
      return;
    }

    // Deselect
    this.selectedUnit = null;
    this.state.selectUnit(null);
    this.onUnitSelect?.(null);
  }

  // ─── Selection callbacks (set by main.ts) ────────────────────────────────
  onUnitSelect: ((unit: Unit | null) => void) | null = null;
  onCitySelect: ((cityId: string) => void) | null = null;
  onTileInspect: ((cityName: string, coord: { q: number; r: number }, repoPath: string) => void) | null = null;

  getCanvas(): HTMLCanvasElement { return this.canvas; }

  // ─── Game Loop ───────────────────────────────────────────────────────────
  start() {
    let lastTime = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1); // cap at 100ms
      lastTime = now;
      this.animTime += dt;

      this.render();
      this.drawMinimap();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  private render() {
    const { ctx, canvas, cam } = this;
    const W = canvas.width, H = canvas.height;

    // Clear
    ctx.fillStyle = '#0a0804';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    // Camera transform
    ctx.translate(cam.cx, cam.cy);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    // 1. Draw tiles
    for (const tile of this.state.world.tiles.values()) {
      this.drawTile(tile);
    }

    // 2. Draw city territory highlights
    for (const city of this.state.world.cities) {
      this.drawCityTerritory(city);
    }

    // 3. Draw grid
    if (this.showGrid) {
      for (const tile of this.state.world.tiles.values()) {
        this.drawHexOutline(tile.coord, '#ffffff18', 1);
      }
    }

    // 4. Draw buildings in progress
    for (const building of this.state.world.buildings) {
      this.drawBuilding(building);
    }

    // 5. Draw units
    for (const unit of this.state.world.units) {
      this.drawUnit(unit);
    }

    // 6. Draw movement range if unit selected
    if (this.selectedUnit && this.actionMode === 'move') {
      this.drawMoveRange(this.selectedUnit);
      this.drawMovementPath(this.selectedUnit);
    }

    // 7. Debug overlay
    if (this.showDebug) {
      for (const tile of this.state.world.tiles.values()) {
        this.drawHexOutline(tile.coord, '#ff000040', 1);
        const wp = axialToPixel(tile.coord, HEX_SIZE);
        ctx.save();
        ctx.fillStyle = '#ff0000';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${tile.coord.q},${tile.coord.r}`, wp.x, wp.y + HEX_SIZE * 0.6);
        ctx.restore();
      }
    }

    // 8. Hover highlight
    if (this.hoveredHex && !this.isDragging) {
      this.drawHexOutline(this.hoveredHex, '#c8a84b80', 2);
    }

    ctx.restore();
  }

  private drawTile(tile: Tile) {
    const { ctx } = this;
    const pos = axialToPixel(tile.coord, HEX_SIZE);
    const colors = TERRAIN_COLOR[tile.terrain]!;

    // Apply fog (toggle with V)
    const alpha = (tile.inFog && this.fogEnabled) ? 0.35 : 1;

    // Fill with gradient
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

    // Terrain decoration
    this.drawTerrainDecor(tile.terrain, pos, alpha);

    ctx.restore();

    // Session tint overlay
    if (tile.sessionTint === 'fog') {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#3a4a6a';
      this.fillHex(pos.x, pos.y, HEX_SIZE);
      ctx.restore();
    }

    // Skill health indicator (small ⚡ dot top-right)
    if (tile.city && tile.skillHealth) {
      const skillColor = tile.skillHealth === 'ok' ? '#5b9b5b'
        : tile.skillHealth === 'stale' ? '#c8a84b'
        : '#d45b5b';
      ctx.save();
      ctx.font = `${HEX_SIZE * 0.22}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = skillColor;
      ctx.fillText('⚡', pos.x + HEX_SIZE * 0.55, pos.y - HEX_SIZE * 0.55);
      ctx.restore();
    }

    // City name
    if (tile.city) {
      this.drawCityLabel(tile.city, pos);
    }

    // District label
    if (tile.district) {
      this.drawDistrictLabel(tile.district.name, pos);
    }
  }

  private fillHex(cx: number, cy: number, size: number) {
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

  private drawHexOutline(coord: Axial, color: string, lw: number) {
    const { ctx } = this;
    const pos = axialToPixel(coord, HEX_SIZE);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    this.fillHex(pos.x, pos.y, HEX_SIZE);
    ctx.stroke();
    ctx.restore();
  }

  private drawTerrainDecor(terrain: Terrain, pos: { x: number; y: number }, alpha: number) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = alpha * 0.5;

    switch (terrain) {
      case 'forest': {
        // Pine tree sprites
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
        // Triangle peaks
        ctx.fillStyle = '#4a4a4a';
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - HEX_SIZE * 0.38);
        ctx.lineTo(pos.x + HEX_SIZE * 0.28, pos.y + HEX_SIZE * 0.15);
        ctx.lineTo(pos.x - HEX_SIZE * 0.28, pos.y + HEX_SIZE * 0.15);
        ctx.closePath();
        ctx.fill();
        // Snow cap
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
        // Wave lines
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

  private drawCityTerritory(city: City) {
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

    // Capital star
    if (city.isCapital) {
      ctx.save();
      ctx.fillStyle = '#c8a84b';
      ctx.font = `${HEX_SIZE * 0.45}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('★', pos.x, pos.y - HEX_SIZE * 0.25);
      ctx.restore();
    }

    // Banner
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

  private drawUnit(unit: Unit) {
    const { ctx } = this;

    // Interpolate position if moving
    let ux: number, uy: number;
    if (unit.state === 'moving' && unit.path.length > 0 && unit.pathIndex < unit.path.length) {
      const from = axialToPixel(unit.path[unit.pathIndex]!, HEX_SIZE);
      const to = axialToPixel(unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!, HEX_SIZE);
      ux = lerp(from.x, to.x, unit.pathProgress);
      uy = lerp(from.y, to.y, unit.pathProgress);
    } else {
      const p = axialToPixel(unit.coord, HEX_SIZE);
      ux = p.x; uy = p.y;
    }

    // Idle float animation
    const floatY = Math.sin(this.animTime * 2.5 + ux * 0.01) * 2;

    ctx.save();
    ctx.translate(ux, uy + floatY);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(2, HEX_SIZE * 0.35, HEX_SIZE * 0.22, HEX_SIZE * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();

    // Selection halo
    if (this.selectedUnit?.id === unit.id) {
      ctx.strokeStyle = '#f0c050';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, HEX_SIZE * 0.45, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Unit circle
    ctx.beginPath();
    ctx.arc(0, 0, HEX_SIZE * 0.30, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1208';
    ctx.fill();
    ctx.strokeStyle = unit.color;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Initials
    const initials = unit.name.split(/[\s-_]/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase();
    ctx.fillStyle = unit.color;
    ctx.font = `bold ${HEX_SIZE * 0.28}px 'Cinzel', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, 0, 1);

    // Working progress ring
    if (unit.state === 'working' && unit.workProgress !== undefined) {
      ctx.strokeStyle = '#5b9b5b';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, HEX_SIZE * 0.38, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * unit.workProgress / 100));
      ctx.stroke();
    }

    // State indicator
    if (unit.state === 'sleeping') {
      ctx.font = `${HEX_SIZE * 0.25}px serif`;
      ctx.fillText('💤', 0, -HEX_SIZE * 0.5);
    }

    ctx.restore();
  }

  private drawMoveRange(unit: Unit) {
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
          this.fillHex(pos.x, pos.y, HEX_SIZE);
        }
      }
    }
    ctx.restore();
  }

  private drawMovementPath(unit: Unit) {
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

  private drawBuilding(building: Building) {
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

    // Background
    ctx.fillStyle = '#2a1e0a';
    ctx.fillRect(barX, barY, barW, barH);

    // Fill
    const barColor = building.type === 'wonder' ? '#c8a84b' : '#5b9b5b';
    ctx.fillStyle = barColor;
    ctx.fillRect(barX, barY, barW * pct, barH);

    // Border
    ctx.strokeStyle = building.type === 'wonder' ? '#f0c050' : '#7ab87a';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, barH);

    // Label
    ctx.fillStyle = '#e8d5a0';
    ctx.font = `${Math.max(8, HEX_SIZE * 0.18)}px 'Cinzel', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(
      `${building.name} ${Math.round(building.progress)}%`,
      pos.x,
      barY - 2
    );

    ctx.restore();
  }

  // ─── Public actions ───────────────────────────────────────────────────────
  setActionMode(mode: 'none' | 'move' | 'build') {
    this.actionMode = mode;
    const btnMove = document.getElementById('btn-move');
    const btnBuild = document.getElementById('btn-build');
    if (btnMove) btnMove.dataset['active'] = mode === 'move' ? 'true' : 'false';
    if (btnBuild) btnBuild.dataset['active'] = mode === 'build' ? 'true' : 'false';
  }

  sleepSelectedUnit() {
    if (this.selectedUnit) {
      this.state.setUnitState(this.selectedUnit.id, 'sleeping');
    }
  }

  toggleGrid() { this.showGrid = !this.showGrid; }
  toggleDebug() { this.showDebug = !this.showDebug; }
  toggleFog() { this.fogEnabled = !this.fogEnabled; }

  selectUnit(unit: Unit | null) {
    this.selectedUnit = unit;
  }

  // ─── Minimap rendering ──────────────────────────────────────────────────
  private minimapBounds = { minQ: 0, maxQ: 0, minR: 0, maxR: 0 };

  private computeMinimapBounds() {
    let minQ = Infinity, maxQ = -Infinity, minR = Infinity, maxR = -Infinity;
    for (const tile of this.state.world.tiles.values()) {
      if (tile.terrain === 'ocean' && !tile.revealed) continue;
      if (tile.coord.q < minQ) minQ = tile.coord.q;
      if (tile.coord.q > maxQ) maxQ = tile.coord.q;
      if (tile.coord.r < minR) minR = tile.coord.r;
      if (tile.coord.r > maxR) maxR = tile.coord.r;
    }
    this.minimapBounds = { minQ, maxQ, minR, maxR };
  }

  drawMinimap() {
    const mm = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
    if (!mm) return;
    const ctx = mm.getContext('2d');
    if (!ctx) return;

    this.computeMinimapBounds();
    const { minQ, maxQ, minR, maxR } = this.minimapBounds;
    if (!isFinite(minQ)) return;

    const padX = 2, padY = 2;
    const cellW = (mm.width  - padX * 2) / Math.max(1, (maxQ - minQ + 1));
    const cellH = (mm.height - padY * 2) / Math.max(1, (maxR - minR + 1));

    ctx.fillStyle = '#0a0804';
    ctx.fillRect(0, 0, mm.width, mm.height);

    for (const tile of this.state.world.tiles.values()) {
      const c = TERRAIN_COLOR[tile.terrain]!;
      ctx.fillStyle = tile.inFog && this.fogEnabled ? '#1a1208' : c.fill;
      const x = padX + (tile.coord.q - minQ) * cellW;
      const y = padY + (tile.coord.r - minR) * cellH + (tile.coord.q - minQ) * cellH * 0.5;
      ctx.fillRect(x, y, Math.max(1, cellW), Math.max(1, cellH));
      if (tile.city) {
        ctx.fillStyle = tile.city.isCapital ? '#f0c050' : '#c8a84b';
        ctx.fillRect(x - 1, y - 1, Math.max(2, cellW + 2), Math.max(2, cellH + 2));
      }
    }

    // Units
    for (const u of this.state.world.units) {
      const x = padX + (u.coord.q - minQ) * cellW;
      const y = padY + (u.coord.r - minR) * cellH + (u.coord.q - minQ) * cellH * 0.5;
      ctx.fillStyle = u.color;
      ctx.fillRect(x - 1, y - 1, 4, 4);
    }

    // Camera viewport indicator
    const HEX_SIZE_LOCAL = 52;
    const tlWorld = {
      x: this.cam.x - (this.canvas.width / 2) / this.cam.zoom,
      y: this.cam.y - (this.canvas.height / 2) / this.cam.zoom,
    };
    const brWorld = {
      x: this.cam.x + (this.canvas.width / 2) / this.cam.zoom,
      y: this.cam.y + (this.canvas.height / 2) / this.cam.zoom,
    };
    const worldQ = (px: number) => px / (HEX_SIZE_LOCAL * 1.5);
    const tlQ = worldQ(tlWorld.x), brQ = worldQ(brWorld.x);
    const x1 = padX + (tlQ - minQ) * cellW;
    const x2 = padX + (brQ - minQ) * cellW;
    const y1 = padY;
    const y2 = mm.height - padY;
    ctx.strokeStyle = '#c8a84b88';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.max(0, Math.min(mm.width, x1)),
      Math.max(0, Math.min(mm.height, y1)),
      Math.max(2, x2 - x1),
      Math.max(2, y2 - y1),
    );
  }

  minimapClick(mx: number, my: number) {
    const mm = document.getElementById('minimap-canvas') as HTMLCanvasElement | null;
    if (!mm) return;
    const { minQ, maxQ, minR, maxR } = this.minimapBounds;
    if (!isFinite(minQ)) return;
    const padX = 2, padY = 2;
    const cellW = (mm.width  - padX * 2) / Math.max(1, (maxQ - minQ + 1));
    const cellH = (mm.height - padY * 2) / Math.max(1, (maxR - minR + 1));
    const q = (mx - padX) / cellW + minQ;
    const r = (my - padY - (q - minQ) * cellH * 0.5) / cellH + minR;
    const HEX = 52;
    this.cam.x = HEX * 1.5 * q;
    this.cam.y = HEX * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  }
}

function tileKey(coord: Axial): string {
  return `${coord.q},${coord.r}`;
}
