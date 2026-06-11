// ─── RepoCiv — Renderer (orquestador) ────────────────────────────────────────
import { type Axial, worldToAxial, axialToPixel, type Camera } from './hex.ts';
import { logger } from './logger.ts';
import { type Unit, type Tile, type City, tileKey } from './types.ts';
import { type GameState } from './game.ts';
import { HexRenderer } from './hexRenderer.ts';
import { UnitRenderer } from './unitRenderer.ts';
import { MinimapRenderer } from './minimapRenderer.ts';
import { openWonderVignette } from './ui/wonderVignette.ts';
import { openCapitalPanel } from './ui/capitalPanel.ts';
import { isLayerVisible } from './layers.ts';
import { updateLodDisplay } from './ui/layerPanel.ts';
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
  hideDirectivePreview,
  hideContextMenu,
} from './ui/spatialPreview.ts';
import { relocateCity, canRelocateCityTo } from './map.ts';
import { refreshCityList } from './ui/constructionPanel.ts';
import { HEX_SIZE } from './constants.ts';
import { renderScreenOverlays, type ScreenOverlayState } from './rendererScreen.ts';
import {
  type WorldRenderMode,
  persistRenderMode,
  loadThreeMapRenderer,
} from './three/renderMode.ts';

type ThreeMapRendererType = import('./three/ThreeMapRenderer.ts').ThreeMapRenderer;

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
  private selectedCity: City | null = null;
  private unitTooltipEl: HTMLDivElement | null = null;
  private actionMode: 'none' | 'move' | 'build' = 'none';
  private showGrid = false;
  private showDebug = false;
  private fogEnabled = true;
  private _cleanMode = false;
  private _currentLod: 'low' | 'medium' | 'high' = 'medium';
  private worldRenderMode: WorldRenderMode = 'flat';
  private animTime = 0;
  /** Non-null = animTime pinned (deterministic golden captures, ?freeze=). */
  private _frozenAnimTime: number | null = null;
  // Phase D: WebGL frame metrics
  private _frameTimeSum = 0;
  private _frameTimeCount = 0;
  private _frameTimeAvg = 0;
  private _totalFrameCount = 0;
  private _placingMode = false; // true when user is picking a hex on map

  /** Panel-driven city relocate (drag city on map; no full gestureMode fork). */
  private _cityRelocateMode = false;
  private _cityRelocatePanelRepoPath: string | null = null;
  private draggedCity: City | null = null;
  private dragCityRepoPath: string | null = null;
  private dragStartPos: { x: number; y: number } | null = null;
  private relocateDragActive = false;
  private cityGhostScreenPos: { x: number; y: number } | null = null;

  private readonly _onCityRelocateKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this._cityRelocateMode) return;
    e.preventDefault();
    this.setCityRelocateMode(false);
  };

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
  private threeMap: ThreeMapRendererType | null = null;
  private threeContainer: HTMLElement | null = null;
  private threeLoadPromise: Promise<void> | null = null;
  private _previousViewMode: 'macro' | 'local' | null = null; // Track view mode for transitions
  private _localExitInProgress = false;
  // Callbacks for local view (applied lazily when localR is instantiated)
  localUnitHoverCb:
    | ((unit: import('./types.ts').LocalUnit | null, screenX: number, screenY: number) => void)
    | null = null;
  localWorkbenchClickCb:
    | ((tile: import('./types.ts').LocalTile, screenX: number, screenY: number) => void)
    | null = null;
  localUnitClickCb:
    | ((unit: import('./types.ts').LocalUnit, screenX: number, screenY: number) => void)
    | null = null;
  localNpcClickCb:
    | ((npc: import('./types.ts').LocalNpc, screenX: number, screenY: number) => void)
    | null = null;
  localTileClickCb:
    | ((
        x: number,
        y: number,
        tile: import('./types.ts').LocalTile | null,
        screenX: number,
        screenY: number,
      ) => void)
    | null = null;
  // Phase 9: bubble layer callbacks
  localUnitRenderedCb:
    | ((unit: import('./types.ts').LocalUnit, screenX: number, screenY: number) => void)
    | null = null;
  // Zone painting callback
  onZonePaintedCb:
    | ((type: import('./types.ts').ZoneType, tiles: Array<{ x: number; y: number }>) => void)
    | null = null;
  onExitLocalView: (() => void) | null = null;
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
    this.canvas.tabIndex = 0;
    this.ctx = canvas.getContext('2d')!;
    this.state = state;
    this.hexR = new HexRenderer(this.ctx);
    this.unitR = new UnitRenderer(this.ctx, state);
    this.minimapR = new MinimapRenderer(state);

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(document.body);
    this.setupInput();
    document.addEventListener('keydown', this._onCityRelocateKeyDown);
  }

  private clearCityRelocateDrag() {
    this.draggedCity = null;
    this.dragCityRepoPath = null;
    this.dragStartPos = null;
    this.relocateDragActive = false;
    this.cityGhostScreenPos = null;
  }

  async loadAssets() {
    await this.hexR.loadAssets();
  }

  /** Toggle global map between flat 2D hex and WebGL (hotkey 2).
   *  With iso25d retired, the toggle is the only fast way to flip
   *  between the two surviving world renderers. */
  toggleWorldRenderMode(): WorldRenderMode {
    const next: WorldRenderMode = this.worldRenderMode === 'webgl' ? 'flat' : 'webgl';
    void this.setWorldRenderMode(next);
    return next;
  }

  /** Cycle world render mode (hotkey 3). Currently the same as toggle. */
  cycleWorldRenderMode(): WorldRenderMode {
    return this.toggleWorldRenderMode();
  }

  async setWorldRenderMode(mode: WorldRenderMode): Promise<void> {
    if (mode === this.worldRenderMode && (mode !== 'webgl' || this.threeMap)) return;

    if (mode === 'webgl') {
      try {
        await this.ensureThreeMap();
      } catch (err) {
        logger.error('[Renderer] WebGL init failed, falling back to flat', err);
        mode = 'flat';
      }
      if (mode === 'webgl' && this.threeMap) {
        this.worldRenderMode = 'webgl';
        persistRenderMode('webgl');
        this.threeMap.setActive(true);
        this.threeMap.resize();
        this.canvas.classList.add('webgl-overlay');
        return;
      }
      mode = 'flat';
    }

    this.worldRenderMode = mode;
    persistRenderMode(mode);
    this.threeMap?.setActive(false);
    this.canvas.classList.remove('webgl-overlay');
  }

  getWorldRenderMode(): WorldRenderMode {
    return this.worldRenderMode;
  }

  private async ensureThreeMap(): Promise<void> {
    if (this.threeMap) return;
    if (!this.threeLoadPromise) {
      this.threeLoadPromise = (async () => {
        this.threeContainer =
          this.threeContainer ?? document.getElementById('three-container');
        if (!this.threeContainer) {
          throw new Error('#three-container not found');
        }
        const ThreeMapRenderer = await loadThreeMapRenderer();
        this.threeMap = new ThreeMapRenderer(this.threeContainer);
      })();
    }
    try {
      await this.threeLoadPromise;
    } catch (err) {
      this.threeLoadPromise = null;
      throw err;
    }
    if (!this.threeMap) {
      throw new Error('ThreeMapRenderer failed to initialize');
    }
  }

  /** Apply saved URL/localStorage mode after construction. */
  async applyInitialRenderMode(mode: WorldRenderMode): Promise<void> {
    await this.setWorldRenderMode(mode);
  }

  /** Center macro camera on world tile bounds (fallback when no capital). */
  focusOnWorldBounds(): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const tile of this.state.world.tiles.values()) {
      const pos = axialToPixel(tile.coord, HEX_SIZE);
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x);
      minY = Math.min(minY, pos.y);
      maxY = Math.max(maxY, pos.y);
    }
    if (!Number.isFinite(minX)) return;
    this.cam.x = (minX + maxX) / 2;
    this.cam.y = (minY + maxY) / 2;
  }

  /** Center macro camera on an axial hex (works before WebGL is loaded).
   *
   *  One formula for both modes: axialToWorld3D() is axialToPixel() with
   *  y→z, so 2D map space and 3D world XZ are numerically identical and
   *  syncCamera() consumes cam.x/y directly as the 3D look-at target.
   *  (The old WebGL branch projected through the not-yet-synced three
   *  camera at boot — w≈0 → NaN — and poisoned cam.x/y permanently.) */
  focusOnCoord(coord: import('./hex.ts').Axial): void {
    const pos = axialToPixel(coord, HEX_SIZE);
    this.cam.x = pos.x;
    this.cam.y = pos.y;
  }

  private pickAxial(wx: number, wy: number): Axial {
    if (this.worldRenderMode === 'webgl' && this.threeMap) {
      const picked = this.threeMap.pickAxial(wx, wy);
      if (picked) return picked;
    }
    return worldToAxial(wx, wy, HEX_SIZE, this.cam);
  }

  private tilePixelPos(coord: Axial, _tile?: Tile | null): { x: number; y: number } {
    if (this.worldRenderMode === 'webgl' && this.threeMap) {
      return this.threeMap.projectTileCenter(coord, this.state, this.cam);
    }
    return axialToPixel(coord, HEX_SIZE);
  }

  private drawHexHighlight(coord: Axial, color: string, lw: number): void {
    if (this.worldRenderMode === 'webgl' && this.threeMap) {
      const corners = this.threeMap.projectHexOutline(coord, this.state, this.cam);
      const { ctx } = this;
      ctx.beginPath();
      corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = lw / this.cam.zoom;
      ctx.stroke();
      return;
    }
    this.hexR.drawHexOutline(coord, color, lw);
  }

  async preloadLocalRenderer() {
    if (this._localRendererCtor) return;
    const mod = await import('./localRenderer.ts');
    this._localRendererCtor = mod.LocalRenderer;
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || window.innerWidth));
    const h = Math.max(1, Math.round(rect.height || window.innerHeight));
    this.canvas.width = w;
    this.canvas.height = h;
    this.cam.cx = w / 2;
    this.cam.cy = h / 2;
    this.threeMap?.resize();
  }

  private setupInput() {
    // ── mousedown: decide gesture mode ──────────────────────────────────────
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const coord = this.pickAxial(wx, wy);
      const tile = this.state.world.tiles.get(tileKey(coord)) ?? null;

      if (this._cityRelocateMode && tile?.city) {
        this.dragStart = { x: e.clientX, y: e.clientY };
        this.camStart = { x: this.cam.x, y: this.cam.y };
        this.dragStartPos = { x: e.clientX, y: e.clientY };
        this.draggedCity = tile.city;
        this.dragCityRepoPath = this._cityRelocatePanelRepoPath ?? tile.city.repoPath ?? null;
        this._cityRelocatePanelRepoPath = null;
        this.relocateDragActive = false;
        this.cityGhostScreenPos = { x: wx, y: wy };
        this.gestureMode = 'camera_pan';
        this.isDragging = false;
        return;
      }

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
      this.hoveredHex = this.pickAxial(wx, wy);
      this.updateUnitTooltip(e.clientX, e.clientY);

      if (this._cityRelocateMode && this.draggedCity && this.dragStartPos) {
        const dx = e.clientX - this.dragStartPos.x;
        const dy = e.clientY - this.dragStartPos.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.relocateDragActive = true;
        this.cityGhostScreenPos = { x: wx, y: wy };
      }

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

      if (
        this.gestureMode === 'camera_pan' &&
        this._cityRelocateMode &&
        this.draggedCity &&
        this.relocateDragActive
      ) {
        this.canvas.style.cursor = 'grabbing';
      } else if (this.gestureMode === 'camera_pan') {
        if (this.isDragging) {
          this.canvas.style.cursor = 'grabbing';
        } else {
          this.applyIdleCursor(wx, wy);
        }
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
          const dragged = unit ? this.wasDrag(e) : false;
          if (unit && dragged) {
            // Dragged to a tile → interpret as spatial directive
            const coord = this.pickAxial(wx, wy);
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
            const coord = this.pickAxial(wx, wy);
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
              const px = this.tilePixelPos(tile.coord, tile);
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
          if (this._cityRelocateMode && this.draggedCity && this.dragStartPos) {
            const dsp = this.dragStartPos;
            const dragMoved = Math.abs(e.clientX - dsp.x) > 3 || Math.abs(e.clientY - dsp.y) > 3;
            const dropCoord = this.pickAxial(wx, wy);
            const dc = this.draggedCity;
            const path = this.dragCityRepoPath;
            if (dragMoved) {
              void relocateCity(this.state.world, dc.id, dropCoord, path).then((ok) => {
                if (ok) {
                  this.state.notifyUpdate();
                  refreshCityList();
                  this.setCityRelocateMode(false);
                }
              });
            } else {
              const t = this.state.world.tiles.get(tileKey(dropCoord));
              if (t?.city) {
                this.onCitySelect?.(t.city.id);
                this.onTileInspect?.(t.city.name, dropCoord, t.city.id);
              }
            }
            this.clearCityRelocateDrag();
            break;
          }
          if (!this.wasDrag(e)) this.handleClick(e);
          break;
        }
      }

      this.gestureMode = 'camera_pan';
      this.isDragging = false;
      this.applyIdleCursor(wx, wy);
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
      const coord = this.pickAxial(wx, wy);
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

    // ── mouseleave: hide unit tooltip ────────────────────────────────────────
    this.canvas.addEventListener('mouseleave', () => {
      if (this.unitTooltipEl) this.unitTooltipEl.style.display = 'none';
    });

    // ── dblclick: enter RimWorld local view ──────────────────────────────────
    this.canvas.addEventListener('dblclick', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const coord = this.pickAxial(wx, wy);
      const tile = this.state.world.tiles.get(tileKey(coord));
      const city = tile?.city ?? this.getCityAtScreen(wx, wy);

      // Priority 1: wonder district hex (Bibliotheca / LabHub tiles)
      if (tile?.district?.type === 'wonder' && tile.district.wonderType) {
        openWonderVignette(tile.district.wonderType as import('./types').WonderType);
        return;
      }

      // Priority 2: legacy wonder sprite hit test (small circles near capital)
      const wonder = this.hitWonderAt(wx, wy);
      if (wonder) {
        openWonderVignette(wonder as import('./types').WonderType);
        return;
      }

      // Priority 3: capital city → capital panel
      if (city) {
        if (city.isCapital) {
          openCapitalPanel();
          return;
        }
        const cityId = city.id;
        void this.preloadLocalRenderer();
        this.onEnterLocal?.(cityId, cityId);
      }
    });

    // ── Esc: return to macro view ────────────────────────────────────────────
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.state.viewMode === 'local') {
        this.state.enterMacroView();
      }
    });
  }

  private wasDrag(e: MouseEvent): boolean {
    return Math.abs(e.clientX - this.dragStart.x) > 4 || Math.abs(e.clientY - this.dragStart.y) > 4;
  }

  private getTileAt(wx: number, wy: number) {
    const coord = this.pickAxial(wx, wy);
    return this.state.world.tiles.get(tileKey(coord)) ?? null;
  }

  private getCityAtScreen(wx: number, wy: number): City | null {
    const exact = this.getTileAt(wx, wy)?.city ?? null;
    if (exact) return exact;

    const worldX = (wx - this.cam.cx) / this.cam.zoom + this.cam.x;
    const worldY = (wy - this.cam.cy) / this.cam.zoom + this.cam.y;
    const threshold = HEX_SIZE * 0.95;

    let best: City | null = null;
    let bestDistance = Infinity;
    for (const city of this.state.world.cities) {
      const tile = this.state.world.tiles.get(tileKey(city.coord));
      const pos = this.tilePixelPos(city.coord, tile);
      const distance = Math.hypot(worldX - pos.x, worldY - pos.y);
      if (distance <= threshold && distance < bestDistance) {
        best = city;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Cursor when not actively grabbing/panning (respects placing + city relocate modes). */
  private applyIdleCursor(wx: number, wy: number) {
    if (this._placingMode || this._cityRelocateMode) {
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    this.canvas.style.cursor = this.getTileAt(wx, wy) ? 'pointer' : 'default';
  }

  private syncChromeCursor() {
    if (this._placingMode || this._cityRelocateMode) {
      this.canvas.style.cursor = 'crosshair';
    } else {
      this.canvas.style.cursor = 'default';
    }
  }

  private handleClick(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const wx = e.clientX - rect.left;
    const wy = e.clientY - rect.top;
    const coord = this.pickAxial(wx, wy);
    const tile = this.state.world.tiles.get(tileKey(coord));
    const city = tile?.city ?? this.getCityAtScreen(wx, wy);

    // Placing mode: click empty hex → callback, then exit placing mode
    if (this._placingMode) {
      if (!city && !this.state.getUnitAt(coord)) {
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

    if (this.actionMode === 'build' && this.selectedUnit && city) {
      const proj = city.currentProject;
      this.state.startBuilding(
        city.id,
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
      this.selectedCity = null;
      this.state.selectUnit(unit);
      this.canvas.style.cursor = 'pointer';
      this.onUnitSelect?.(unit);
      return;
    }

    if (city) {
      this.selectedUnit = null;
      this.selectedCity = city;
      this.state.selectUnit(null);
      this.onUnitSelect?.(null);
      this.onCitySelect?.(city.id);
      this.onTileInspect?.(city.name, city.coord, city.id);
      return;
    }

    this.selectedUnit = null;
    this.selectedCity = null;
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
    this.focusOnCoord(coord);
  }

  /**
   * Set the camera to an explicit (x, y, zoom). Used by the visual
   * regression script (scripts/screenshot-3d-audit.mjs) and e2e specs
   * to take screenshots from a known viewpoint. The URL parser in
   * applyInitialRenderMode() routes ?cam=x,y,zoom to this.
   */
  setCamera(x: number, y: number, zoom: number): void {
    this.cam.x = x;
    this.cam.y = y;
    this.cam.zoom = zoom;
  }

  /**
   * Parse a `?cam=x,y,zoom` URL fragment and apply it to the camera.
   * No-op if the param is absent or malformed. Used by the visual
   * regression script for reproducible viewpoints.
   */
  applyCameraFromUrl(): void {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('cam');
    if (raw) {
      const parts = raw.split(',');
      if (parts[0] === 'auto') {
        // `?cam=auto,<zoom>` keeps the app's own (deterministic) centering
        // and overrides only the zoom — the golden captures use this so
        // they don't need to know the world centroid for a given seed.
        const zoom = Number(parts[1]);
        if (Number.isFinite(zoom) && zoom > 0) {
          this.setCamera(this.cam.x, this.cam.y, zoom);
        }
      } else {
        const nums = parts.map((s) => Number(s.trim()));
        const x = nums[0];
        const y = nums[1];
        const zoom = nums[2];
        if (
          x !== undefined &&
          y !== undefined &&
          zoom !== undefined &&
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          Number.isFinite(zoom) &&
          zoom > 0
        ) {
          this.setCamera(x, y, zoom);
        }
      }
    }
    // `?freeze=<seconds>` pins animTime to a constant. Without it, the
    // SHA-exact golden comparison depends on capture-timing jitter:
    // shoreline pulse, sun arc, and territory shimmer all read animTime.
    const freezeRaw = params.get('freeze');
    if (freezeRaw !== null) {
      const t = Number(freezeRaw);
      this._frozenAnimTime = Number.isFinite(t) && t >= 0 ? t : 0;
      this.animTime = this._frozenAnimTime;
    }
  }

  panTo(worldX: number, worldY: number) {
    this.cam.x = worldX;
    this.cam.y = worldY;
  }

  private rafId = 0;

  stop() {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    document.removeEventListener('keydown', this._onCityRelocateKeyDown);
    this.threeMap?.dispose();
    this.threeMap = null;
  }

  /** True when the WebGL terrain atlas finished loading (capture scripts). */
  isTerrainAtlasReady(): boolean {
    return this.threeMap?.isAtlasReady() ?? false;
  }

  /** Phase D: WebGL frame metrics for observability panel. */
  getWebGLMetrics(): { frameTimeAvg: number; frameCount: number; dirtyRatePct: number } | null {
    if (this.worldRenderMode !== 'webgl') return null;
    return {
      frameTimeAvg: this._frameTimeAvg,
      frameCount: this._totalFrameCount,
      dirtyRatePct: this.threeMap?.getDirtyRatePct() ?? 0,
    };
  }

  start() {
    let lastTime = performance.now();
    const loop = (now: number) => {
      const frameStart = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      if (this._frozenAnimTime === null) {
        this.animTime += dt;
      } else {
        this.animTime = this._frozenAnimTime;
      }
      this.render();
      this.minimapR.draw(this.cam, this.canvas, this.fogEnabled);
      // Phase D: track frame time and dirty rate
      if (this.worldRenderMode === 'webgl') {
        const frameMs = performance.now() - frameStart;
        this._frameTimeSum += frameMs;
        this._frameTimeCount++;
        this._totalFrameCount++;
        // Rolling average every 60 frames
        if (this._frameTimeCount >= 60) {
          this._frameTimeAvg = Math.round(this._frameTimeSum / this._frameTimeCount * 100) / 100;
          this._frameTimeSum = 0;
          this._frameTimeCount = 0;
        }
        // Reset rolling window every 600 frames (~10s)
        if (this._totalFrameCount >= 600) {
          this._totalFrameCount = 0;
        }
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }


  private screenOverlayState(): ScreenOverlayState {
    return {
      ctx: this.ctx,
      canvas: this.canvas,
      cam: this.cam,
      animTime: this.animTime,
      draggedUnit: this.draggedUnit,
      ghostScreenPos: this.ghostScreenPos,
      draggedCity: this.draggedCity,
      cityGhostScreenPos: this.cityGhostScreenPos,
      relocateDragActive: this.relocateDragActive,
      areaStart: this.areaStart,
      areaEnd: this.areaEnd,
      hoveredHex: this.hoveredHex,
      tiles: this.state.world.tiles,
      tilePixelPos: (coord, tile) => this.tilePixelPos(coord, tile),
      canRelocateTo: (hex) => this.draggedCity ? canRelocateCityTo(this.state.world, this.draggedCity, hex) : false,
    };
  }

  private render() {
    const { ctx, canvas, cam } = this;
    const webglMode = this.worldRenderMode === 'webgl' && this.threeMap !== null;

    if (webglMode) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Compute LOD from zoom level
    this._currentLod = this.calcLod();
    updateLodDisplay(cam.zoom);

    // ─── Phase 6: Local RimWorld view ───────────────────────────────────────
    const currentViewMode = this.state.viewMode === 'local' ? 'local' : 'macro';
    const viewModeChanged = currentViewMode !== this._previousViewMode;

    if (currentViewMode === 'local' && !this.localR && this._localRendererCtor) {
      this.localR = new this._localRendererCtor(canvas);
      this.localR.setupInput();
      this.localR.onRequestExit = () => this.state.enterMacroView();
      // Wire stored local-view callbacks (set from main.ts)
      this.localR.onLocalUnitHover = (unit, sx, sy) => this.localUnitHoverCb?.(unit, sx, sy);
      this.localR.onWorkbenchClick = this.localWorkbenchClickCb;
      this.localR.onLocalUnitClick = this.localUnitClickCb;
      this.localR.onNpcClick = this.localNpcClickCb;
      this.localR.onTileClick = (x, y, tile, sx, sy) => this.localTileClickCb?.(x, y, tile, sx, sy);
      this.localR.onUnitRendered = (unit, sx, sy) => this.localUnitRenderedCb?.(unit, sx, sy);
      this.localR.onZonePainted = (type, tiles) => this.onZonePaintedCb?.(type, tiles);
      this.localR.setInputActive(currentViewMode === 'local');
    }

    // Handle view mode transitions
    if (viewModeChanged) {
      if (currentViewMode === 'local' && this.localR) {
        // Entering local view
        this._localExitInProgress = false;
        this.canvas.focus({ preventScroll: true });
        this.localR.startEnterTransition();
        this._previousViewMode = 'local';
      } else if (currentViewMode === 'macro' && this.localR) {
        // Exiting local view - start exit transition
        if (!this._localExitInProgress) {
          this._localExitInProgress = true;
          this.localR.startExitTransition();
        }
      } else {
        this._previousViewMode = currentViewMode;
      }
    }

    if (currentViewMode === 'local') {
      this.threeMap?.setActive(false);
      this.localR?.setInputActive(true);
      if (!document.body.classList.contains('local-view')) {
        document.body.classList.add('local-view');
      }
      const frame = document.getElementById('local-view-frame');
      if (frame) frame.classList.remove('hidden');
      if (!this.localR) return; // still loading module — next frame will retry
      if (this.state.localWorld && this.state.localWorld.repoId !== this.localWorldId) {
        this.localR.setWorld(this.state.localWorld);
        this.localWorldId = this.state.localWorld.repoId;
      }
      this.localR.render(this.state.getLocalUnits());

      // Check if exit transition is complete
      if (this.localR && !this.localR.isTransitionComplete()) {
        return; // wait for next frame to continue transition
      }

      return;
    }

    // Exiting local view (macro mode) - but wait for exit transition to complete
    if (this._localExitInProgress && this.localR && !this.localR.isTransitionComplete()) {
      // Still in exit transition, render one more frame
      this.localR.render(this.state.getLocalUnits());
      return;
    }

    if (document.body.classList.contains('local-view')) {
      document.body.classList.remove('local-view');
      const frame = document.getElementById('local-view-frame');
      if (frame) frame.classList.add('hidden');
      this.onExitLocalView?.();
    }
    this._localExitInProgress = false;
    this.localR?.setInputActive(false);
    this._previousViewMode = 'macro';

    // Reset canvas context state after local view exit (localR leaves globalAlpha ~0)
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.save();
    ctx.translate(cam.cx, cam.cy);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    // ─── Layer gates (applied to each rendering pass) ─────────────────
    const showStructure = isLayerVisible('structure');
    const showOps = isLayerVisible('ops');
    const showKnowledge = isLayerVisible('knowledge');
    const showLabs = isLayerVisible('labs');
    const showSecurity = isLayerVisible('security');
    const showLabels = isLayerVisible('labels');
    const isClean = this._cleanMode;
    const lod = this._currentLod;
    // LOD helpers: fine-grained what each zoom tier shows
    const lodLow = lod === 'low';
    const lodMed = lod === 'medium';
    const lodHigh = lod === 'high';

    // Pass 1–3: terrain (webgl / flat legacy — iso25d retired)
    if (webglMode && this.threeMap) {
      this.threeMap.setActive(true);
      this.unitR.setCoordProjector((coord) => {
        const t = this.state.world.tiles.get(tileKey(coord));
        return this.tilePixelPos(coord, t);
      });
      this.threeMap.render(this.state, this.cam, {
        fogEnabled: this.fogEnabled,
        animTime: this.animTime,
        lod,
        showStructure,
        showOps,
        showLabels,
      });
    } else {
      this.unitR.resetCoordProjector();

      for (const tile of this.state.world.tiles.values()) {
        const neighbors = this.getNeighbors(tile.coord);
        this.hexR.drawTileSurface(tile, this.fogEnabled, neighbors, this.animTime);
      }

      if (showStructure) {
        for (const city of this.state.world.cities) {
          this.hexR.drawCityTerritory(city, this.animTime);
        }
      }

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

      const shouldDrawDecor = showStructure || showOps;
      const showTextLabels = showLabels && !lodLow;
      for (const tile of allTiles) {
        if (!shouldDrawDecor && !showTextLabels) continue;

        const activeBuilding = tile.city
          ? this.state.world.buildings.find(
              (b) => b.cityId === tile.city!.id && b.state === 'building',
            )
          : undefined;

        if (lodLow) {
          if (tile.city && tile.city.isCapital && showTextLabels) {
            this.hexR.drawCityLabel(tile.city, axialToPixel(tile.coord, HEX_SIZE), activeBuilding);
          }
          continue;
        }

        if (lodMed) {
          if (tile.city && showTextLabels) {
            this.hexR.drawCityLabel(tile.city, axialToPixel(tile.coord, HEX_SIZE), activeBuilding);
          }
          if (tile.city && tile.skillHealth && showTextLabels) {
            this.hexR.drawSkillHealth(tile, axialToPixel(tile.coord, HEX_SIZE));
          }
          if (tile.city && tile.city.districts && tile.city.districts.length > 0 && showTextLabels) {
            for (const dist of tile.city.districts) {
              this.hexR.drawDistrictLabel(dist.name, axialToPixel(dist.coord, HEX_SIZE));
            }
          }
          continue;
        }

        if (lodHigh) {
          if (isClean) {
            if (tile.city && showTextLabels) {
              this.hexR.drawCityLabel(tile.city, axialToPixel(tile.coord, HEX_SIZE), activeBuilding);
            }
            if (tile.city && tile.skillHealth && showTextLabels) {
              this.hexR.drawSkillHealth(tile, axialToPixel(tile.coord, HEX_SIZE));
            }
            continue;
          }
          this.hexR.drawTileDecor(tile, this.fogEnabled, activeBuilding, this.animTime);
        }
      }
    }

    // Pass 2.5: Capital wonder flanking sprites (structure + knowledge + labs)
    if (showStructure) {
      const capital = this.state.world.cities.find((c) => c.isCapital);
      if (capital) {
        const cp = this.tilePixelPos(capital.coord, this.state.world.tiles.get(tileKey(capital.coord)));
        if (capital.wonders) {
          for (let i = 0; i < Math.min(capital.wonders.length, 2); i++) {
            const w = capital.wonders[i]!;
            // Only show the sprite if its specific layer is enabled
            const spriteAllowed =
              (w.wonderType === 'bibliotheca' && showKnowledge) ||
              (w.wonderType === 'institutum' && showLabs) ||
              (w.wonderType === 'gaceta' && showKnowledge) ||
              (w.wonderType !== 'bibliotheca' &&
                w.wonderType !== 'institutum' &&
                w.wonderType !== 'gaceta');
            if (!spriteAllowed && showStructure) continue; // still show under structure
            const sx = cp.x + (i === 0 ? -1 : 1) * HEX_SIZE * 0.55;
            const sy = cp.y - HEX_SIZE * 0.5;
            const r = 9;
            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fillStyle = w.wonderType === 'bibliotheca' ? '#1a3a5c' : '#2d5a27';
            ctx.strokeStyle = w.wonderType === 'bibliotheca' ? '#4a90c8' : '#6bc86b';
            ctx.lineWidth = 2;
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(w.wonderType === 'bibliotheca' ? 'B' : 'I', sx, sy + 1);
          }
        }
      }
    }

    // Pass 2.6: Knowledge — bibliotheca connection indicators
    if (showKnowledge) {
      // Precompute knowledge city positions once to avoid O(n²) per-frame wonders scan
      const knowledgePts = this.state.world.cities
        .filter((c) => c.wonders?.some((w) => w.wonderType === 'bibliotheca'))
        .map((c) => ({
          id: c.id,
          p: this.tilePixelPos(c.coord, this.state.world.tiles.get(tileKey(c.coord))),
        }));

      for (const { p: cp } of knowledgePts) {
        // Glowing book icon
        ctx.save();
        ctx.globalAlpha = webglMode
          ? 0.18 + 0.06 * Math.sin(this.animTime * 1.5 + cp.x)
          : 0.35 + 0.15 * Math.sin(this.animTime * 1.5 + cp.x);
        ctx.fillStyle = '#4a90c8';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('📖', cp.x + HEX_SIZE * 0.8, cp.y - HEX_SIZE * 0.55);
        // Thin connection lines between knowledge cities
        for (const { p: op } of knowledgePts) {
          if (op === cp) continue;
          const dist = Math.hypot(op.x - cp.x, op.y - cp.y);
          if (dist > HEX_SIZE * 12) continue; // don't draw across the whole map
          const knowledgeAlpha = webglMode
            ? 0.018 + 0.010 * Math.sin(this.animTime * 0.8 + cp.x + op.x)
            : 0.08 + 0.04 * Math.sin(this.animTime * 0.8 + cp.x + op.x);
          ctx.strokeStyle = `rgba(74, 144, 200, ${knowledgeAlpha})`;
          ctx.lineWidth = webglMode ? 0.35 : 0.5;
          ctx.setLineDash(webglMode ? [2, 10] : [3, 6]);
          ctx.beginPath();
          ctx.moveTo(cp.x, cp.y);
          ctx.lineTo(op.x, op.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();
      }
    }

    // Pass 2.7: Labs — active experiment indicators
    if (showLabs) {
      for (const city of this.state.world.cities) {
        const hasLab = city.wonders?.some((w) => w.wonderType === 'institutum');
        const hasActiveExp = this.state.world.buildings.some(
          (b) => b.cityId === city.id && b.state === 'building',
        );
        if (!hasLab && !hasActiveExp) continue;
        const cp = this.tilePixelPos(city.coord, this.state.world.tiles.get(tileKey(city.coord)));
        const pulse = 0.4 + 0.3 * Math.sin(this.animTime * 3.0);
        ctx.save();
        ctx.globalAlpha = webglMode ? pulse * 0.45 : pulse;
        ctx.fillStyle = '#22C55E';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🔬', cp.x + HEX_SIZE * 0.8, cp.y + HEX_SIZE * 0.6);
        // Pulsing ring around lab cities with active experiments
        if (hasActiveExp) {
          ctx.strokeStyle = `rgba(34, 197, 94, ${webglMode ? pulse * 0.20 : pulse * 0.5})`;
          ctx.lineWidth = webglMode ? 1 : 2;
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, HEX_SIZE * 0.85, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // Pass 2.8: Security — perimeter shield indicators
    if (showSecurity) {
      for (const city of this.state.world.cities) {
        const hasSecurity = city.wonders !== undefined && city.wonders.length > 0;
        if (!hasSecurity) continue;
        const cp = this.tilePixelPos(city.coord, this.state.world.tiles.get(tileKey(city.coord)));
        ctx.save();
        ctx.fillStyle = '#d45b5b';
        ctx.globalAlpha = webglMode
          ? 0.18 + 0.08 * Math.sin(this.animTime * 2.0 + cp.x)
          : 0.4 + 0.2 * Math.sin(this.animTime * 2.0 + cp.x);
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🛡', cp.x - HEX_SIZE * 0.75, cp.y - HEX_SIZE * 0.6);
        // Perimeter hex outline
        this.drawHexHighlight(
          city.coord,
          `rgba(212, 91, 91, ${webglMode ? 0.04 + 0.03 * Math.sin(this.animTime * 1.2) : 0.12 + 0.08 * Math.sin(this.animTime * 1.2)})`,
          webglMode ? 1 : 1.5,
        );
        ctx.restore();
      }
    }

    if (this.showGrid) {
      ctx.setLineDash(webglMode ? [3, 12] : [4, 8]);
      for (const tile of this.state.world.tiles.values()) {
        this.drawHexHighlight(tile.coord, webglMode ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.08)', webglMode ? 0.8 : 1);
      }
      ctx.setLineDash([]);
    }

    // Buildings (structure layer) — canvas markers; webgl uses 3D units mesh
    if (showStructure) {
      for (const building of this.state.world.buildings) {
        this.unitR.drawBuilding(building);
      }
    }

    // Unit trails (ops layer; also suppressed in clean mode & low LOD)
    if (showOps && !isClean && lod !== 'low') {
      for (const unit of this.state.world.units) {
        this.unitR.drawUnitTrail(unit);
      }
      // Parent → ephemeral subagent tether lines
      for (const child of this.state.world.units) {
        if (!child.parentUnitId || !child.ephemeral) continue;
        const parent = this.state.getUnit(child.parentUnitId);
        if (!parent) continue;
        if (!this._shouldDrawEphemeralOnMap(child)) continue;
        this.unitR.drawSubagentLink(parent, child, this.animTime);
      }
    }

    // Units (base layer — canvas in 2D modes; 3D capsules in webgl) + badges
    if (!webglMode) {
    for (const unit of this.state.world.units) {
      if (unit.ephemeral && !this._shouldDrawEphemeralOnMap(unit)) continue;
      this.unitR.drawUnit(unit, this.animTime, this.selectedUnit?.id ?? null, unit.ephemeral);
      const childCount = this.state.getChildrenOfUnit(unit.id).filter((c) => c.ephemeral).length;
      if (childCount > 0) {
        this.unitR.drawSubagentCountBadge(unit, childCount, this.animTime);
      }
      if (showOps && !isClean && lod !== 'low') {
        this.unitR.drawUnitBadge(unit, this.animTime);
      }
    }
    } else if (showOps && !isClean && lod !== 'low') {
      for (const unit of this.state.world.units) {
        if (unit.ephemeral && !this._shouldDrawEphemeralOnMap(unit)) continue;
        this.unitR.drawUnitBadge(unit, this.animTime);
        const childCount = this.state.getChildrenOfUnit(unit.id).filter((c) => c.ephemeral).length;
        if (childCount > 0) {
          this.unitR.drawSubagentCountBadge(unit, childCount, this.animTime);
        }
      }
    }

    // Selection glow (draw on top of selected focus for glow effect)
    if (this.selectedCity && !this.selectedUnit) {
      const cityTile = this.state.world.tiles.get(tileKey(this.selectedCity.coord));
      const cityPos = this.tilePixelPos(this.selectedCity.coord, cityTile);
      const glowPulse = 0.35 + 0.2 * Math.sin(this.animTime * 2.5);
      ctx.save();
      ctx.shadowColor = '#c8a84b';
      ctx.shadowBlur = 16;
      this.drawHexHighlight(this.selectedCity.coord, `rgba(200, 168, 75, ${glowPulse})`, 3);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = `rgba(255, 245, 200, ${glowPulse * 0.85})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cityPos.x, cityPos.y, HEX_SIZE * 0.78, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (this.selectedUnit) {
      const selUnit = this.state.world.units.find((u) => u.id === this.selectedUnit!.id);
      if (selUnit) {
        let sx: number, sy: number;
        if (
          selUnit.state === 'moving' &&
          selUnit.path.length > 0 &&
          selUnit.pathIndex < selUnit.path.length
        ) {
          const from = this.tilePixelPos(
            selUnit.path[selUnit.pathIndex]!,
            this.state.world.tiles.get(tileKey(selUnit.path[selUnit.pathIndex]!)),
          );
          const toCoord = selUnit.path[Math.min(selUnit.pathIndex + 1, selUnit.path.length - 1)]!;
          const to = this.tilePixelPos(toCoord, this.state.world.tiles.get(tileKey(toCoord)));
          const t = selUnit.pathProgress;
          sx = from.x + (to.x - from.x) * t;
          sy = from.y + (to.y - from.y) * t;
        } else {
          const p = this.tilePixelPos(selUnit.coord, this.state.world.tiles.get(tileKey(selUnit.coord)));
          sx = p.x;
          sy = p.y;
        }
        const glowSize = HEX_SIZE * 0.55;
        const glowPulse = 0.35 + 0.2 * Math.sin(this.animTime * 2.5);
        ctx.save();
        ctx.shadowColor = '#c8a84b';
        ctx.shadowBlur = 18;
        ctx.strokeStyle = `rgba(200, 168, 75, ${glowPulse})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sx, sy, glowSize, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    if (this.selectedUnit && this.actionMode === 'move') {
      this.unitR.drawMoveRange(this.selectedUnit);
      this.unitR.drawMovementPath(this.selectedUnit);
    }

    // Update breadcrumb for current selection
    this.updateBreadcrumb(this.selectedUnit, this.selectedCity);

    if (this.showDebug) {
      for (const tile of this.state.world.tiles.values()) {
        this.drawHexHighlight(tile.coord, '#ff000040', 1);
        const wp = this.tilePixelPos(tile.coord, tile);
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
          this.drawHexHighlight(this.hoveredHex, '#00ff00cc', 3);
        } else {
          this.drawHexHighlight(this.hoveredHex, '#ff3333aa', 2);
        }
      } else if (this._cityRelocateMode && this.draggedCity && this.relocateDragActive) {
        const ok = canRelocateCityTo(this.state.world, this.draggedCity, this.hoveredHex);
        this.drawHexHighlight(this.hoveredHex, ok ? '#00ff00cc' : '#ff3333aa', 3);
      } else {
        this.drawHexHighlight(this.hoveredHex, '#c8a84b80', 2);
      }
    }

    ctx.restore();

    // ─── Screen-space overlays (extracted to rendererScreen.ts) ────────────
    renderScreenOverlays(this.screenOverlayState());
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
    if (active) {
      this._cityRelocateMode = false;
      this._cityRelocatePanelRepoPath = null;
      this.clearCityRelocateDrag();
    }
    this._placingMode = active;
    this.syncChromeCursor();
  }
  getPlacingMode(): boolean {
    return this._placingMode;
  }

  /** Enable/disable relocate-by-drag from construction panel (optional repo path from ✥). */
  setCityRelocateMode(active: boolean, panelRepoPath?: string | null) {
    if (active) {
      this._placingMode = false;
    }
    this._cityRelocateMode = active;
    this._cityRelocatePanelRepoPath = panelRepoPath ?? null;
    if (!active) this.clearCityRelocateDrag();
    this.syncChromeCursor();
  }

  getCityRelocateMode(): boolean {
    return this._cityRelocateMode;
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

  /** Toggle clean map mode (reduces visual noise). */
  setCleanMode(active: boolean) {
    this._cleanMode = active;
    if (this.localR) {
      this.localR.setCleanMode(active);
    }
  }
  isCleanMode(): boolean {
    return this._cleanMode;
  }

  /** Toggle workbench file-name labels overlay in local view. */
  toggleWorkbenchLabels(): boolean {
    return this.localR?.toggleWorkbenchLabels() ?? false;
  }
  isWorkbenchLabelsVisible(): boolean {
    return this.localR?.isWorkbenchLabelsVisible() ?? false;
  }

  /** Toggle RimWorld-style debug overlay in local view. */
  toggleLocalDebugOverlay(): boolean {
    return this.localR?.toggleDebugOverlay() ?? false;
  }
  isLocalDebugOverlay(): boolean {
    return this.localR?.isDebugOverlay() ?? false;
  }

  /** Smoothly pan the local-view camera to center on a grid coordinate. */
  animateCameraToGrid(gridX: number, gridY: number, duration = 400): void {
    this.localR?.animateCameraToGrid(gridX, gridY, duration);
  }

  private _lastLod: 'low' | 'medium' | 'high' = 'medium';

  /** Compute current zoom-based LOD level with hysteresis to avoid thrashing. */
  private calcLod(): 'low' | 'medium' | 'high' {
    const webgl = this.worldRenderMode === 'webgl';
    // Hysteresis: different thresholds for zooming in vs out
    if (this._lastLod === 'low') {
      if (this.cam.zoom >= (webgl ? 0.55 : 0.55)) { this._lastLod = 'medium'; return 'medium'; }
      return 'low';
    }
    if (this._lastLod === 'medium') {
      if (this.cam.zoom < (webgl ? 0.45 : 0.45)) { this._lastLod = 'low'; return 'low'; }
      if (this.cam.zoom >= (webgl ? 1.05 : 1.25)) { this._lastLod = 'high'; return 'high'; }
      return 'medium';
    }
    // high
    if (this.cam.zoom < (webgl ? 0.95 : 1.15)) { this._lastLod = 'medium'; return 'medium'; }
    return 'high';
  }

  /** Update breadcrumb for current selection. */
  private updateBreadcrumb(unit: Unit | null, city: City | null) {
    const el = document.getElementById('selection-breadcrumb');
    if (!el) return;
    const path = el.querySelector('.bc-path')!;
    const icon = el.querySelector('.bc-icon')!;
    if (!unit && !city) {
      el.classList.remove('visible');
      return;
    }
    const parts: string[] = [];
    let iconChar = '⬡';
    if (unit) {
      iconChar =
        unit.type === 'hero'
          ? '⬡'
          : unit.type === 'worker'
            ? '⚒'
            : unit.type === 'scout'
              ? '◈'
              : '◆';
      parts.push(`<span class="bc-segment ${unit.type}">${unit.name}</span>`);
      if (unit.state) {
        parts.push(`<span class="bc-separator">·</span>`);
        parts.push(`<span class="bc-segment" style="opacity:0.7">${unit.state}</span>`);
      }
      if (unit.mission) {
        parts.push(`<span class="bc-separator">·</span>`);
        parts.push(
          `<span class="bc-segment" style="opacity:0.6">${unit.mission.slice(0, 30)}</span>`,
        );
      }
      const swarm = this.state.getChildrenOfUnit(unit.id).filter((c) => c.ephemeral).length;
      if (swarm > 0) {
        parts.push(`<span class="bc-separator">·</span>`);
        parts.push(`<span class="bc-segment" style="opacity:0.75">+${swarm} det</span>`);
      }
    } else if (city) {
      iconChar = city.isCapital ? '★' : '⬡';
      parts.push(`<span class="bc-segment city">${city.name}</span>`);
      if (city.population) {
        parts.push(`<span class="bc-separator">·</span>`);
        parts.push(`<span class="bc-segment" style="opacity:0.7">pop ${city.population}</span>`);
      }
    }
    icon.textContent = iconChar;
    path.innerHTML = parts.join('');
    el.classList.add('visible');
  }

  selectUnit(unit: Unit | null) {
    this.selectedUnit = unit;
    if (unit) this.selectedCity = null;
  }

  // Kept for minimap wiring (main.ts uses Renderer.minimapClick)
  minimapClick(mx: number, my: number) {
    this.minimapR.click(mx, my, this.cam);
  }

  // Kept for minimap compatibility
  drawMinimap() {
    this.minimapR.draw(this.cam, this.canvas, this.fogEnabled);
  }

  /** Map shows up to 5 active ephemeral children per parent; rest aggregated as +N badge. */
  private _shouldDrawEphemeralOnMap(unit: Unit): boolean {
    if (!unit.ephemeral || !unit.parentUnitId) return true;
    const siblings = this.state
      .getChildrenOfUnit(unit.parentUnitId)
      .filter((c) => c.ephemeral && c.state !== 'sleeping');
    const idx = siblings.findIndex((c) => c.id === unit.id);
    return idx >= 0 && idx < 5;
  }

  private updateUnitTooltip(clientX: number, clientY: number) {
    const unit = this.hoveredHex ? this.state.getUnitAt(this.hoveredHex) : null;
    if (!unit || this.isDragging) {
      if (this.unitTooltipEl) this.unitTooltipEl.style.display = 'none';
      return;
    }
    if (!this.unitTooltipEl) {
      const el = document.createElement('div');
      el.id = 'unit-tooltip';
      el.style.cssText =
        'position:fixed;z-index:9999;pointer-events:none;background:rgba(20,15,5,0.92);' +
        'border:1px solid #c8a84b;border-radius:4px;padding:6px 10px;font-family:"Cinzel",serif;' +
        'font-size:12px;color:#e8d5a0;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.6);';
      document.body.appendChild(el);
      this.unitTooltipEl = el;
    }
    const stateLabel: Record<string, string> = {
      idle: 'Idle',
      moving: 'Moving',
      working: 'Working',
      sleeping: 'Sleeping',
      building: 'Building',
    };
    const lines = [
      `<strong>${unit.name}</strong>`,
      `State: ${stateLabel[unit.state] ?? unit.state}`,
    ];
    if (unit.ephemeral && unit.parentUnitId) {
      const run = unit.subagentRunId ? this.state.subagents.get(unit.subagentRunId) : undefined;
      const kind = run?.kind ?? unit.type;
      const harness = run?.harness ?? run?.parentHarness ?? '';
      const parent = this.state.getUnit(unit.parentUnitId);
      const harnessBit = harness ? ` · ${harness}` : '';
      lines.unshift(
        `Detachment · ${kind}${harnessBit} · padre: ${parent?.name ?? unit.parentUnitId}`,
      );
    }
    if (unit.mission) lines.push(`Mission: ${unit.mission}`);
    if (unit.cityId) lines.push(`Repo: ${unit.cityId}`);
    this.unitTooltipEl.innerHTML = lines.join('<br>');
    this.unitTooltipEl.style.display = 'block';
    this.unitTooltipEl.style.left = `${clientX + 14}px`;
    this.unitTooltipEl.style.top = `${clientY - 10}px`;
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

  /** Hit-test for wonder sprite under screen point. */
  hitWonderAt(screenX: number, screenY: number): string | null {
    const capital = this.state.getCapital();
    if (!capital || !capital.wonders) return null;
    const capitalTile = this.state.world.tiles.get(tileKey(capital.coord));
    const pos = this.tilePixelPos(capital.coord, capitalTile);
    const cam = this.cam;
    const sx = cam.cx + (pos.x - cam.x) * cam.zoom;
    const sy = cam.cy + (pos.y - cam.y) * cam.zoom;
    const R = 9 * cam.zoom;
    for (let i = 0; i < Math.min(capital.wonders.length, 2); i++) {
      const offX = (i === 0 ? -1 : 1) * HEX_SIZE * 0.55 * cam.zoom;
      const offY = -HEX_SIZE * 0.5 * cam.zoom;
      const wx = sx + offX;
      const wy = sy + offY;
      const dx = screenX - wx;
      const dy = screenY - wy;
      if (dx * dx + dy * dy <= (R + 6) * (R + 6)) {
        return capital.wonders[i]!.wonderType ?? null;
      }
    }
    return null;
  }
}
