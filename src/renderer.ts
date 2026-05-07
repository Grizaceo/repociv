// ─── RepoCiv — Renderer (orquestador) ────────────────────────────────────────
import { type Axial, worldToAxial, axialToPixel, type Camera } from './hex.ts';
import { type Unit, type Tile, tileKey } from './types.ts';
import { type GameState } from './game.ts';
import { HexRenderer } from './hexRenderer.ts';
import { UnitRenderer } from './unitRenderer.ts';
import { MinimapRenderer } from './minimapRenderer.ts';
// LocalRenderer is lazy-loaded on first local-view entry to keep main bundle small.
type LocalRendererType = import('./localRenderer.ts').LocalRenderer;
import {
  interpretUnitDrag,
  interpretCityToCityDrag,
  interpretAreaSelect,
  contextMenuForCity,
  type SpatialDirective,
} from './spatialDirectives.ts';
import {
  renderDragGhost,
  renderAreaSelect,
  renderDropTarget,
  hideDirectivePreview,
  hideContextMenu,
} from './ui/spatialPreview.ts';
import { HEX_SIZE } from './constants.ts';

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
  private _placingMode = false; // true when user is picking a hex on map

  // ─── Fase 5: Spatial gesture state ────────────────────────────────────────
  private gestureMode: 'camera_pan' | 'unit_drag' | 'area_select' | 'route' = 'camera_pan';
  private draggedUnit: Unit | null = null;
  private routeFromCity: { tile: Tile; coord: Axial } | null = null;
  private ghostScreenPos: { x: number; y: number } | null = null;
  private areaStart: { x: number; y: number } | null = null; // screen coords
  private areaEnd: { x: number; y: number } | null = null;

  private resizeObserver: ResizeObserver;
  private hexR: HexRenderer;
  private unitR: UnitRenderer;
  private minimapR: MinimapRenderer;
  private localR: LocalRendererType | null = null; // Phase 6: RimWorld 2D view
  private _localRendererCtor: (new (canvas: HTMLCanvasElement) => LocalRendererType) | null = null;
  private localWorldId: string | null = null;
  /** Cached tile list sorted by Y — recomputed only when tile count changes. */
  private _tilesYSorted: Tile[] = [];
  private _tilesYSortedSize = -1;

  onUnitSelect: ((unit: Unit | null) => void) | null = null;
  onCitySelect: ((cityId: string) => void) | null = null;
  onTileInspect:
    | ((cityName: string, coord: { q: number; r: number }, repoPath: string) => void)
    | null = null;
  onEnterLocal: ((repoId: string, rootPath: string) => void) | null = null; // Phase 6
  /** Click on empty hex while in placing mode. */
  onEmptyTileClick: ((coord: import('./hex.ts').Axial) => void) | null = null;
  // ─── Fase 5 callbacks ─────────────────────────────────────────────────────
  onSpatialGesture:
    | ((directive: SpatialDirective, screenPos: { x: number; y: number }) => void)
    | null = null;
  onContextMenu:
    | ((items: ReturnType<typeof contextMenuForCity>, screenPos: { x: number; y: number }) => void)
    | null = null;
  // ─── Fase 9: Drag update callback (shows directive tooltip mid-drag) ───────
  onDragUpdate:
    | ((
        gesture: string,
        agentId: string,
        screenPos: { x: number; y: number },
        dropTarget?: { cityId?: string; cityName?: string; repoType?: string; testStatus?: string },
      ) => void)
    | null = null;

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
    // ── mousedown: decide gesture mode ──────────────────────────────────────
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const coord = worldToAxial(wx, wy, HEX_SIZE, this.cam);
      const tile = this.state.world.tiles.get(tileKey(coord)) ?? null;

      this.dragStart = { x: e.clientX, y: e.clientY };
      this.camStart = { x: this.cam.x, y: this.cam.y };

      // Priority 1: unit drag (unit under cursor)
      const unitHere = this.state.getUnitAt(coord);
      if (unitHere) {
        this.gestureMode = 'unit_drag';
        this.draggedUnit = unitHere;
        this.isDragging = false; // don't pan while dragging unit
        return;
      }

      // Priority 2: route (Shift + city tile)
      if (e.shiftKey && tile?.city) {
        this.gestureMode = 'route';
        this.routeFromCity = { tile, coord };
        this.isDragging = false;
        return;
      }

      // Priority 3: area select (Shift + empty tile)
      if (e.shiftKey) {
        this.gestureMode = 'area_select';
        this.areaStart = { x: wx, y: wy };
        this.areaEnd = { x: wx, y: wy };
        this.isDragging = false;
        return;
      }

      // Default: camera pan
      this.gestureMode = 'camera_pan';
      this.isDragging = true;
    });

    // ── mousemove ────────────────────────────────────────────────────────────
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      this.hoveredHex = worldToAxial(wx, wy, HEX_SIZE, this.cam);

      if (this.gestureMode === 'camera_pan' && this.isDragging) {
        const dx = (wx - this.dragStart.x) / this.cam.zoom;
        const dy = (wy - this.dragStart.y) / this.cam.zoom;
        this.cam.x = this.camStart.x - dx;
        this.cam.y = this.camStart.y - dy;
      }

      if (this.gestureMode === 'unit_drag' && this.draggedUnit) {
        this.ghostScreenPos = { x: wx, y: wy };
        this.canvas.style.cursor = 'grabbing';
        // Fase 9: notify tooltip of drag position + drop target context
        if (this.onDragUpdate && this.hoveredHex) {
          const dropTile = this.state.world.tiles.get(tileKey(this.hoveredHex));
          const dropCity = dropTile?.city;
          this.onDragUpdate(
            'drag_unit_to_city',
            this.draggedUnit.id,
            { x: e.clientX, y: e.clientY },
            dropCity
              ? {
                  cityId: dropCity.id,
                  cityName: dropCity.name,
                }
              : undefined,
          );
        }
      }

      if (this.gestureMode === 'area_select' && this.areaStart) {
        this.areaEnd = { x: wx, y: wy };
      }

      if (this.gestureMode === 'camera_pan') {
        this.canvas.style.cursor = this.isDragging
          ? 'grabbing'
          : this.getTileAt(wx, wy)
            ? 'pointer'
            : 'default';
      }
    });

    // ── mouseup: resolve gesture ─────────────────────────────────────────────
    this.canvas.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const screenPos = { x: e.clientX, y: e.clientY };

      switch (this.gestureMode) {
        case 'unit_drag': {
          const unit = this.draggedUnit;
          if (unit && this.wasDrag(e)) {
            // Dragged to a tile → interpret as spatial directive
            const coord = worldToAxial(wx, wy, HEX_SIZE, this.cam);
            const toTile = this.state.world.tiles.get(tileKey(coord));
            if (toTile) {
              const directive = interpretUnitDrag({
                unit,
                fromCoord: unit.coord,
                toTile,
                shiftHeld: e.shiftKey,
              });
              if (directive) {
                this.state.moveUnit(unit.id, coord);
                this.onSpatialGesture?.(directive, screenPos);
              } else {
                // No city target → treat as move order
                this.state.moveUnit(unit.id, coord);
              }
            }
          } else if (unit) {
            // Short click on unit → select
            this.selectedUnit = unit;
            this.state.selectUnit(unit);
            this.onUnitSelect?.(unit);
          }
          this.draggedUnit = null;
          this.ghostScreenPos = null;
          break;
        }

        case 'route': {
          if (this.routeFromCity && this.wasDrag(e)) {
            const coord = worldToAxial(wx, wy, HEX_SIZE, this.cam);
            const toTile = this.state.world.tiles.get(tileKey(coord));
            if (toTile?.city && toTile.city.id !== this.routeFromCity.tile.city?.id) {
              const directive = interpretCityToCityDrag({
                fromCity: this.routeFromCity.tile.city!,
                toCity: toTile.city,
                fromCoord: this.routeFromCity.coord,
                toCoord: coord,
                selectedUnit: this.selectedUnit,
              });
              if (directive) this.onSpatialGesture?.(directive, screenPos);
            }
          }
          this.routeFromCity = null;
          break;
        }

        case 'area_select': {
          if (this.areaStart && this.areaEnd && this.wasDrag(e)) {
            const minX = Math.min(this.areaStart.x, this.areaEnd.x);
            const maxX = Math.max(this.areaStart.x, this.areaEnd.x);
            const minY = Math.min(this.areaStart.y, this.areaEnd.y);
            const maxY = Math.max(this.areaStart.y, this.areaEnd.y);
            const selected: Tile[] = [];
            for (const tile of this.state.world.tiles.values()) {
              const px = axialToPixel(tile.coord, HEX_SIZE);
              // Convert world→screen
              const sx = (px.x - this.cam.x) * this.cam.zoom + this.cam.cx;
              const sy = (px.y - this.cam.y) * this.cam.zoom + this.cam.cy;
              if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) selected.push(tile);
            }
            const directive = interpretAreaSelect({
              tiles: selected,
              selectedUnit: this.selectedUnit,
            });
            if (directive) this.onSpatialGesture?.(directive, screenPos);
          }
          this.areaStart = null;
          this.areaEnd = null;
          break;
        }

        case 'camera_pan': {
          if (!this.wasDrag(e)) this.handleClick(e);
          break;
        }
      }

      this.gestureMode = 'camera_pan';
      this.isDragging = false;
      this.canvas.style.cursor = 'default';
    });

    // ── wheel: zoom ──────────────────────────────────────────────────────────
    this.canvas.addEventListener(
      'wheel',
      (e) => {
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
      },
      { passive: false },
    );

    // ── contextmenu (right-click): command palette ────────────────────────────
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.actionMode = 'none';
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const coord = worldToAxial(wx, wy, HEX_SIZE, this.cam);
      const tile = this.state.world.tiles.get(tileKey(coord));
      if (tile?.city) {
        const items = contextMenuForCity(tile.city, this.selectedUnit);
        this.onContextMenu?.(items, { x: e.clientX, y: e.clientY });
      } else {
        hideDirectivePreview();
        hideContextMenu();
        this.selectedUnit = null;
      }
    });

    // ── dblclick: enter RimWorld local view ──────────────────────────────────
    this.canvas.addEventListener('dblclick', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const coord = worldToAxial(wx, wy, HEX_SIZE, this.cam);
      const tile = this.state.world.tiles.get(tileKey(coord));
      if (tile?.city) {
        const cityId = tile.city.id;
        void (async () => {
          if (!this._localRendererCtor) {
            const mod = await import('./localRenderer.ts');
            this._localRendererCtor = mod.LocalRenderer;
          }
          this.onEnterLocal?.(cityId, cityId);
        })();
      }
    });

    // ── Esc: return to macro view ────────────────────────────────────────────
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

    // Placing mode: click empty hex → callback, then exit placing mode
    if (this._placingMode) {
      if (!tile?.city && !this.state.getUnitAt(coord)) {
        this.onEmptyTileClick?.(coord);
      }
      this.setPlacingMode(false);
      return;
    }

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

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getCamera(): { x: number; y: number; zoom: number } {
    return { x: this.cam.x, y: this.cam.y, zoom: this.cam.zoom };
  }

  centerOn(coord: import('./hex.ts').Axial) {
    const pos = axialToPixel(coord, HEX_SIZE);
    this.cam.x = -pos.x * this.cam.zoom + this.canvas.width / 2;
    this.cam.y = -pos.y * this.cam.zoom + this.canvas.height / 2;
  }

  private rafId = 0;

  stop() {
    cancelAnimationFrame(this.rafId);
  }

  start() {
    let lastTime = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      this.animTime += dt;
      this.render();
      this.minimapR.draw(this.cam, this.canvas, this.fogEnabled);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private render() {
    const { ctx, canvas, cam } = this;
    ctx.fillStyle = '#050505'; // Deeper background
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // ─── Phase 6: Local RimWorld view ───────────────────────────────────────
    if (this.state.viewMode === 'local') {
      if (!this.localR && this._localRendererCtor) {
        this.localR = new this._localRendererCtor(canvas);
        this.localR.setupInput();
      }
      if (!this.localR) return; // still loading module — next frame will retry
      if (this.state.localWorld && this.state.localWorld.repoId !== this.localWorldId) {
        this.localR.setWorld(this.state.localWorld);
        this.localWorldId = this.state.localWorld.repoId;
      }
      this.localR.render(this.state.getLocalUnits());
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
    const tileCount = this.state.world.tiles.size;
    if (tileCount !== this._tilesYSortedSize) {
      this._tilesYSorted = Array.from(this.state.world.tiles.values()).sort((a, b) => {
        const pa = axialToPixel(a.coord, HEX_SIZE);
        const pb = axialToPixel(b.coord, HEX_SIZE);
        return pa.y - pb.y;
      });
      this._tilesYSortedSize = tileCount;
    }
    const allTiles = this._tilesYSorted;

    for (const tile of allTiles) {
      // A2: find active building for this tile's city (if any)
      const activeBuilding = tile.city
        ? this.state.world.buildings.find(
            (b) => b.cityId === tile.city!.id && b.state === 'building',
          )
        : undefined;
      this.hexR.drawTileDecor(tile, this.fogEnabled, activeBuilding);
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
      const tile = this.state.world.tiles.get(tileKey(this.hoveredHex));
      const unitHere = this.state.getUnitAt(this.hoveredHex);
      if (this._placingMode) {
        // In placing mode: highlight only empty hexes with bright green
        if (!tile?.city && !unitHere) {
          this.hexR.drawHexOutline(this.hoveredHex, '#00ff00cc', 3);
        } else {
          this.hexR.drawHexOutline(this.hoveredHex, '#ff3333aa', 2); // occupied = red tint
        }
      } else {
        this.hexR.drawHexOutline(this.hoveredHex, '#c8a84b80', 2);
      }
    }

    ctx.restore();

    // ─── Fase 5: Spatial overlay (screen-space, outside camera transform) ──────
    if (this.draggedUnit && this.ghostScreenPos) {
      renderDragGhost(
        ctx,
        this.ghostScreenPos.x,
        this.ghostScreenPos.y,
        this.draggedUnit.color,
        this.draggedUnit.id,
      );
      if (this.hoveredHex) {
        const toTile = this.state.world.tiles.get(tileKey(this.hoveredHex));
        const px = axialToPixel(this.hoveredHex, HEX_SIZE);
        const sx = (px.x - cam.x) * cam.zoom + cam.cx;
        const sy = (px.y - cam.y) * cam.zoom + cam.cy;
        renderDropTarget(ctx, sx, sy, HEX_SIZE * cam.zoom, !!toTile?.city);
      }
    }
    if (this.areaStart && this.areaEnd) {
      renderAreaSelect(ctx, this.areaStart.x, this.areaStart.y, this.areaEnd.x, this.areaEnd.y);
    }

    // Global Atmospheric Bloom / Lighting
    const grad = ctx.createRadialGradient(
      canvas.width / 2,
      canvas.height / 2,
      0,
      canvas.width / 2,
      canvas.height / 2,
      canvas.width,
    );
    grad.addColorStop(0, 'rgba(200, 180, 120, 0.03)'); // Warm center
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.2)'); // Vignette
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

  /** Enter/exit placing mode: user clicks empty hex to pick a coordinate. */
  setPlacingMode(active: boolean) {
    this._placingMode = active;
    this.canvas.style.cursor = active ? 'crosshair' : 'default';
  }
  getPlacingMode(): boolean {
    return this._placingMode;
  }

  sleepSelectedUnit() {
    if (this.selectedUnit) this.state.setUnitState(this.selectedUnit.id, 'sleeping');
  }

  toggleGrid() {
    this.showGrid = !this.showGrid;
  }
  toggleDebug() {
    this.showDebug = !this.showDebug;
  }
  toggleFog() {
    this.fogEnabled = !this.fogEnabled;
  }

  selectUnit(unit: Unit | null) {
    this.selectedUnit = unit;
  }

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
      { q: +1, r: 0 },
      { q: +1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: -1, r: +1 },
      { q: 0, r: +1 },
    ];
    for (const d of dirs) {
      const key = tileKey({ q: coord.q + d.q, r: coord.r + d.r });
      const t = this.state.world.tiles.get(key);
      if (t) neighbors.push(t);
    }
    return neighbors;
  }
}
