// ─── RepoCiv — Renderer (orquestador) ────────────────────────────────────────
import {
  type Axial,
  worldToAxial,
  axialToPixel,
  type Camera,
  screenToWorld,
  clampZoom,
} from './hex.ts';
import { logger } from './logger.ts';
import { type Unit, type Tile, type City, tileKey } from './types.ts';
import type { MapEditorTool, Terrain } from './types.ts';
import { type GameState } from './game.ts';
import { HexRenderer } from './hexRenderer.ts';
import { UnitRenderer } from './unitRenderer.ts';
import { MinimapRenderer } from './minimapRenderer.ts';
import { openWonderVignette } from './ui/wonderVignette.ts';
import { openCapitalPanel } from './ui/capitalPanel.ts';
import { hideUnitPanel } from './ui/panel.ts';
import { isLayerVisible } from './layers.ts';
// LocalRenderer is lazy-loaded on first local-view entry to keep main bundle small.
type LocalRendererType = import('./localRenderer.ts').LocalRenderer;
import {
  interpretUnitDrag,
  interpretCityToCityDrag,
  interpretAreaSelect,
  contextMenuForCity,
  contextMenuForUnit,
  type SpatialDirective,
} from './spatialDirectives.ts';
import { hideDirectivePreview, hideContextMenu } from './ui/spatialPreview.ts';
import { escapeHtml } from './ui/escapeHtml.ts';
import {
  eraseHexOp,
  foundCityOp,
  moveCitySync,
  paintHexOp,
  reconnectCities,
  canRelocateCityTo,
  removeCityOp,
  undoEraseHex,
  undoFoundCity,
  undoMoveCity,
  undoPaintHex,
  undoRemoveCity,
  type ScannedRepo,
} from './map.ts';
import {
  beginMapEditGroup,
  endMapEditGroup,
  pushMapEdit,
  redoMapEdit,
  undoMapEdit,
} from './mapEditHistory.ts';
import { applyNationsToWorld, assignCityToNation, cityKey, getNationStore } from './nations.ts';
import { invalidatePathCache } from './pathfinding.ts';
import { refreshCityList } from './ui/constructionPanel.ts';
import { clearMapEditorRepoSelection, selectMapEditorRepo } from './ui/mapEditor.ts';
import { HEX_SIZE } from './constants.ts';
import { pickOnHex, stackOffsets, type StackOffset } from './unitStack.ts';
import { renderScreenOverlays, type ScreenOverlayState } from './rendererScreen.ts';
import {
  type WorldRenderMode,
  persistRenderMode,
  loadThreeMapRenderer,
  loadLocalScene3D,
  resolveLocalScene3DEnabled,
} from './three/renderMode.ts';
import { terrainElevation } from './isoHex.ts';
import {
  CAMERA_TILT,
  ORBIT_MMB_SENSITIVITY,
  ORBIT_YAW_SPEED,
  clampOrbitPitch,
} from './three/cameraOrbit.ts';

// 3D tile overlays — loaded lazily alongside the WebGL renderer (see the
// threeLoadPromise block) so Three.js stays in its own lazy chunk and never
// enters the eager 2D-canonical bundle. Both are no-ops until WebGL is active.
let tilePopupMod: typeof import('./three/TilePopup3D.ts') | null = null;
let tileFlashMod: typeof import('./three/TileFlash3D.ts') | null = null;

type ThreeMapRendererType = import('./three/ThreeMapRenderer.ts').ThreeMapRenderer;
type LocalScene3DType = import('./three/LocalScene3D.ts').LocalScene3D;

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: GameState;

  private cam: Camera = { x: 0, y: 0, cx: 0, cy: 0, zoom: 1, yaw: 0, pitch: CAMERA_TILT };
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
  /** Delta time in seconds from the RAF loop, passed to 3D per-frame animations. */
  private _dt = 0;
  /** Pan keys currently held (RTS-style continuous scroll). */
  private panDirs = new Set<'up' | 'down' | 'left' | 'right'>();
  /** Q/E orbit keys currently held (WebGL macro yaw). Independent of panDirs. */
  private yawDirs = new Set<'ccw' | 'cw'>();
  /** Shift held while panning → faster scroll. */
  private _panFast = false;
  /** Yaw/pitch captured at MMB-down so drag is absolute, not incremental. */
  private _orbitStartYaw = 0;
  private _orbitStartPitch = CAMERA_TILT;
  // Phase D: WebGL frame metrics
  private _frameTimeSum = 0;
  private _frameTimeCount = 0;
  private _frameTimeAvg = 0;
  private _totalFrameCount = 0;
  /** Idle-agent highlight: pulsing ring drawn for 1s after focusing an idle unit. */
  private _idleHighlightCoord: Axial | null = null;
  /** Last frame's slots of units sharing a hex — drawing and clicks agree. */
  private _stackOffsets: ReadonlyMap<string, StackOffset> = new Map();
  private _idleHighlightTime = 0;
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

  // ─── Map editor mode ─────────────────────────────────────────────────────
  // One mode for the whole map surface: move cities, paint terrain, align a
  // city to a nation, place a repo by hand or erase a hex. Replaces the
  // one-off "✥ move city" button of the construction panel.
  private _mapEditorMode = false;
  private _mapEditorTool: MapEditorTool = 'move';
  private _mapEditorTerrain: Terrain = 'plains';
  private _mapEditorNation: string | null = null;
  private _mapEditorRepo: ScannedRepo | null = null;
  private _mapEditorPainting = false;

  // ─── Fase 5: Spatial gesture state ────────────────────────────────────────
  private gestureMode: 'camera_pan' | 'camera_orbit' | 'unit_drag' | 'area_select' | 'route' =
    'camera_pan';
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
  // Phase A: 3D local view
  private localScene3D: LocalScene3DType | null = null;
  private localScene3DLoadPromise: Promise<void> | null = null;
  private localScene3DContainer: HTMLElement | null = null;
  private _previousViewMode: 'macro' | 'local' | null = null; // Track view mode for transitions
  private _localExitInProgress = false;
  // Callbacks for local view (applied lazily when localR is instantiated)
  localUnitHoverCb:
    | ((unit: import('./types.ts').LocalUnit | null, screenX: number, screenY: number) => void)
    | null = null;
  localWorkbenchClickCb:
    ((tile: import('./types.ts').LocalTile, screenX: number, screenY: number) => void) | null =
    null;
  localUnitClickCb:
    ((unit: import('./types.ts').LocalUnit, screenX: number, screenY: number) => void) | null =
    null;
  localNpcClickCb:
    ((npc: import('./types.ts').LocalNpc, screenX: number, screenY: number) => void) | null = null;
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
    ((unit: import('./types.ts').LocalUnit, screenX: number, screenY: number) => void) | null =
    null;
  // Zone painting callback
  onZonePaintedCb:
    ((type: import('./types.ts').ZoneType, tiles: Array<{ x: number; y: number }>) => void) | null =
    null;
  // P4: drag-to-assign callback
  localDragAssignCb:
    ((unitId: string, workbenchTile: import('./types.ts').LocalTile) => void) | null = null;
  onExitLocalView: (() => void) | null = null;
  // Fires once per local-view entry, alongside the body.local-view class. Used
  // by the local chat to mount its feed; the exit hook tears it down.
  onEnterLocalView: (() => void) | null = null;
  private _localRendererCtor: (new (canvas: HTMLCanvasElement) => LocalRendererType) | null = null;
  // One latch PER renderer. A single shared `localWorldId` was a race the 2D
  // path always won: LocalScene3D arrives via dynamic import, so frame 1 falls
  // through to the 2D renderer, which sets the latch — and by the time the 3D
  // scene exists the id already matches, so its setWorld() is never called and
  // it renders an empty scene forever.
  private localWorldId2D: string | null = null;
  private localWorldId3D: string | null = null;
  /** Cached tile list sorted by Y — recomputed only when tile count changes. */
  private _tilesYSorted: Tile[] = [];
  private _tilesYSortedSize = -1;

  onUnitSelect: ((unit: Unit | null) => void) | null = null;
  onCitySelect: ((cityId: string) => void) | null = null;
  onTileInspect:
    ((cityName: string, coord: { q: number; r: number }, repoPath: string) => void) | null = null;
  onEnterLocal: ((repoId: string, rootPath: string) => void) | null = null; // Phase 6
  /** Click on empty hex while in placing mode. */
  onEmptyTileClick: ((coord: import('./hex.ts').Axial) => void) | null = null;
  // ─── Fase 5 callbacks ─────────────────────────────────────────────────────
  onSpatialGesture:
    ((directive: SpatialDirective, screenPos: { x: number; y: number }) => void) | null = null;
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
    // Layer 3: explicit initial state for the localActive dataset.
    // render() will keep it in sync with state.viewMode; this just
    // makes the macro-view state observable on the canvas from frame 0.
    this.canvas.dataset['localActive'] = 'false';
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

  /** Close a brush stroke so the whole drag is a single undo step. */
  private endMapEditorStroke(): void {
    this._mapEditorPainting = false;
    endMapEditGroup();
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
      // Persist intent before the lazy Three.js import so hotkey 3 is
      // observable immediately; revert to flat below if init fails.
      persistRenderMode('webgl');
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
    this.localScene3D?.setActive(false); // Phase A: deactivate 3D local on flat
    this.canvas.classList.remove('webgl-overlay');
  }

  getWorldRenderMode(): WorldRenderMode {
    return this.worldRenderMode;
  }

  private async ensureThreeMap(): Promise<void> {
    if (this.threeMap) return;
    if (!this.threeLoadPromise) {
      this.threeLoadPromise = (async () => {
        this.threeContainer = this.threeContainer ?? document.getElementById('three-container');
        if (!this.threeContainer) {
          throw new Error('#three-container not found');
        }
        const [ThreeMapRenderer, popupMod, flashMod] = await Promise.all([
          loadThreeMapRenderer(),
          import('./three/TilePopup3D.ts'),
          import('./three/TileFlash3D.ts'),
        ]);
        tilePopupMod = popupMod;
        tileFlashMod = flashMod;
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

  /** Phase A: lazily instantiate the 3D local scene (weak x2 fallback to 2D). */
  private async ensureLocalScene3D(): Promise<void> {
    if (this.localScene3D) return;
    if (!this.localScene3DLoadPromise) {
      this.localScene3DLoadPromise = (async () => {
        this.localScene3DContainer =
          document.getElementById('local-scene-container') ??
          document.getElementById('three-container');
        if (!this.localScene3DContainer) {
          throw new Error('#local-scene-container or #three-container not found');
        }
        const LocalScene3D = await loadLocalScene3D();
        this.localScene3D = new LocalScene3D(this.localScene3DContainer);
        // Wire callbacks (same as LocalRenderer wiring above)
        this.localScene3D.callbacks.onTileClick = (x, y, tile, sx, sy) =>
          this.localTileClickCb?.(x, y, tile, sx, sy);
        this.localScene3D.callbacks.onLocalUnitClick = this.localUnitClickCb;
        this.localScene3D.callbacks.onWorkbenchClick = this.localWorkbenchClickCb;
        this.localScene3D.callbacks.onLocalUnitHover = (unit, sx, sy) =>
          this.localUnitHoverCb?.(unit, sx, sy);
        this.localScene3D.callbacks.onNpcClick = this.localNpcClickCb;
        this.localScene3D.callbacks.onUnitRendered = (unit, sx, sy) =>
          this.localUnitRenderedCb?.(unit, sx, sy);
        this.localScene3D.callbacks.onDragAssign = (unitId, tile) =>
          this.localDragAssignCb?.(unitId, tile);
        this.localScene3D.callbacks.onRequestExit = () => this.state.enterMacroView();
      })();
    }
    try {
      await this.localScene3DLoadPromise;
    } catch (err) {
      this.localScene3DLoadPromise = null;
      throw err;
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

  /** Flash a pulsing ring on a tile for 1s (idle-agent finder highlight). */
  flashIdleHighlight(coord: import('./hex.ts').Axial): void {
    this._idleHighlightCoord = coord;
    this._idleHighlightTime = 1.0; // 1 second
    // In 3D mode, also fire the existing tile-flash system
    if (this.worldRenderMode === 'webgl') {
      const tile = this.state.world.tiles.get(tileKey(coord));
      const elev = tile ? terrainElevation(tile.terrain) : 0;
      tileFlashMod?.flashTile(coord.q, coord.r, elev);
    }
  }

  private pickAxial(wx: number, wy: number): Axial {
    if (this.worldRenderMode === 'webgl' && this.threeMap) {
      const picked = this.threeMap.pickAxial(wx, wy);
      if (picked) return picked;
    }
    return worldToAxial(wx, wy, HEX_SIZE, this.cam);
  }

  /** The unit a pointer at (wx, wy) on `coord` means — clicks, drags, menu and
   *  tooltip alike: the nearest one standing there, or null when the city at
   *  the hex centre is nearer (unitStack.ts). */
  private unitAtPoint(coord: Axial, wx: number, wy: number): Unit | null {
    const key = tileKey(coord);
    const here = this.state.world.units.filter((u) => !u.hidden && tileKey(u.coord) === key);
    const cityHere = !!this.state.world.tiles.get(key)?.city;
    if (here.length === 0) return null;
    if (here.length === 1 && !cityHere) return here[0]!;
    let point: { x: number; y: number } | null;
    if (this.worldRenderMode === 'webgl' && this.threeMap) {
      point = this.threeMap.pickMapPoint(wx, wy);
    } else {
      const map = screenToWorld(this.cam, wx, wy);
      point = { x: map.wx, y: map.wy };
    }
    if (!point) return here[0]!;
    return pickOnHex(point, coord, here, this._stackOffsets, cityHere, HEX_SIZE);
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
    // Phase 6+: when local view is active, the canvas is shared with
    // LocalRenderer (same element, both register listeners). The local
    // renderer is the legitimate owner of clicks in that mode, and its
    // listeners use stopImmediatePropagation() to block propagation to
    // other canvas listeners. We belt-and-suspenders this on our side
    // with an early-return so we never run global pickAxial / gesture
    // state logic while the user is interacting with the local 2D iso
    // view. Symptom: "ciertas casillas en local view abren ventanas
    // de otras ciudades" (2026-06-12, recurring).
    const bailIfLocal = () => {
      // Two-channel guard: state viewMode is the source of truth, and
      // the canvas's data-local-active attribute is updated in render()
      // as a parallel signal. Either one being set short-circuits the
      // global click handlers. This is the Layer 1 + Layer 3 input
      // isolation (Layer 2 is stopImmediatePropagation in localRenderer).
      if (this.state.viewMode === 'local') return true;
      if (this.canvas.dataset['localActive'] === 'true') return true;
      return false;
    };

    // ── mousedown: decide gesture mode ──────────────────────────────────────
    this.canvas.addEventListener('mousedown', (e) => {
      // Kill the browser's middle-click autoscroll before any other work.
      if (e.button === 1) e.preventDefault();
      if (bailIfLocal()) return;
      if (e.button === 1) {
        this.beginCameraOrbit(e);
        return;
      }
      if (e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const coord = this.pickAxial(wx, wy);
      const tile = this.state.world.tiles.get(tileKey(coord)) ?? null;

      // Map editor: the terrain brush paints on press and keeps painting
      // while the pointer moves. The "move" tool falls through to the city
      // relocate branch below (it reuses the same drag machinery). The other
      // tools act on the hex, so they must claim the gesture before the unit
      // drag branch — otherwise a unit standing on the hex swallows the click.
      if (this._mapEditorMode && this._mapEditorTool !== 'move') {
        if (this._mapEditorTool === 'terrain') {
          // One stroke (mousedown → mouseup) is one undo step.
          beginMapEditGroup('Pintar');
          this._mapEditorPainting = true;
          this.paintTerrainAt(coord);
        }
        this.dragStart = { x: e.clientX, y: e.clientY };
        this.camStart = { x: this.cam.x, y: this.cam.y };
        this.gestureMode = 'camera_pan';
        this.isDragging = false;
        return;
      }

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

      // Priority 1: unit drag (unit under cursor — its slot when it shares the
      // hex; the centre of a city hex is the city, see unitAtPoint)
      const unitHere = this.unitAtPoint(coord, wx, wy);
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
      if (bailIfLocal()) return;
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      this.hoveredHex = this.pickAxial(wx, wy);
      this.updateUnitTooltip(e.clientX, e.clientY);

      // Map editor: keep painting while the pointer is down.
      if (this._mapEditorMode && this._mapEditorTool === 'terrain' && this._mapEditorPainting) {
        this.paintTerrainAt(this.hoveredHex);
      }

      if (this._cityRelocateMode && this.draggedCity && this.dragStartPos) {
        const dx = e.clientX - this.dragStartPos.x;
        const dy = e.clientY - this.dragStartPos.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.relocateDragActive = true;
        this.cityGhostScreenPos = { x: wx, y: wy };
      }

      if (this.gestureMode === 'camera_orbit') {
        const dx = e.clientX - this.dragStart.x;
        const dy = e.clientY - this.dragStart.y;
        this.cam.yaw = this._orbitStartYaw - dx * ORBIT_MMB_SENSITIVITY;
        this.cam.pitch = clampOrbitPitch(this._orbitStartPitch - dy * ORBIT_MMB_SENSITIVITY);
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

      if (this.gestureMode === 'camera_orbit') {
        this.canvas.style.cursor = 'grabbing';
      } else if (
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
      if (bailIfLocal()) return;
      if (e.button === 1) {
        this.endCameraOrbit(e);
        return;
      }
      if (e.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const screenPos = { x: e.clientX, y: e.clientY };

      // The terrain brush stops painting when the button comes up.
      this.endMapEditorStroke();

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

        case 'camera_orbit':
          break;

        case 'camera_pan': {
          if (this._cityRelocateMode && this.draggedCity && this.dragStartPos) {
            const dsp = this.dragStartPos;
            const dragMoved = Math.abs(e.clientX - dsp.x) > 3 || Math.abs(e.clientY - dsp.y) > 3;
            const dropCoord = this.pickAxial(wx, wy);
            const dc = this.draggedCity;
            const path = this.dragCityRepoPath;
            if (dragMoved) {
              // Stack the move in this turn: a Ctrl+Z right after the drop must
              // undo the move, not the edit before it. Reconnecting is async
              // and happens after.
              const moved = moveCitySync(this.state.world, dc.id, dropCoord, path);
              if (moved) {
                let current = moved;
                pushMapEdit({
                  label: `Mover ${moved.city.name}`,
                  undo: () => {
                    undoMoveCity(this.state.world, current);
                    void reconnectCities(this.state.world);
                  },
                  redo: () => {
                    // Synchronous so an immediate undo already has the new
                    // result (the copies the previous undo put back must not
                    // be reused).
                    current =
                      moveCitySync(this.state.world, current.city.id, current.to, path) ?? current;
                    void reconnectCities(this.state.world);
                  },
                });
                invalidatePathCache();
                this.state.notifyUpdate();
                refreshCityList();
                void reconnectCities(this.state.world).then(() => this.state.notifyUpdate());
                // Inside the map editor the mode stays open: the next city can
                // be dragged right away.
                if (!this._mapEditorMode) this.setCityRelocateMode(false);
              }
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

    // ── auxclick: middle-click default is autoscroll; never let it through ──
    this.canvas.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });

    // ── wheel: zoom ──────────────────────────────────────────────────────────
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        if (bailIfLocal()) return;
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = clampZoom(this.cam.zoom * factor, 0.15, 4);
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const before = screenToWorld(this.cam, mx, my);
        this.cam.zoom = newZoom;
        const after = screenToWorld(this.cam, mx, my);
        this.cam.x += before.wx - after.wx;
        this.cam.y += before.wy - after.wy;
      },
      { passive: false },
    );

    // ── contextmenu (right-click): unit OR city menu ─────────────────────────
    this.canvas.addEventListener('contextmenu', (e) => {
      if (bailIfLocal()) return;
      e.preventDefault();
      this.actionMode = 'none';
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const coord = this.pickAxial(wx, wy);
      const tile = this.state.world.tiles.get(tileKey(coord));
      // Priority 1: a unit is under the cursor → unit action menu
      // (Mover / Construir / Dormir / Información).
      const hitUnit = this.unitAtPoint(coord, wx, wy);
      if (hitUnit) {
        const items = contextMenuForUnit(hitUnit, {
          onMove: () => {
            this.selectedUnit = hitUnit;
            this.state.selectUnit(hitUnit);
            this.setActionMode('move');
          },
          onBuild: () => {
            this.selectedUnit = hitUnit;
            this.state.selectUnit(hitUnit);
            this.setActionMode('build');
          },
          onSleep: () => {
            this.selectedUnit = hitUnit;
            this.state.selectUnit(hitUnit);
            this.state.setUnitState(hitUnit.id, 'sleeping');
          },
          onInfo: () => {
            this.selectedUnit = hitUnit;
            this.state.selectUnit(hitUnit);
            this.onUnitSelect?.(hitUnit);
          },
          onHide: () => {
            // Visual dismiss: removes the unit from the macro map but keeps
            // it alive in state (missions/chat/backend untouched). Restore
            // with U, or by selecting it from the hero bar.
            this.state.hideUnit(hitUnit.id);
            if (this.selectedUnit?.id === hitUnit.id) {
              this.selectedUnit = null;
              this.state.selectUnit(null);
              hideUnitPanel();
            }
          },
        });
        this.onContextMenu?.(items, { x: e.clientX, y: e.clientY });
        return;
      }
      // Priority 2: city tile → city action menu (mission dispatch).
      // The menu can come back empty (no unit selected + agent policy
      // disallows every command) — fall through to clearing instead of
      // popping an empty box.
      if (tile?.city) {
        const items = contextMenuForCity(tile.city, this.selectedUnit);
        if (items.length > 0) {
          this.onContextMenu?.(items, { x: e.clientX, y: e.clientY });
          return;
        }
      }
      // Priority 3: empty hex → clear selection.
      hideDirectivePreview();
      hideContextMenu();
      this.selectedUnit = null;
    });

    // ── mouseleave: hide unit tooltip ────────────────────────────────────────
    this.canvas.addEventListener('mouseleave', () => {
      if (bailIfLocal()) return;
      if (this.unitTooltipEl) this.unitTooltipEl.style.display = 'none';
    });

    // ── dblclick: enter RimWorld local view ──────────────────────────────────
    this.canvas.addEventListener('dblclick', (e) => {
      if (bailIfLocal()) return;
      const rect = this.canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const coord = this.pickAxial(wx, wy);
      const tile = this.state.world.tiles.get(tileKey(coord));
      const city = tile?.city ?? this.getCityAtScreen(wx, wy);

      // Priority 1: wonder district hex
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

    // ── Keyboard: arrows/WASD smooth pan (macro + local), Esc returns ───────
    const panKey = (e: KeyboardEvent): 'up' | 'down' | 'left' | 'right' | null => {
      if (e.ctrlKey || e.altKey || e.metaKey) return null;
      switch (e.key) {
        case 'ArrowUp':
        case 'w':
        case 'W':
          return 'up';
        case 'ArrowDown':
        case 's':
        case 'S':
          return 'down';
        case 'ArrowLeft':
        case 'a':
        case 'A':
          return 'left';
        case 'ArrowRight':
        case 'd':
        case 'D':
          return 'right';
        default:
          return null;
      }
    };
    const yawKey = (e: KeyboardEvent): 'ccw' | 'cw' | null => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null;
      switch (e.key) {
        case 'q':
        case 'Q':
          return 'ccw';
        case 'e':
        case 'E':
          return 'cw';
        default:
          return null;
      }
    };
    window.addEventListener('keydown', (e) => {
      // Never hijack typing in inputs/textareas
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const dir = panKey(e);
      if (dir) {
        e.preventDefault();
        this.panDirs.add(dir);
        return;
      }
      const yaw = yawKey(e);
      if (yaw) {
        e.preventDefault();
        this.yawDirs.add(yaw);
        return;
      }
      if (e.key === 'Shift') this._panFast = true;
      if (e.key === 'Escape' && this.state.viewMode === 'local') {
        this.state.enterMacroView();
      }
    });
    window.addEventListener('keyup', (e) => {
      const dir = panKey(e);
      if (dir) this.panDirs.delete(dir);
      const yaw = yawKey(e);
      if (yaw) this.yawDirs.delete(yaw);
      if (e.key === 'Shift') this._panFast = false;
    });
    // If the window loses focus while a pan/orbit key is held, release it so
    // the map doesn't keep scrolling/spinning when the user alt-tabs away.
    window.addEventListener('blur', () => {
      this.panDirs.clear();
      this.yawDirs.clear();
      this._panFast = false;
      // Alt-tabbing with the brush button held also ends the stroke.
      this.endMapEditorStroke();
    });
    // MMB released off-canvas: drop the grabbing cursor without a click.
    // LMB released off-canvas: stop the terrain brush (the canvas mouseup
    // never fires when the pointer is over a panel or the toolbar).
    window.addEventListener('mouseup', (e) => {
      if (e.button === 1) this.endCameraOrbit(e);
      if (e.button === 0) this.endMapEditorStroke();
    });
  }

  private wasDrag(e: MouseEvent): boolean {
    return Math.abs(e.clientX - this.dragStart.x) > 4 || Math.abs(e.clientY - this.dragStart.y) > 4;
  }

  /** Middle-mouse orbit around the look-at. WebGL macro only; yaw persists. */
  private beginCameraOrbit(e: MouseEvent): void {
    if (this.worldRenderMode !== 'webgl') return;
    this.gestureMode = 'camera_orbit';
    this.isDragging = false;
    this.draggedUnit = null;
    this.dragStart = { x: e.clientX, y: e.clientY };
    this._orbitStartYaw = this.cam.yaw ?? 0;
    this._orbitStartPitch = this.cam.pitch ?? CAMERA_TILT;
    this.canvas.style.cursor = 'grabbing';
  }

  private endCameraOrbit(e?: MouseEvent): void {
    if (this.gestureMode !== 'camera_orbit') return;
    this.gestureMode = 'camera_pan';
    this.isDragging = false;
    if (e) {
      const rect = this.canvas.getBoundingClientRect();
      this.applyIdleCursor(e.clientX - rect.left, e.clientY - rect.top);
    } else {
      this.canvas.style.cursor = 'default';
    }
  }

  private getTileAt(wx: number, wy: number) {
    const coord = this.pickAxial(wx, wy);
    return this.state.world.tiles.get(tileKey(coord)) ?? null;
  }

  private getCityAtScreen(wx: number, wy: number): City | null {
    const exact = this.getTileAt(wx, wy)?.city ?? null;
    if (exact) return exact;

    const { wx: worldX, wy: worldY } = screenToWorld(this.cam, wx, wy);
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
    if (this._placingMode || this._cityRelocateMode || this._mapEditorMode) {
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    this.canvas.style.cursor = this.getTileAt(wx, wy) ? 'pointer' : 'default';
  }

  private syncChromeCursor() {
    if (this._placingMode || this._cityRelocateMode || this._mapEditorMode) {
      this.canvas.style.cursor = 'crosshair';
    } else {
      this.canvas.style.cursor = 'default';
    }
  }

  private handleClick(e: MouseEvent) {
    // Backstop: even if a code path bypasses the listener-level
    // bailIfLocal() guard (e.g. a future refactor, or direct call from
    // a test), refuse to do global click work while local view owns the
    // canvas. This is Layer 3 of the local-view input isolation.
    if (this.state.viewMode === 'local') return;
    if (this.canvas.dataset['localActive'] === 'true') return;

    const rect = this.canvas.getBoundingClientRect();
    const wx = e.clientX - rect.left;
    const wy = e.clientY - rect.top;
    const coord = this.pickAxial(wx, wy);
    const tile = this.state.world.tiles.get(tileKey(coord));
    const city = tile?.city ?? this.getCityAtScreen(wx, wy);

    // Map editor tools act on the hex and swallow the normal selection.
    if (this._mapEditorMode) {
      switch (this._mapEditorTool) {
        case 'terrain':
          return;
        case 'nation':
          this.assignNationAt(coord);
          return;
        case 'erase':
          this.eraseAt(coord);
          return;
        case 'place':
          this.placeRepoAt(coord);
          return;
        case 'move':
          break;
      }
    }

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

    const unit = this.unitAtPoint(coord, wx, wy);
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
      // City panel (onCitySelect) is enough — no 3D billboard overlay.
      if (this.worldRenderMode === 'webgl') {
        tilePopupMod?.clearTilePopup();
      }
      return;
    }

    // Empty tile click: clear any existing 3D popup.
    if (this.worldRenderMode === 'webgl') {
      tilePopupMod?.clearTilePopup();
    }

    this.selectedUnit = null;
    this.selectedCity = null;
    this.state.selectUnit(null);
    this.onUnitSelect?.(null);
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  getCamera(): { x: number; y: number; zoom: number; yaw: number; pitch: number } {
    return {
      x: this.cam.x,
      y: this.cam.y,
      zoom: this.cam.zoom,
      yaw: this.cam.yaw ?? 0,
      pitch: this.cam.pitch ?? CAMERA_TILT,
    };
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

  /** Shadow-pipeline introspection (capture scripts / debugging). */
  getShadowDebug(): ReturnType<ThreeMapRendererType['getShadowDebug']> | null {
    return this.threeMap?.getShadowDebug() ?? null;
  }

  /** Post-processing toggle passthrough (QA / capture scripts). */
  setPostFxEnabled(enabled: boolean): void {
    this.threeMap?.setPostFxEnabled(enabled);
  }

  isPostFxEnabled(): boolean {
    return this.threeMap?.isPostFxEnabled() ?? false;
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

  /**
   * RTS-style continuous camera pan driven by held keys (arrows/WASD).
   * Speed is screen-space px/s at zoom=1 so the visible scroll rate is
   * constant regardless of zoom; diagonals are normalized so moving
   * diagonally isn't ~41% faster than straight (AoE/StarCraft behavior).
   */
  private applyKeyboardPan(dt: number): void {
    if (this.panDirs.size === 0) return;
    const baseSpeed = 520; // px/s at zoom=1
    const speed = this._panFast ? baseSpeed * 1.8 : baseSpeed;
    let dx = 0;
    let dy = 0;
    if (this.panDirs.has('left')) dx -= 1;
    if (this.panDirs.has('right')) dx += 1;
    if (this.panDirs.has('up')) dy -= 1;
    if (this.panDirs.has('down')) dy += 1;
    if (dx !== 0 && dy !== 0) {
      const inv = Math.SQRT1_2;
      dx *= inv;
      dy *= inv;
    }
    const px = dx * speed * dt;
    const py = dy * speed * dt;
    if (this.state.viewMode === 'local') {
      this.localR?.panBy(px, py);
    } else {
      this.cam.x += px / this.cam.zoom;
      this.cam.y += py / this.cam.zoom;
    }
  }

  /**
   * Continuous yaw while Q/E are held. Independent of WASD pan: both can
   * run in the same frame. WebGL macro only; yaw is not reset on keyup.
   */
  private applyKeyboardOrbit(dt: number): void {
    if (this.yawDirs.size === 0) return;
    if (this.worldRenderMode !== 'webgl') return;
    if (this.state.viewMode === 'local') return;
    let dyaw = 0;
    if (this.yawDirs.has('ccw')) dyaw += 1;
    if (this.yawDirs.has('cw')) dyaw -= 1;
    if (dyaw === 0) return;
    this.cam.yaw = (this.cam.yaw ?? 0) + dyaw * ORBIT_YAW_SPEED * dt;
  }

  start() {
    let lastTime = performance.now();
    const loop = (now: number) => {
      const frameStart = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      this._dt = dt;
      this.applyKeyboardPan(dt);
      this.applyKeyboardOrbit(dt);
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
          this._frameTimeAvg = Math.round((this._frameTimeSum / this._frameTimeCount) * 100) / 100;
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
      canRelocateTo: (hex) =>
        this.draggedCity ? canRelocateCityTo(this.state.world, this.draggedCity, hex) : false,
    };
  }

  private render() {
    const { ctx, canvas, cam } = this;
    const webglMode = this.worldRenderMode === 'webgl' && this.threeMap !== null;

    if (webglMode) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#0d0f08';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Compute LOD from zoom level
    this._currentLod = this.calcLod();

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
      this.localR.onDragAssign = (unitId, tile) => this.localDragAssignCb?.(unitId, tile);
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

      // ── 3D local view (Phase A) ──────────────────────────────────────────
      const webglLocal = this.worldRenderMode === 'webgl' && resolveLocalScene3DEnabled();
      if (webglLocal) {
        if (!this.localScene3D && !this.localScene3DLoadPromise) {
          void this.ensureLocalScene3D().catch((err) => {
            logger.error('[Renderer] Local 3D init failed, falling back to 2D', err);
          });
        }
        if (this.localScene3D && this.state.localWorld) {
          if (this.state.localWorld.repoId !== this.localWorldId3D) {
            this.localScene3D.setWorld(this.state.localWorld);
            this.localWorldId3D = this.state.localWorld.repoId;
          }
          this.localScene3D.setActive(true);
          this.localScene3D.setAgentsForPicking(
            this.state.getLocalUnits(),
            this.state.localWorld.npcs ?? [],
          );
          // Build LocalCamState from the 2D local renderer's camera (or default)
          const cam2d = this.localR?.getCam?.() ?? { x: 0, y: 0, zoom: 1, cx: 0, cy: 0 };
          this.localScene3D.render(
            cam2d,
            this.state.getLocalUnits(),
            this.state.localWorld.npcs ?? [],
            {
              dt: this._dt,
              workbenchLabelOverlay: this.localR?.isWorkbenchLabelsVisible?.() ?? false,
              powerOverlay: this.localR?.isPowerOverlay?.() ?? false,
              temperatureOverlay: this.localR?.isTemperatureOverlay?.() ?? false,
            },
          );
          // 2D local renderer still draws overlays (tooltips, bubbles, labels)
          this.localR?.setInputActive(false);
          this.localR?.render(this.state.getLocalUnits());
          return;
        }
        // localScene3D not ready yet — fall through to 2D as transient
      }

      // ── 2D local view (flat mode or 3D fallback) ──────────────────────────
      this.localScene3D?.setActive(false);
      this.localR?.setInputActive(true);
      if (!document.body.classList.contains('local-view')) {
        document.body.classList.add('local-view');
        this.onEnterLocalView?.();
      }
      // Layer 3 input isolation: mirror view mode into a DOM attribute
      // on the canvas so CSS and the bailIfLocal backstop have a
      // second, framework-independent signal channel.
      this.canvas.dataset['localActive'] = 'true';
      const frame = document.getElementById('local-view-frame');
      if (frame) frame.classList.remove('hidden');
      if (!this.localR) return; // still loading module — next frame will retry
      if (this.state.localWorld && this.state.localWorld.repoId !== this.localWorldId2D) {
        this.localR.setWorld(this.state.localWorld);
        this.localWorldId2D = this.state.localWorld.repoId;
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
    // Phase A: deactivate 3D local scene on exit
    this.localScene3D?.setActive(false);

    if (document.body.classList.contains('local-view')) {
      document.body.classList.remove('local-view');
      this.canvas.dataset['localActive'] = 'false';
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
        dt: this._dt,
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

      // Declutter (B4): at medium (overview) zoom, labelling every city is a
      // wall of overlapping pills. Show labels only for the prominent ones —
      // capitals, the selected / hovered city, and the largest few by size.
      // Zooming in (lodHigh) still reveals every label.
      let medLabelIds: Set<string> | null = null;
      if (lodMed && showTextLabels) {
        const MED_LABEL_CAP = 8;
        const cities = this.state.world.cities;
        medLabelIds = new Set(
          [...cities]
            .sort((a, b) => b.population - a.population)
            .slice(0, MED_LABEL_CAP)
            .map((c) => c.id),
        );
        for (const c of cities) if (c.isCapital) medLabelIds.add(c.id);
        if (this.selectedCity) medLabelIds.add(this.selectedCity.id);
        const hoveredCity = this.hoveredHex
          ? this.state.world.tiles.get(tileKey(this.hoveredHex))?.city
          : null;
        if (hoveredCity) medLabelIds.add(hoveredCity.id);
      }

      for (const tile of allTiles) {
        if (!shouldDrawDecor && !showTextLabels) continue;

        const activeBuilding = tile.city
          ? this.state.world.buildings.find(
              (b) => b.cityId === tile.city!.id && b.state === 'building',
            )
          : undefined;

        if (lodLow) {
          if (tile.city && shouldDrawDecor) {
            this.hexR.drawCitySprite(tile.city, axialToPixel(tile.coord, HEX_SIZE), 0.85);
          }
          if (tile.city && tile.city.isCapital && showTextLabels) {
            this.hexR.drawCityLabel(tile.city, axialToPixel(tile.coord, HEX_SIZE), activeBuilding);
          }
          continue;
        }

        if (lodMed) {
          const pos = axialToPixel(tile.coord, HEX_SIZE);
          if (shouldDrawDecor && !isClean) {
            this.hexR.drawTerrainDecorForTile(tile, this.fogEnabled, this.animTime);
            if (tile.city) {
              const alpha = tile.inFog && this.fogEnabled ? 0.35 : 1;
              this.hexR.drawCitySprite(tile.city, pos, alpha);
            }
          }
          const labelThisCity = tile.city ? (medLabelIds?.has(tile.city.id) ?? true) : false;
          const isFocusedCity =
            tile.city &&
            (this.selectedCity?.id === tile.city.id ||
              (this.hoveredHex !== null &&
                this.hoveredHex.q === tile.coord.q &&
                this.hoveredHex.r === tile.coord.r));
          if (tile.city && showTextLabels && labelThisCity) {
            this.hexR.drawCityLabel(tile.city, pos, activeBuilding, !isFocusedCity);
          }
          if (tile.city && tile.skillHealth && showTextLabels && labelThisCity) {
            this.hexR.drawSkillHealth(tile, pos);
          }
          if (
            tile.city &&
            tile.city.districts &&
            tile.city.districts.length > 0 &&
            showTextLabels &&
            labelThisCity
          ) {
            for (const dist of tile.city.districts) {
              this.hexR.drawDistrictLabel(dist.name, axialToPixel(dist.coord, HEX_SIZE));
            }
          }
          continue;
        }

        if (lodHigh) {
          if (isClean) {
            if (tile.city && showTextLabels) {
              this.hexR.drawCityLabel(
                tile.city,
                axialToPixel(tile.coord, HEX_SIZE),
                activeBuilding,
              );
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

    // Pass 2.5: Capital wonder flanking sprites (structure)
    if (showStructure) {
      const capital = this.state.world.cities.find((c) => c.isCapital);
      if (capital) {
        const cp = this.tilePixelPos(
          capital.coord,
          this.state.world.tiles.get(tileKey(capital.coord)),
        );
        if (capital.wonders) {
          for (let i = 0; i < Math.min(capital.wonders.length, 2); i++) {
            const w = capital.wonders[i]!;
            const sx = cp.x + (i === 0 ? -1 : 1) * HEX_SIZE * 0.55;
            const sy = cp.y - HEX_SIZE * 0.5;
            const r = 9;
            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fillStyle = '#3a3020';
            ctx.strokeStyle = '#c8a84b';
            ctx.lineWidth = 2;
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const glyph = (w.name?.[0] ?? 'W').toUpperCase();
            ctx.fillText(glyph, sx, sy + 1);
          }
        }
      }
    }

    // Pass 2.7: Active construction indicators
    {
      for (const city of this.state.world.cities) {
        const hasActiveExp = this.state.world.buildings.some(
          (b) => b.cityId === city.id && b.state === 'building',
        );
        if (!hasActiveExp) continue;
        const cp = this.tilePixelPos(city.coord, this.state.world.tiles.get(tileKey(city.coord)));
        const pulse = 0.4 + 0.3 * Math.sin(this.animTime * 3.0);
        ctx.save();
        ctx.globalAlpha = webglMode ? pulse * 0.45 : pulse;
        ctx.fillStyle = '#22C55E';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🔨', cp.x + HEX_SIZE * 0.8, cp.y + HEX_SIZE * 0.6);
        // Pulsing ring around cities with active construction
        if (hasActiveExp) {
          ctx.strokeStyle = `rgba(34, 197, 94, ${webglMode ? pulse * 0.2 : pulse * 0.5})`;
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
        this.drawHexHighlight(
          tile.coord,
          webglMode ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.08)',
          webglMode ? 0.8 : 1,
        );
      }
      ctx.setLineDash([]);
    }

    // Buildings (structure layer) — canvas markers; webgl uses 3D units mesh
    if (showStructure) {
      for (const building of this.state.world.buildings) {
        this.unitR.drawBuilding(building);
      }
    }

    // Units sharing a hex (agents in their city) stand on a small ring in it.
    this._stackOffsets = stackOffsets(
      this.state.world.units,
      (key) => !!this.state.world.tiles.get(key)?.city,
      HEX_SIZE,
    );
    this.unitR.setStackOffsets(this._stackOffsets);

    // Unit trails (ops layer; also suppressed in clean mode & low LOD)
    if (showOps && !isClean && lod !== 'low') {
      for (const unit of this.state.world.units) {
        if (unit.hidden) continue;
        this.unitR.drawUnitTrail(unit);
      }
      // Parent → ephemeral subagent tether lines
      for (const child of this.state.world.units) {
        if (child.hidden || !child.parentUnitId || !child.ephemeral) continue;
        const parent = this.state.getUnit(child.parentUnitId);
        if (!parent || parent.hidden) continue;
        if (!this._shouldDrawEphemeralOnMap(child)) continue;
        this.unitR.drawSubagentLink(parent, child, this.animTime);
      }
    }

    // Units (base layer — canvas in 2D modes; 3D capsules in webgl) + badges
    if (!webglMode) {
      for (const unit of this.state.world.units) {
        if (unit.hidden) continue;
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
        if (unit.hidden) continue;
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
          const p = this.tilePixelPos(
            selUnit.coord,
            this.state.world.tiles.get(tileKey(selUnit.coord)),
          );
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

    // ── Idle-agent highlight: pulsing cyan ring for 1s ─────────────────
    if (this._idleHighlightCoord && this._idleHighlightTime > 0) {
      this._idleHighlightTime -= this._dt;
      if (this._idleHighlightTime <= 0) {
        this._idleHighlightCoord = null;
        this._idleHighlightTime = 0;
      } else {
        const p = this.tilePixelPos(
          this._idleHighlightCoord,
          this.state.world.tiles.get(tileKey(this._idleHighlightCoord)),
        );
        const alpha = Math.min(1, this._idleHighlightTime);
        const pulse = 0.4 + 0.3 * Math.sin(this.animTime * 6.0);
        ctx.save();
        ctx.strokeStyle = `rgba(100, 200, 255, ${alpha * pulse})`;
        ctx.lineWidth = 3 / this.cam.zoom;
        ctx.beginPath();
        ctx.arc(p.x, p.y, HEX_SIZE * 0.7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    if (this.selectedUnit && this.actionMode === 'move') {
      this.unitR.drawMoveRange(this.selectedUnit);
      this.unitR.drawMovementPath(this.selectedUnit);
    } else if (!webglMode && showOps && !isClean && lod !== 'low') {
      for (const unit of this.state.world.units) {
        if (unit.hidden) continue;
        if (
          unit.path.length > 1 &&
          (unit.state === 'moving' || this.selectedUnit?.id === unit.id)
        ) {
          this.unitR.drawMovementPath(unit);
        }
      }
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
    // The map editor owns the relocate drag while it is open: closing the
    // construction panel must not silently disable the editor's move tool.
    if (this._mapEditorMode) this.applyMapEditorTool();
    this.syncChromeCursor();
  }

  // ─── Map editor ───────────────────────────────────────────────────────────
  /** Enter/exit the map editor. */
  setMapEditorMode(active: boolean): void {
    this._mapEditorMode = active;
    if (!active) {
      this.endMapEditorStroke();
      this._cityRelocateMode = false;
      this._cityRelocatePanelRepoPath = null;
      this.clearCityRelocateDrag();
    } else {
      this.applyMapEditorTool();
    }
    this.syncChromeCursor();
  }

  getMapEditorMode(): boolean {
    return this._mapEditorMode;
  }

  setMapEditorTool(tool: MapEditorTool): void {
    this._mapEditorTool = tool;
    this.endMapEditorStroke();
    this.applyMapEditorTool();
    this.syncChromeCursor();
  }

  getMapEditorTool(): MapEditorTool {
    return this._mapEditorTool;
  }

  setMapEditorTerrain(terrain: Terrain): void {
    this._mapEditorTerrain = terrain;
  }

  setMapEditorNation(nationId: string | null): void {
    this._mapEditorNation = nationId;
  }

  setMapEditorRepo(repo: ScannedRepo | null): void {
    this._mapEditorRepo = repo;
  }

  // ─── Map editor history ───────────────────────────────────────────────────
  /** Undo the last edit the editor stacked. Returns its label, or null. */
  undoLastMapEdit(): string | null {
    const label = undoMapEdit();
    if (!label) return null;
    this.afterMapEditHistoryChange();
    return label;
  }

  /** Redo the last undone edit. Returns its label, or null. */
  redoLastMapEdit(): string | null {
    const label = redoMapEdit();
    if (!label) return null;
    this.afterMapEditHistoryChange();
    return label;
  }

  /** Session state that follows any undo/redo: routes, paint and panels. */
  private afterMapEditHistoryChange(): void {
    invalidatePathCache();
    applyNationsToWorld(this.state.world);
    refreshCityList();
    this.state.notifyUpdate();
  }

  /** The "move" tool reuses the city relocate machinery (drag + validation). */
  private applyMapEditorTool(): void {
    const wantsRelocate = this._mapEditorMode && this._mapEditorTool === 'move';
    this._cityRelocateMode = wantsRelocate;
    if (!wantsRelocate) this.clearCityRelocateDrag();
  }

  /** Paint the active terrain on a hex. */
  private paintTerrainAt(coord: Axial): void {
    const terrain = this._mapEditorTerrain;
    const result = paintHexOp(this.state.world, coord, terrain, { record: true });
    if (!result) return;
    // The redo replaces the result: undoing again must use the newest one.
    let current = result;
    pushMapEdit({
      label: 'Pintar',
      undo: () => undoPaintHex(this.state.world, coord, current),
      redo: () => {
        current = paintHexOp(this.state.world, coord, terrain, { record: true }) ?? current;
      },
    });
    // Cached routes do not depend on terrain: repaint them from scratch.
    invalidatePathCache();
    this.state.notifyUpdate();
  }

  /** Align the city under the cursor to the active nation. */
  private assignNationAt(coord: Axial): void {
    const city = this.state.world.tiles.get(tileKey(coord))?.city;
    if (!city) return;
    const key = cityKey(city);
    const next = this._mapEditorNation;
    const prev = getNationStore().assignments[key] ?? null;
    if (prev === next) return;
    assignCityToNation(key, next);
    applyNationsToWorld(this.state.world);
    pushMapEdit({
      label: `Nación de ${city.name}`,
      undo: () => {
        assignCityToNation(key, prev);
        applyNationsToWorld(this.state.world);
      },
      redo: () => {
        assignCityToNation(key, next);
        applyNationsToWorld(this.state.world);
      },
    });
    this.state.notifyUpdate();
  }

  /** Erase a hex, or take the city standing on it off the map. */
  private eraseAt(coord: Axial): void {
    const tile = this.state.world.tiles.get(tileKey(coord));
    if (!tile) return;
    if (tile.city) {
      const city = tile.city;
      const removed = removeCityOp(this.state.world, city, { record: true });
      if (!removed) return; // the capital is not removable
      let current = removed;
      // Go through GameState so unitMap, selectedUnit, the path cache and the
      // unitRemoved callbacks stay in sync — otherwise a unit coming back with
      // the same id is handed the ghost and never re-enters world.units.
      for (const u of current.units) this.state.removeUnit(u.id);
      pushMapEdit({
        label: `Sacar ${city.name}`,
        undo: () => {
          undoRemoveCity(this.state.world, current);
          for (const u of current.units) this.state.restoreUnit(u);
        },
        redo: () => {
          // The new removal collects the units that joined the city meanwhile.
          current = removeCityOp(this.state.world, city, { record: true }) ?? current;
          for (const u of current.units) this.state.removeUnit(u.id);
        },
      });
    } else {
      const removedTile = eraseHexOp(this.state.world, coord, { record: true });
      if (!removedTile) return; // a district belongs to its city
      let current = removedTile;
      pushMapEdit({
        label: 'Borrar hex',
        undo: () => undoEraseHex(this.state.world, current),
        redo: () => {
          current = eraseHexOp(this.state.world, coord, { record: true }) ?? current;
        },
      });
    }
    invalidatePathCache();
    this.state.notifyUpdate();
  }

  /** Place the selected repo on a free hex. */
  private placeRepoAt(coord: Axial): void {
    const repo = this._mapEditorRepo;
    if (!repo) return;
    const found = foundCityOp(this.state.world, repo, coord, { record: true });
    if (!found) return;
    let current = found;
    // Units that appeared in the new city leave through GameState on undo and
    // come back on redo (removeCityFromWorld alone would leave them in unitMap).
    let foundedUnits: Unit[] = [];
    pushMapEdit({
      label: `Fundar ${repo.name}`,
      undo: () => {
        foundedUnits = this.state.world.units.filter(
          (u) => u.cityId === current.city.id || tileKey(u.coord) === tileKey(current.city.coord),
        );
        undoFoundCity(this.state.world, current);
        for (const u of foundedUnits) this.state.removeUnit(u.id);
        // The repo goes back to the picker so it can be founded again (the
        // renderer keeps its own selection even when the bar is not mounted).
        this._mapEditorRepo = repo;
        selectMapEditorRepo(repo);
      },
      redo: () => {
        current = foundCityOp(this.state.world, repo, coord, { record: true }) ?? current;
        for (const u of foundedUnits) this.state.restoreUnit(u);
        this._mapEditorRepo = null;
        clearMapEditorRepoSelection();
      },
    });
    // One city per repo: drop the selection and redraw the bar so the repo
    // leaves the dropdown.
    this._mapEditorRepo = null;
    clearMapEditorRepoSelection();
    invalidatePathCache();
    this.state.notifyUpdate();
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
      if (this.cam.zoom >= (webgl ? 0.55 : 0.55)) {
        this._lastLod = 'medium';
        return 'medium';
      }
      return 'low';
    }
    if (this._lastLod === 'medium') {
      if (this.cam.zoom < (webgl ? 0.45 : 0.45)) {
        this._lastLod = 'low';
        return 'low';
      }
      if (this.cam.zoom >= (webgl ? 1.05 : 1.25)) {
        this._lastLod = 'high';
        return 'high';
      }
      return 'medium';
    }
    // high
    if (this.cam.zoom < (webgl ? 0.95 : 1.15)) {
      this._lastLod = 'medium';
      return 'medium';
    }
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
      parts.push(`<span class="bc-segment ${unit.type}">${escapeHtml(unit.name)}</span>`);
      if (unit.state) {
        parts.push(`<span class="bc-separator">·</span>`);
        parts.push(`<span class="bc-segment" style="opacity:0.7">${escapeHtml(unit.state)}</span>`);
      }
      if (unit.mission) {
        parts.push(`<span class="bc-separator">·</span>`);
        parts.push(
          `<span class="bc-segment" style="opacity:0.6">${escapeHtml(unit.mission.slice(0, 30))}</span>`,
        );
      }
      const swarm = this.state.getChildrenOfUnit(unit.id).filter((c) => c.ephemeral).length;
      if (swarm > 0) {
        parts.push(`<span class="bc-separator">·</span>`);
        parts.push(`<span class="bc-segment" style="opacity:0.75">+${swarm} det</span>`);
      }
    } else if (city) {
      iconChar = city.isCapital ? '★' : '⬡';
      parts.push(`<span class="bc-segment city">${escapeHtml(city.name)}</span>`);
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
    const rect = this.canvas.getBoundingClientRect();
    const unit = this.hoveredHex
      ? this.unitAtPoint(this.hoveredHex, clientX - rect.left, clientY - rect.top)
      : null;
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
      `<strong>${escapeHtml(unit.name)}</strong>`,
      `State: ${escapeHtml(stateLabel[unit.state] ?? unit.state)}`,
    ];
    if (unit.ephemeral && unit.parentUnitId) {
      const run = unit.subagentRunId ? this.state.subagents.get(unit.subagentRunId) : undefined;
      const kind = run?.kind ?? unit.type;
      const harness = run?.harness ?? run?.parentHarness ?? '';
      const parent = this.state.getUnit(unit.parentUnitId);
      const harnessBit = harness ? ` · ${escapeHtml(harness)}` : '';
      lines.unshift(
        `Detachment · ${escapeHtml(kind)}${harnessBit} · padre: ${escapeHtml(parent?.name ?? unit.parentUnitId)}`,
      );
    }
    if (unit.mission) lines.push(`Mission: ${escapeHtml(unit.mission)}`);
    if (unit.cityId) lines.push(`Repo: ${escapeHtml(unit.cityId)}`);
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
