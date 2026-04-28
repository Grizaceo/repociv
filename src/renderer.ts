// ─── RepoCiv — Renderer (orquestador) ────────────────────────────────────────
import {
  type Axial,
  worldToAxial,
  axialToPixel,
  type Camera,
} from './hex.ts';
import { type Unit, tileKey } from './types.ts';
import { type GameState } from './game.ts';
import { HexRenderer } from './hexRenderer.ts';
import { UnitRenderer } from './unitRenderer.ts';
import { MinimapRenderer } from './minimapRenderer.ts';
import { LocalRenderer, type LocalRenderer as LocalRendererType } from './localRenderer.ts';

const HEX_SIZE = 52;

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
  private hexR: HexRenderer;
  private unitR: UnitRenderer;
  private minimapR: MinimapRenderer;
  private localR: LocalRendererType | null = null; // Phase 6: RimWorld 2D view

  onUnitSelect: ((unit: Unit | null) => void) | null = null;
  onCitySelect: ((cityId: string) => void) | null = null;
  onTileInspect: ((cityName: string, coord: { q: number; r: number }, repoPath: string) => void) | null = null;
  onEnterLocal: ((repoId: string, rootPath: string) => void) | null = null; // Phase 6

  constructor(canvas: HTMLCanvasElement, state: GameState) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.state = state;
    this.hexR = new HexRenderer(this.ctx);
    this.unitR = new UnitRenderer(this.ctx, state);
    this.minimapR = new MinimapRenderer(state);

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(document.body);
    this.setupInput();
  }

  async loadAssets() {
    await this.hexR.loadAssets();
  }

  private resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.cam.cx = this.canvas.width / 2;
    this.cam.cy = this.canvas.height / 2;
    this.cam.x = 0;
    this.cam.y = 0;
  }

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
      this.hoveredHex = worldToAxial(wx, wy, HEX_SIZE, this.cam);
      if (this.isDragging) {
        const dx = (wx - this.dragStart.x) / this.cam.zoom;
        const dy = (wy - this.dragStart.y) / this.cam.zoom;
        this.cam.x = this.camStart.x - dx;
        this.cam.y = this.camStart.y - dy;
      }
      this.canvas.style.cursor = this.isDragging ? 'grabbing' :
        this.getTileAt(wx, wy) ? 'pointer' : 'default';
    });

    this.canvas.addEventListener('mouseup', (e) => {
      if (e.button === 0 && !this.wasDrag(e)) this.handleClick(e);
      this.isDragging = false;
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.15, Math.min(4, this.cam.zoom * factor));
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const before = {
        x: (mx - this.cam.cx) / this.cam.zoom + this.cam.x,
        y: (my - this.cam.cy) / this.cam.zoom + this.cam.y,
      };
      this.cam.zoom = newZoom;
      const after = {
        x: (mx - this.cam.cx) / this.cam.zoom + this.cam.x,
        y: (my - this.cam.cy) / this.cam.zoom + this.cam.y,
      };
      this.cam.x += before.x - after.x;
      this.cam.y += before.y - after.y;
    }, { passive: false });

    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.actionMode = 'none';
      this.selectedUnit = null;
    });

    // ── Phase 6: Double-click to enter RimWorld local view ──────────────────
    this.canvas.addEventListener('dblclick', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const coord = worldToAxial(wx, wy, HEX_SIZE, this.cam);
      const tile = this.state.world.tiles.get(tileKey(coord));
      if (tile?.city) {
        this.onEnterLocal?.(tile.city.id, tile.city.id);
      }
    });

    // ── Phase 6: Esc to return to macro view ─────────────────────────────────
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.state.viewMode === 'local') {
        this.state.enterMacroView();
        this.localR = null;
      }
    });
  }

  private wasDrag(e: MouseEvent): boolean {
    return Math.abs(e.clientX - this.dragStart.x) > 4 || Math.abs(e.clientY - this.dragStart.y) > 4;
  }

  private getTileAt(wx: number, wy: number) {
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
      this.state.moveUnit(this.selectedUnit.id, coord);
      this.actionMode = 'none';
      return;
    }

    if (this.actionMode === 'build' && this.selectedUnit && tile?.city) {
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

    const unit = this.state.getUnitAt(coord);
    if (unit) {
      this.selectedUnit = unit;
      this.state.selectUnit(unit);
      this.canvas.style.cursor = 'pointer';
      this.onUnitSelect?.(unit);
      return;
    }

    if (tile?.city) {
      this.onCitySelect?.(tile.city.id);
      this.onTileInspect?.(tile.city.name, coord, tile.city.id);
      return;
    }

    this.selectedUnit = null;
    this.state.selectUnit(null);
    this.onUnitSelect?.(null);
  }

  getCanvas(): HTMLCanvasElement { return this.canvas; }

  start() {
    let lastTime = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      this.animTime += dt;
      this.render();
      this.minimapR.draw(this.cam, this.canvas, this.fogEnabled);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private render() {
    const { ctx, canvas, cam } = this;
    ctx.fillStyle = '#050505'; // Deeper background
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // ─── Phase 6: Local RimWorld view ───────────────────────────────────────
    if (this.state.viewMode === 'local') {
      if (!this.localR && this.state.localWorld) {
        this.localR = new LocalRenderer(canvas, this.state.localWorld, this.state);
      }
      if (this.localR) {
        this.localR.draw();
      }
      return;
    }

    ctx.save();
    ctx.translate(cam.cx, cam.cy);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    // Pass 1: Surfaces & Shorelines
    for (const tile of this.state.world.tiles.values()) {
      const neighbors = this.getNeighbors(tile.coord);
      this.hexR.drawTileSurface(tile, this.fogEnabled, neighbors);
    }

    // Pass 2: Territory
    for (const city of this.state.world.cities) {
      this.hexR.drawCityTerritory(city);
    }

    // Pass 3: Decorations (Sorted by Y for depth)
    const allTiles = Array.from(this.state.world.tiles.values());
    allTiles.sort((a, b) => {
      const pa = axialToPixel(a.coord, HEX_SIZE);
      const pb = axialToPixel(b.coord, HEX_SIZE);
      return pa.y - pb.y;
    });

    for (const tile of allTiles) {
      this.hexR.drawTileDecor(tile, this.fogEnabled);
    }

    if (this.showGrid) {
      ctx.setLineDash([4, 8]);
      for (const tile of this.state.world.tiles.values()) {
        this.hexR.drawHexOutline(tile.coord, 'rgba(255,255,255,0.08)', 1);
      }
      ctx.setLineDash([]);
    }

    for (const building of this.state.world.buildings) {
      this.unitR.drawBuilding(building);
    }

    for (const unit of this.state.world.units) {
      this.unitR.drawUnit(unit, this.animTime, this.selectedUnit?.id ?? null);
    }

    if (this.selectedUnit && this.actionMode === 'move') {
      this.unitR.drawMoveRange(this.selectedUnit);
      this.unitR.drawMovementPath(this.selectedUnit);
    }

    if (this.showDebug) {
      for (const tile of this.state.world.tiles.values()) {
        this.hexR.drawHexOutline(tile.coord, '#ff000040', 1);
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

    if (this.hoveredHex && !this.isDragging) {
      this.hexR.drawHexOutline(this.hoveredHex, '#c8a84b80', 2);
    }

    ctx.restore();

    // Global Atmospheric Bloom / Lighting
    const grad = ctx.createRadialGradient(canvas.width/2, canvas.height/2, 0, canvas.width/2, canvas.height/2, canvas.width);
    grad.addColorStop(0, 'rgba(200, 180, 120, 0.03)'); // Warm center
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.2)');        // Vignette
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
    if (this.selectedUnit) this.state.setUnitState(this.selectedUnit.id, 'sleeping');
  }

  toggleGrid()  { this.showGrid = !this.showGrid; }
  toggleDebug() { this.showDebug = !this.showDebug; }
  toggleFog()   { this.fogEnabled = !this.fogEnabled; }

  selectUnit(unit: Unit | null) { this.selectedUnit = unit; }

  // Kept for minimap wiring (main.ts uses Renderer.minimapClick)
  minimapClick(mx: number, my: number) {
    this.minimapR.click(mx, my, this.cam);
  }

  // Kept for minimap compatibility
  drawMinimap() {
    this.minimapR.draw(this.cam, this.canvas, this.fogEnabled);
  }

  private getNeighbors(coord: Axial): Tile[] {
    const neighbors: Tile[] = [];
    const dirs = [
      { q: +1, r:  0 }, { q: +1, r: -1 }, { q:  0, r: -1 },
      { q: -1, r:  0 }, { q: -1, r: +1 }, { q:  0, r: +1 }
    ];
    for (const d of dirs) {
      const key = tileKey({ q: coord.q + d.q, r: coord.r + d.r });
      const t = this.state.world.tiles.get(key);
      if (t) neighbors.push(t);
    }
    return neighbors;
  }
}
