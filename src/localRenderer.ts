// ─── RepoCiv — Local Renderer (RimWorld-style 2D grid) ─────────────────────────
// Re-exports
export { isoProject } from './isoLocalRenderer.ts';

// Types
import type { LocalWorld, LocalTile, LocalUnit, ZoneType } from './types.ts';
import { loadOfficeAtlas } from './officeAtlas.ts';
import { darkenHex } from './isoOfficeRenderer.ts';
import {
  EXT_COLOR,
  drawRoomLabel as drawRoomLabelModule,
  drawWorkbenchClusterPanel,
} from './local2dAssets.ts';
import { buildIsoStaticLayer, buildStaticLayer } from './localStaticLayers.ts';
import { worldToScreen, screenToWorld } from './hex.ts';
import {
  renderIso as renderIsoModule,
  drawIsoTile as drawIsoTileModule,
  isoProject as isoProjectFn,
} from './isoLocalRenderer.ts';

// Extracted submodules
import type { CameraState, CamAnim } from './localRenderer/state.ts';
import {
  calcLod,
  screenToTile,
  getTile as cameraGetTile,
  visibleTileRect,
  centerOnWorld,
  jumpToTile as cameraJumpToTile,
  animateCamera as cameraAnimate,
  tickCameraAnimation,
  TILE_SIZE,
} from './localRenderer/camera.ts';
import {
  makeOverlayState,
  makeAssetState,
  drawPowerOverlay,
  drawTemperatureOverlay,
  drawWindowLightRays,
  drawZonePaintPreview,
  drawZones,
  type OverlayState,
  type AssetState,
} from './localRenderer/overlays.ts';
import {
  drawDynamicDoorTile as tileDrawDynamicDoor,
  drawDynamicWorkbenchTile as tileDrawDynamicWorkbench,
  drawTileModule,
  type TileDrawContext,
} from './localRenderer/tileDrawing.ts';
import {
  getUnitAt,
  getNpcAt,
  drawLocalUnit,
  drawWorkbenchLabels2D,
  drawWorkbenchTooltip2D,
  drawDragAssignOverlay,
  drawLoadingIndicator,
} from './localRenderer/unitDrawing.ts';
import {
  initParticlePool as particleInit,
  spawnSpark as particleSpawnSpark,
  spawnZzz as particleSpawnZzz,
  spawnBreath as particleSpawnBreath,
  updateAndDrawParticles as particleUpdateDraw,
  type LocalParticle,
} from './localRenderer/particles.ts';
import {
  createInputState,
  setInputActive as inputSetActive,
  finalizeZonePaint,
  wasDrag as inputWasDrag,
  getZoneForShortcut,
  type InputState,
} from './localRenderer/input.ts';
import {
  createTransitionState,
  startEnterTransition,
  startExitTransition,
  isTransitionComplete,
  getTransitionAlpha,
  resetTransition as transReset,
  tickIntroZoom,
  type TransitionState,
} from './localRenderer/transitions.ts';
import { handleWheelZoom } from './localRenderer/camera.ts';

// ISO zone ambient colors
const ISO_ZONE_LIGHT: Record<string, string> = {
  team_cluster: 'rgba(200, 220, 255, 0.08)',
  meeting: 'rgba(255, 230, 180, 0.08)',
  focus: 'rgba(200, 255, 210, 0.06)',
  break: 'rgba(255, 200, 180, 0.07)',
  infra: 'rgba(220, 230, 245, 0.06)',
  reception: 'rgba(255, 240, 220, 0.08)',
  biophilic: 'rgba(200, 255, 245, 0.06)',
};

// ─── Main renderer class ───────────────────────────────────────────────────────
export class LocalRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private world: LocalWorld | null = null;
  private tokens: Record<string, string> = {};
  private staticLayer: HTMLCanvasElement | null = null;
  private staticWorldId: string | null = null;
  private isoStaticLayer: HTMLCanvasElement | null = null;
  private isoStaticWorldId: string | null = null;
  private _isoStaticOffsetX = 0;
  private _isoStaticOffsetY = 0;
  private doorOpenStates = new Map<string, number>();
  private lastFrameTime = performance.now();
  private _fpsFrames = 0;
  private _fpsLastTime = 0;
  private _fpsValue = 0;
  private static readonly MAX_PARTICLES = 64;
  private particles: LocalParticle[] = [];
  private _cleanMode = false;
  private _currentLod: 'low' | 'medium' | 'high' = 'medium';
  private _powerOverlay = false;
  private _isometric = true;
  private _workbenchLabelOverlay = false;
  private _debugOverlay = false;
  private _temperatureOverlay = false;
  private _loadingIndicator = false;
  private _localUnits: LocalUnit[] = [];
  /** @internal accessed from unitDrawing */
  private input: InputState;
  private trans: TransitionState;
  private cam: CameraState = { x: 0, y: 0, cx: 0, cy: 0, zoom: 1 };
  private _camAnim: CamAnim | null = null;

  // Callbacks
  hoveredTile: { x: number; y: number } | null = null;
  onTileClick:
    | ((x: number, y: number, tile: LocalTile | null, sx: number, sy: number) => void)
    | null = null;
  onTileHover: ((x: number, y: number, tile: LocalTile | null) => void) | null = null;
  onTileDblClick: ((x: number, y: number, tile: LocalTile | null) => void) | null = null;
  onLocalUnitClick: ((unit: LocalUnit, sx: number, sy: number) => void) | null = null;
  onWorkbenchClick: ((tile: LocalTile, sx: number, sy: number) => void) | null = null;
  onLocalUnitHover: ((unit: LocalUnit | null, sx: number, sy: number) => void) | null = null;
  onNpcClick: ((npc: import('./types.ts').LocalNpc, sx: number, sy: number) => void) | null = null;
  onUnitRendered: ((unit: LocalUnit, sx: number, sy: number) => void) | null = null;
  onExitLocalView: (() => void) | null = null;
  onZonePainted: ((type: ZoneType, tiles: Array<{ x: number; y: number }>) => void) | null = null;
  onRequestExit: (() => void) | null = null;
  onDragAssign: ((unitId: string, workbenchTile: LocalTile) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.input = createInputState(this.cam);
    this.trans = createTransitionState();
    this.resize();
    this.cacheTokens();
    this.particles = particleInit([], LocalRenderer.MAX_PARTICLES);
  }

  private cacheTokens() {
    const style = getComputedStyle(document.documentElement);
    this.tokens = {
      base: style.getPropertyValue('--lt-base').trim() || '#0C0C0C',
      surface: style.getPropertyValue('--lt-surface').trim() || '#141414',
      border: style.getPropertyValue('--lt-border').trim() || '#262626',
      zinc800: style.getPropertyValue('--lt-zinc-800').trim() || '#27272A',
      zinc600: style.getPropertyValue('--lt-zinc-600').trim() || '#52525B',
      zinc400: style.getPropertyValue('--lt-zinc-400').trim() || '#A1A1AA',
      zinc50: style.getPropertyValue('--lt-zinc-50').trim() || '#FAFAFA',
      amber500: style.getPropertyValue('--lt-amber-500').trim() || '#F59E0B',
      amber400: style.getPropertyValue('--lt-amber-400').trim() || '#FBBF24',
      error: style.getPropertyValue('--lt-error').trim() || '#EF4444',
      success: style.getPropertyValue('--lt-success').trim() || '#22C55E',
      fontMono: style.getPropertyValue('--lt-font-mono').trim() || "'JetBrains Mono', monospace",
    };
  }

  setWorld(world: LocalWorld) {
    this.world = world;
    this.staticLayer = null;
    this.isoStaticLayer = null;
    this._camAnim = null;
    void loadOfficeAtlas().then((ok) => {
      if (ok) {
        this.isoStaticLayer = null;
        this.staticLayer = null;
      }
    });
    centerOnWorld(this.cam, this._isometric, world);
  }

  private resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.cam.cx = this.canvas.width / 2;
    this.cam.cy = this.canvas.height / 2;
  }

  setIsometric(v: boolean): void {
    this._isometric = v;
    this.staticLayer = null;
  }
  isIsometric(): boolean {
    return this._isometric;
  }
  setCleanMode(v: boolean): void {
    this._cleanMode = v;
  }
  isCleanMode(): boolean {
    return this._cleanMode;
  }
  setWorkbenchLabelOverlay(v: boolean): void {
    this._workbenchLabelOverlay = v;
  }
  toggleWorkbenchLabels(): boolean {
    this._workbenchLabelOverlay = !this._workbenchLabelOverlay;
    return this._workbenchLabelOverlay;
  }
  isWorkbenchLabelsVisible(): boolean {
    return this._workbenchLabelOverlay;
  }
  toggleDebugOverlay(): boolean {
    this._debugOverlay = !this._debugOverlay;
    return this._debugOverlay;
  }
  isDebugOverlay(): boolean {
    return this._debugOverlay;
  }
  setPowerOverlay(v: boolean): void {
    this._powerOverlay = v;
  }
  togglePowerOverlay(): boolean {
    this._powerOverlay = !this._powerOverlay;
    return this._powerOverlay;
  }
  isPowerOverlay(): boolean {
    return this._powerOverlay;
  }
  setTemperatureOverlay(v: boolean): void {
    this._temperatureOverlay = v;
  }
  toggleTemperatureOverlay(): boolean {
    this._temperatureOverlay = !this._temperatureOverlay;
    return this._temperatureOverlay;
  }
  isTemperatureOverlay(): boolean {
    return this._temperatureOverlay;
  }
  setLoadingIndicator(v: boolean): void {
    this._loadingIndicator = v;
  }
  setInputActive(v: boolean): void {
    inputSetActive(this.input, v);
  }
  getZonePaintMode(): ZoneType | null {
    return this.input.zonePaintMode;
  }
  isZonePaintMode(): boolean {
    return this.input.zonePaintMode !== null;
  }

  setZonePaintMode(type: ZoneType | null): void {
    this.input.zonePaintMode = type;
    this.input.zonePaintStart = null;
    this.input.zonePaintCurrent = null;
  }

  startEnterTransition(): void {
    startEnterTransition(this.trans, { value: true }, { value: this.cam.zoom });
    this.input.inputActive = true;
  }
  startExitTransition(): void {
    startExitTransition(this.trans, { value: false });
    this.input.isDragging = false;
    this.input.zonePaintStart = null;
    this.input.zonePaintCurrent = null;
  }
  isTransitionComplete(): boolean {
    return isTransitionComplete(this.trans);
  }
  private _getTransitionAlpha(): number {
    return getTransitionAlpha(this.trans);
  }
  resetTransition(): void {
    transReset(this.trans);
  }

  private calcLod(): 'low' | 'medium' | 'high' {
    return calcLod(this.cam.zoom);
  }
  getCamera() {
    return this.cam;
  }

  jumpToTile(tileX: number, tileY: number) {
    cameraJumpToTile(this.cam, this._isometric, tileX, tileY);
  }
  animateCameraTo(px: number, py: number, duration = 400): void {
    this._camAnim = cameraAnimate(this.cam, px, py, duration);
  }
  animateCameraToGrid(gridX: number, gridY: number, duration = 400): void {
    const p = this._isometric
      ? isoProjectFn(gridX, gridY)
      : { px: gridX * TILE_SIZE, py: gridY * TILE_SIZE };
    this.animateCameraTo(p.px, p.py, duration);
  }

  // ─── Input setup ──────────────────────────────────────────────────────────
  setupInput() {
    const canvas = this.canvas;
    const stopBubble = (e: MouseEvent) => e.stopImmediatePropagation();

    canvas.addEventListener('mousedown', (e) => {
      stopBubble(e);
      if (!this.input.inputActive) return;
      if (e.button === 0) {
        if (this.input.zonePaintMode) {
          const rect = canvas.getBoundingClientRect();
          const tile = this.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
          if (tile) {
            this.input.zonePaintStart = { x: tile.x, y: tile.y };
            this.input.zonePaintCurrent = { x: tile.x, y: tile.y };
          }
        } else {
          const rect = canvas.getBoundingClientRect();
          const wx = e.clientX - rect.left;
          const wy = e.clientY - rect.top;
          const unit = this.getUnitAt(wx, wy);
          if (unit && !unit.despawning) {
            this.input.dragAssignState = 'dragging';
            this.input.dragAssignUnit = unit;
            this.input.dragAssignMouseX = wx;
            this.input.dragAssignMouseY = wy;
            return;
          }
          this.input.isDragging = true;
          this.input.dragStart = { x: e.clientX, y: e.clientY };
          this.input.camStart = { x: this.cam.x, y: this.cam.y };
          this._camAnim = null;
        }
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!this.input.inputActive) return;
      const rect = canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const tile = this.screenToTile(wx, wy);
      this.hoveredTile = tile;
      if (this.input.dragAssignState === 'dragging') {
        this.input.dragAssignMouseX = wx;
        this.input.dragAssignMouseY = wy;
      }
      if (this.input.zonePaintMode && this.input.zonePaintStart && tile)
        this.input.zonePaintCurrent = { x: tile.x, y: tile.y };
      const hoveredUnit = this.getUnitAt(wx, wy);
      if (hoveredUnit !== this.input.hoveredUnit) {
        this.input.hoveredUnit = hoveredUnit;
        this.onLocalUnitHover?.(hoveredUnit, wx, wy);
      }
      if (this.input.isDragging) {
        this.cam.x = this.input.camStart.x - (wx - this.input.dragStart.x) / this.cam.zoom;
        this.cam.y = this.input.camStart.y - (wy - this.input.dragStart.y) / this.cam.zoom;
      }
      if (tile) this.onTileHover?.(tile.x, tile.y, this.getTile(tile.x, tile.y));
    });

    canvas.addEventListener('mouseup', (e) => {
      stopBubble(e);
      if (!this.input.inputActive) return;
      if (e.button === 0) {
        if (this.input.dragAssignState === 'dragging' && this.input.dragAssignUnit) {
          const rect = canvas.getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const tile = this.screenToTile(sx, sy);
          if (tile) {
            const t = this.getTile(tile.x, tile.y);
            if (t?.workbench) this.onDragAssign?.(this.input.dragAssignUnit.id, t);
          }
          this.input.dragAssignState = 'idle';
          this.input.dragAssignUnit = null;
          return;
        }
        if (this.input.zonePaintMode && this.input.zonePaintStart && this.input.zonePaintCurrent) {
          finalizeZonePaint(this.input, this.world, this.onZonePainted, (x, y) =>
            this.getTile(x, y),
          );
          this.input.zonePaintStart = null;
          this.input.zonePaintCurrent = null;
        } else if (!inputWasDrag(e, this.input)) {
          const rect = canvas.getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const tile = this.screenToTile(sx, sy);
          if (tile) {
            const unit = this.getUnitAt(sx, sy);
            if (unit) this.onLocalUnitClick?.(unit, sx, sy);
            else {
              const npc = this.getNpcAt(sx, sy);
              if (npc) this.onNpcClick?.(npc, sx, sy);
              else {
                const t = this.getTile(tile.x, tile.y);
                if (t?.workbench) this.onWorkbenchClick?.(t, sx, sy);
                else this.onTileClick?.(tile.x, tile.y, t, sx, sy);
              }
            }
          }
        }
      }
      this.input.isDragging = false;
    });

    canvas.addEventListener('dblclick', (e) => {
      stopBubble(e);
      if (!this.input.inputActive) return;
      const rect = canvas.getBoundingClientRect();
      const tile = this.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
      if (tile) this.onTileDblClick?.(tile.x, tile.y, this.getTile(tile.x, tile.y));
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.input.inputActive) return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        handleWheelZoom(this.cam, e.deltaY, e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false },
    );

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => {
      if (!this.input.inputActive) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        this.togglePowerOverlay();
      }
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        this.toggleTemperatureOverlay();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (this.input.dragAssignState === 'dragging') {
          this.input.dragAssignState = 'idle';
          this.input.dragAssignUnit = null;
          return;
        }
        if (this.input.zonePaintMode) {
          this.setZonePaintMode(null);
          return;
        }
        this.onRequestExit?.();
        return;
      }
      if (e.shiftKey) {
        const type = getZoneForShortcut(e.key);
        if (type) {
          e.preventDefault();
          this.setZonePaintMode(this.input.zonePaintMode === type ? null : type);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.setZonePaintMode(null);
        }
      }
    });
  }

  private screenToTile(sx: number, sy: number): { x: number; y: number } | null {
    return screenToTile(this.cam, this._isometric, sx, sy);
  }

  private getTile(x: number, y: number): LocalTile | null {
    return cameraGetTile(this.world, x, y);
  }

  private getUnitAt(screenX: number, screenY: number): LocalUnit | null {
    return getUnitAt(
      this.cam,
      this._isometric,
      this._localUnits,
      this.world,
      screenX,
      screenY,
      isoProjectFn,
      screenToWorld,
    );
  }

  private getNpcAt(screenX: number, screenY: number): import('./types.ts').LocalNpc | null {
    return getNpcAt(
      this.cam,
      this._isometric,
      this.world,
      screenX,
      screenY,
      isoProjectFn,
      screenToWorld,
    );
  }

  private visibleTileRect(): { x0: number; y0: number; x1: number; y1: number } {
    if (!this.world) return { x0: 0, y0: 0, x1: 0, y1: 0 };
    return visibleTileRect(
      this.cam,
      this._isometric,
      this.canvas.width,
      this.canvas.height,
      this.world,
    );
  }

  private rebuildStaticLayer() {
    if (!this.world) return;
    const result = buildStaticLayer(this.world, TILE_SIZE, (ctx, tile) => {
      const originalCtx = this.ctx;
      this.ctx = ctx;
      this.drawTile(tile);
      this.ctx = originalCtx;
    });
    this.staticLayer = result.canvas;
    this.staticWorldId = this.world.repoId;
  }

  private rebuildIsoStaticLayer() {
    if (!this.world) return;
    const world = this.world;
    const result = buildIsoStaticLayer({
      world,
      isoTileW: 48,
      isoTileH: 24,
      isoWallH: 30,
      fontMono: this.tokens.fontMono ?? "'JetBrains Mono', monospace",
      extColor: EXT_COLOR,
      zoneLight: ISO_ZONE_LIGHT,
      isoProject: isoProjectFn,
      drawIsoTile: (ctx: any, tile: any, x: number, y: number, currentWorld: any) => {
        drawIsoTileModule(
          {
            ctx,
            world: currentWorld,
            tokens: this.tokens,
            extColor: EXT_COLOR,
            doorOpenStates: this.doorOpenStates,
            spawnZzz: () => {},
            spawnBreath: () => {},
            darkenHex: (hex: string, pct: number) => darkenHex(hex, pct),
          },
          tile,
          x,
          y,
          currentWorld,
        );
      },
    });
    this._isoStaticOffsetX = result.offsetX;
    this._isoStaticOffsetY = result.offsetY;
    this.isoStaticLayer = result.canvas;
    this.isoStaticWorldId = `${world.repoId}:${world.rooms.reduce((n, r) => n + r.workbenches.length, 0)}:${world.rooms.filter((r) => r.highDensity).length}`;
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  render(localUnits: LocalUnit[]) {
    this._localUnits = localUnits;
    const { ctx, canvas, cam, world } = this;

    const transitionAlpha = this._getTransitionAlpha();
    if (transitionAlpha <= 0 && this.trans.state === 'exiting') {
      this.trans.state = null;
      this.onExitLocalView?.();
      return;
    }
    if (transitionAlpha >= 1 && this.trans.state === 'entering') this.trans.state = 'active';
    if (!world) return;

    this._currentLod = this.calcLod();
    const lodLow = this._currentLod === 'low';
    const isClean = this._cleanMode;
    const now = performance.now();
    const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;

    this._camAnim = tickCameraAnimation(this._camAnim, this.cam, now);

    const iz = tickIntroZoom(this.trans, now);
    if (iz.active) this.cam.zoom = iz.zoom;

    this._fpsFrames++;
    if (now - this._fpsLastTime >= 1000) {
      this._fpsValue = this._fpsFrames;
      this._fpsFrames = 0;
      this._fpsLastTime = now;
    }

    const cacheKey = `${world.repoId}:${world.rooms.reduce((n, r) => n + r.workbenches.length, 0)}:${world.rooms.filter((r) => r.highDensity).length}`;
    if (!this.staticLayer || this.staticWorldId !== cacheKey) {
      this.rebuildStaticLayer();
      this.staticWorldId = cacheKey;
    }

    ctx.globalAlpha = transitionAlpha;
    ctx.fillStyle = '#FFF8F3';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;

    const bgGrad = ctx.createRadialGradient(
      canvas.width / 2,
      canvas.height / 2,
      0,
      canvas.width / 2,
      canvas.height / 2,
      Math.max(canvas.width, canvas.height) * 0.7,
    );
    bgGrad.addColorStop(0, 'rgba(255, 248, 243, 0)');
    bgGrad.addColorStop(0.7, 'rgba(255, 240, 230, 0.3)');
    bgGrad.addColorStop(1, 'rgba(250, 230, 220, 0.5)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(cam.cx, cam.cy);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    if (this._loadingIndicator) drawLoadingIndicator(ctx, canvas, this.tokens);

    if (this._isometric && world) {
      const isoCacheKey = `${world.repoId}:${world.rooms.reduce((n, r) => n + r.workbenches.length, 0)}:${world.rooms.filter((r) => r.highDensity).length}`;
      if (!this.isoStaticLayer || this.isoStaticWorldId !== isoCacheKey)
        this.rebuildIsoStaticLayer();
      renderIsoModule({
        ctx: this.ctx,
        cam: this.cam,
        world,
        localUnits,
        dt,
        lodLow,
        view: this.visibleTileRect(),
        tokens: this.tokens,
        extColor: EXT_COLOR,
        isoStaticLayer: this.isoStaticLayer,
        isoStaticOffsetX: this._isoStaticOffsetX,
        isoStaticOffsetY: this._isoStaticOffsetY,
        powerOverlay: this._powerOverlay,
        temperatureOverlay: this._temperatureOverlay,
        workbenchLabelOverlay: this._workbenchLabelOverlay,
        debugOverlay: this._debugOverlay,
        zonePaintMode: this.input.zonePaintMode,
        zonePaintStart: this.input.zonePaintStart,
        zonePaintCurrent: this.input.zonePaintCurrent,
        hoveredTile: this.hoveredTile,
        hoveredUnit: this.input.hoveredUnit,
        doorOpenStates: this.doorOpenStates,
        fpsValue: this._fpsValue,
        onUnitRendered: this.onUnitRendered,
        spawnZzz: (x: number, y: number) => this.spawnZzz(x, y),
        spawnBreath: (x: number, y: number) => this.spawnBreath(x, y),
        darkenHex: (hex: string, pct: number) => darkenHex(hex, pct),
      });
      ctx.restore();
      const grad = ctx.createRadialGradient(
        canvas.width / 2,
        canvas.height / 2,
        0,
        canvas.width / 2,
        canvas.height / 2,
        canvas.width,
      );
      grad.addColorStop(0, 'rgba(255, 248, 243, 0)');
      grad.addColorStop(0.65, 'rgba(255, 240, 230, 0)');
      grad.addColorStop(1, 'rgba(245, 220, 205, 0.35)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    // ─── Outside world ─────────────────────────────────────────────────────
    if (world) {
      const worldPxW = world.width * TILE_SIZE;
      const worldPxH = world.height * TILE_SIZE;
      const { wx: left, wy: top } = screenToWorld(cam, 0, 0);
      const { wx: right, wy: bottom } = screenToWorld(cam, canvas.width, canvas.height);
      if (left < 0 || top < 0 || right > worldPxW || bottom > worldPxH) {
        const S = TILE_SIZE;
        const x0 = Math.floor(left / S) * S,
          y0 = Math.floor(top / S) * S;
        const x1 = Math.ceil(right / S) * S,
          y1 = Math.ceil(bottom / S) * S;
        for (let ty = y0; ty < y1; ty += S) {
          for (let tx = x0; tx < x1; tx += S) {
            if (tx >= 0 && ty >= 0 && tx < worldPxW && ty < worldPxH) continue;
            const isEven = (Math.abs(tx / S) + Math.abs(ty / S)) % 2 === 0;
            ctx.fillStyle = isEven ? 'rgb(250,240,230)' : 'rgb(248,235,228)';
            ctx.fillRect(tx, ty, S, S);
            ctx.strokeStyle = 'rgba(210, 200, 190, 0.4)';
            ctx.lineWidth = 0.5;
            ctx.strokeRect(tx + 0.5, ty + 0.5, S - 1, S - 1);
            const hash = (Math.abs(tx / S) * 13 + Math.abs(ty / S) * 7) % 11;
            if (hash === 0 || hash === 5) {
              const bx = tx + S / 2,
                by = ty + S / 2;
              ctx.fillStyle = hash === 0 ? '#608860' : '#90B090';
              ctx.beginPath();
              ctx.ellipse(bx, by, S * 0.35, S * 0.25, 0, 0, Math.PI * 2);
              ctx.fill();
              ctx.fillStyle = hash === 0 ? '#8BC34A' : '#A5D6A7';
              ctx.beginPath();
              ctx.ellipse(bx - 2, by - 2, S * 0.2, S * 0.15, -0.3, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        ctx.strokeStyle = 'rgba(220, 200, 185, 0.5)';
        ctx.lineWidth = 2;
        ctx.strokeRect(0.5, 0.5, worldPxW - 1, worldPxH - 1);
      }
    }

    if (this.staticLayer) ctx.drawImage(this.staticLayer, 0, 0);

    const view = this.visibleTileRect();
    drawWindowLightRays(this.overlayState(), world, view);

    for (let y = view.y0; y <= view.y1; y++) {
      for (let x = view.x0; x <= view.x1; x++) {
        const tile = world.grid[y]![x]!;
        if (tile.type === 'door') this.drawDynamicDoorTile(tile, dt, localUnits);
        else if (tile.type === 'workbench') this.drawDynamicWorkbenchTile(tile);
      }
    }

    for (const room of world.rooms) {
      const placed = room.layoutPlan?.deskCount ?? 0;
      if (room.workbenches.length > placed && room.workbenches.length >= 3) {
        const { sx, sy } = worldToScreen(
          this.cam,
          (room.x + room.width / 2) * TILE_SIZE,
          room.y * TILE_SIZE,
        );
        drawWorkbenchClusterPanel(
          this.assetState(),
          sx,
          sy,
          room.workbenches.map((wb) => wb.extension),
        );
      }
    }

    if (!lodLow) {
      for (const room of world.rooms) drawRoomLabelModule(this.assetState(), room);
    }
    if (!lodLow) this.drawWorkbenchLabels2D(view);
    for (const unit of localUnits) this.drawLocalUnit(unit);

    if (this.hoveredTile) {
      const ht = this.getTile(this.hoveredTile.x, this.hoveredTile.y);
      if (ht?.workbench) this.drawWorkbenchTooltip2D(ht.workbench);
    }

    if (!isClean && !lodLow) this.updateAndDrawParticles(dt);
    if (this._powerOverlay) drawPowerOverlay(this.overlayState(), world, view);
    if (this._temperatureOverlay) drawTemperatureOverlay(this.overlayState(), world, view);
    if (world.zones && world.zones.length > 0) drawZones(this.overlayState(), world, view);
    if (this.input.zonePaintMode && this.input.zonePaintStart && this.input.zonePaintCurrent)
      drawZonePaintPreview(this.overlayState(), view);

    if (this.hoveredTile) {
      const { x, y } = this.hoveredTile;
      ctx.save();
      ctx.strokeStyle = '#A07840';
      ctx.lineWidth = 2 / cam.zoom;
      ctx.strokeRect(x * TILE_SIZE + 1, y * TILE_SIZE + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      ctx.restore();
    }

    if (this.input.dragAssignState === 'dragging' && this.input.dragAssignUnit) {
      drawDragAssignOverlay(
        ctx,
        cam,
        this.input.dragAssignUnit,
        this.input.dragAssignMouseX,
        this.input.dragAssignMouseY,
        this.world,
        (sx, sy) => this.screenToTile(sx, sy),
        (x, y) => this.getTile(x, y),
      );
    }

    ctx.restore();
    const grad = ctx.createRadialGradient(
      canvas.width / 2,
      canvas.height / 2,
      0,
      canvas.width / 2,
      canvas.height / 2,
      canvas.width,
    );
    grad.addColorStop(0, 'rgba(255, 248, 243, 0)');
    grad.addColorStop(0.65, 'rgba(255, 240, 230, 0)');
    grad.addColorStop(1, 'rgba(245, 220, 205, 0.35)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  // ─── Drawing helpers (delegate to extracted modules) ──────────────────────
  private drawTile(tile: LocalTile) {
    const d: TileDrawContext = {
      ctx: this.ctx,
      tokens: this.tokens,
      world: this.world,
      getTileFn: (x, y) => this.getTile(x, y),
      localUnits: this._localUnits,
      doorOpenStates: this.doorOpenStates,
      spawnSparkFn: (x, y, color) => this.spawnSpark(x, y, color),
    };
    drawTileModule(this.ctx, tile, d);
  }

  private drawDynamicDoorTile(tile: LocalTile, dt: number, localUnits: LocalUnit[]) {
    tileDrawDynamicDoor(this.ctx, tile, dt, localUnits, this.world, this.doorOpenStates);
  }

  private drawDynamicWorkbenchTile(tile: LocalTile) {
    tileDrawDynamicWorkbench(this.ctx, tile, this._localUnits, (x, y, color) =>
      this.spawnSpark(x, y, color),
    );
  }

  private drawLocalUnit(unit: LocalUnit) {
    drawLocalUnit(
      this.ctx,
      this.cam,
      unit,
      this.input.hoveredUnit?.id ?? null,
      this.tokens,
      (x, y) => this.spawnZzz(x, y),
      this.onUnitRendered,
    );
  }

  private drawWorkbenchLabels2D(view: { x0: number; y0: number; x1: number; y1: number }) {
    if (!this.world) return;
    drawWorkbenchLabels2D(
      this.ctx,
      this.cam,
      this.world,
      view,
      this._workbenchLabelOverlay,
      this.tokens,
    );
  }

  private drawWorkbenchTooltip2D(wb: NonNullable<LocalTile['workbench']>) {
    drawWorkbenchTooltip2D(
      this.ctx,
      this.cam,
      this.canvas,
      this.hoveredTile,
      this.world,
      wb,
      this.tokens,
    );
  }

  private spawnSpark(x: number, y: number, color: string) {
    particleSpawnSpark(this.particles, x, y, color);
  }
  private spawnZzz(x: number, y: number) {
    particleSpawnZzz(this.particles, x, y, this.tokens.amber400 || '#FBBF24');
  }
  private spawnBreath(x: number, y: number) {
    particleSpawnBreath(this.particles, x, y);
  }
  private updateAndDrawParticles(dt: number) {
    particleUpdateDraw(
      this.ctx,
      this.particles,
      dt,
      this.tokens.fontMono || "'JetBrains Mono', monospace",
    );
  }

  private overlayState(): OverlayState {
    return makeOverlayState(
      this.ctx,
      this.tokens,
      this.input.zonePaintMode,
      this.input.zonePaintStart,
      this.input.zonePaintCurrent,
      (x, y) => this.spawnBreath(x, y),
    );
  }

  private assetState(): AssetState {
    return makeAssetState(this.ctx, this.tokens);
  }
}
