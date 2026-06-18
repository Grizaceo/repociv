// ─── RepoCiv — Local Renderer (RimWorld-style 2D grid) ─────────────────────────
import type { LocalWorld, LocalTile, LocalRoom, LocalUnit, ZoneType } from './types.ts';
import { loadOfficeAtlas } from './officeAtlas.ts';
import { darkenHex } from './isoOfficeRenderer.ts';
import { EXT_COLOR, adjustBrightness as _adjustBrightness, drawRoomLabel as drawRoomLabelModule, drawSofaTile as drawSofaTileModule, drawWatercoolerTile as drawWatercoolerTileModule, drawWindowTile as drawWindowTileModule, drawWorkbenchClusterPanel } from './local2dAssets.ts';
import {
  createParticlePool,
  spawnBreath as spawnBreathParticle,
  spawnSpark as spawnSparkParticle,
  spawnZzz as spawnZzzParticle,
  updateAndDrawParticles as updateAndDrawLocalParticles,
  type LocalParticle,
} from './localParticles.ts';
import { buildIsoStaticLayer, buildStaticLayer } from './localStaticLayers.ts';
import {
  drawPowerOverlay as drawPowerOverlayModule,
  drawTemperatureOverlay as drawTemperatureOverlayModule,
  drawWindowLightRays as drawWindowLightRaysModule,
  drawZonePaintPreview as drawZonePaintPreviewModule,
  drawZones as drawZonesModule,
} from './localOverlays.ts';
import {
  ISO_TILE_H,
  ISO_TILE_W,
  ISO_WALL_H,
  computeUnitDirAngle,
  drawIsoTile as drawIsoTileModule,
  isUnitMoving,
  isoProject,
  isoUnproject,
  renderIso as renderIsoModule,
} from './isoLocalRenderer.ts';

const TILE_SIZE = 32; // px per tile

// Zone ambient radial-light colors (very low alpha — applied in static layer)
const ISO_ZONE_LIGHT: Record<string, string> = {
  team_cluster: 'rgba(200, 220, 255, 0.08)',
  meeting: 'rgba(255, 230, 180, 0.08)',
  focus: 'rgba(200, 255, 210, 0.06)',
  break: 'rgba(255, 200, 180, 0.07)',
  infra: 'rgba(220, 230, 245, 0.06)',
  reception: 'rgba(255, 240, 220, 0.08)',
  biophilic: 'rgba(200, 255, 245, 0.06)',
};

export { isoProject } from './isoLocalRenderer.ts';

// ─── Main renderer class ───────────────────────────────────────────────────────
export class LocalRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private world: LocalWorld | null = null;

  // CSS Design Token Cache (Phase 3a)
  private tokens: Record<string, string> = {};

  // Offscreen Static Layer (Phase 3b)
  private staticLayer: HTMLCanvasElement | null = null;
  private staticWorldId: string | null = null;

  // Isometric Static Layer
  private isoStaticLayer: HTMLCanvasElement | null = null;
  private isoStaticWorldId: string | null = null;
  private _isoStaticOffsetX = 0;
  private _isoStaticOffsetY = 0;

  // Door Animation State (Phase 5)
  private doorOpenStates = new Map<string, number>();
  private lastFrameTime = performance.now();

  // Debug FPS counter
  private _fpsFrames = 0;
  private _fpsLastTime = 0;
  private _fpsValue = 0;

  // Particle Pool (Phase 8)
  private static readonly MAX_PARTICLES = 64;
  private particles: LocalParticle[] = [];

  // ─── Fase 1: LOD + Clean Mode ──────────────────────────────────────
  private _cleanMode = false;
  private _currentLod: 'low' | 'medium' | 'high' = 'medium';
  private _powerOverlay = false;

  // ─── Isometric 2.5D Mode ───────────────────────────────────────────
  private _isometric = true;

  setIsometric(active: boolean): void {
    this._isometric = active;
    this.staticLayer = null;
  }
  isIsometric(): boolean {
    return this._isometric;
  }

  setCleanMode(active: boolean): void {
    this._cleanMode = active;
  }
  isCleanMode(): boolean {
    return this._cleanMode;
  }

  // Workbench label overlay toggle
  private _workbenchLabelOverlay = false;
  setWorkbenchLabelOverlay(active: boolean): void {
    this._workbenchLabelOverlay = active;
  }
  toggleWorkbenchLabels(): boolean {
    this._workbenchLabelOverlay = !this._workbenchLabelOverlay;
    return this._workbenchLabelOverlay;
  }
  isWorkbenchLabelsVisible(): boolean {
    return this._workbenchLabelOverlay;
  }

  // Debug overlay toggle (RimWorld-style dev mode)
  private _debugOverlay = false;
  toggleDebugOverlay(): boolean {
    this._debugOverlay = !this._debugOverlay;
    return this._debugOverlay;
  }
  isDebugOverlay(): boolean {
    return this._debugOverlay;
  }

  // Power overlay toggle
  setPowerOverlay(active: boolean): void {
    this._powerOverlay = active;
  }
  togglePowerOverlay(): boolean {
    this._powerOverlay = !this._powerOverlay;
    return this._powerOverlay;
  }
  isPowerOverlay(): boolean {
    return this._powerOverlay;
  }

  // ─── Zone Painting Mode (RimWorld-style) ────────────────────────────────
  private _zonePaintMode: ZoneType | null = null;
  private _zonePaintStart: { x: number; y: number } | null = null;
  private _zonePaintCurrent: { x: number; y: number } | null = null;

  setZonePaintMode(type: ZoneType | null): void {
    this._zonePaintMode = type;
    this._zonePaintStart = null;
    this._zonePaintCurrent = null;
  }
  getZonePaintMode(): ZoneType | null {
    return this._zonePaintMode;
  }
  isZonePaintMode(): boolean {
    return this._zonePaintMode !== null;
  }

  // ─── Temperature Overlay Toggle ─────────────────────────────────────────
  private _temperatureOverlay = false;

  setTemperatureOverlay(active: boolean): void {
    this._temperatureOverlay = active;
  }
  toggleTemperatureOverlay(): boolean {
    this._temperatureOverlay = !this._temperatureOverlay;
    return this._temperatureOverlay;
  }
  isTemperatureOverlay(): boolean {
    return this._temperatureOverlay;
  }

  // ─── Fade Transition (300ms) ──────────────────────────────────────
  private _transitionState: 'entering' | 'active' | 'exiting' | null = null;
  private _transitionStartTime = 0;
  private readonly _transitionDuration = 300; // ms

  /** Call when local view is being entered (from macro view). */
  startEnterTransition(): void {
    this._inputActive = true;
    this._transitionState = 'entering';
    this._transitionStartTime = performance.now();
  }

  /** Call when local view is being exited (back to macro view). */
  startExitTransition(): void {
    this._inputActive = false;
    this.isDragging = false;
    this._zonePaintStart = null;
    this._zonePaintCurrent = null;
    this._transitionState = 'exiting';
    this._transitionStartTime = performance.now();
  }

  /** Check if transition is complete. */
  isTransitionComplete(): boolean {
    return this._transitionState === null || this._transitionState === 'active';
  }

  /** Get current transition alpha (0 = transparent, 1 = opaque). */
  private _getTransitionAlpha(): number {
    if (!this._transitionState || this._transitionState === 'active') return 1;
    const elapsed = performance.now() - this._transitionStartTime;
    const progress = Math.min(elapsed / this._transitionDuration, 1);
    if (this._transitionState === 'entering') {
      return progress; // 0 -> 1
    } else if (this._transitionState === 'exiting') {
      return 1 - progress; // 1 -> 0
    }
    return 1;
  }

  /** Call after exit transition completes to reset state. */
  resetTransition(): void {
    this._transitionState = null;
  }
  private calcLod(): 'low' | 'medium' | 'high' {
    if (this.cam.zoom < 0.4) return 'low';
    if (this.cam.zoom < 1.0) return 'medium';
    return 'high';
  }

  // Camera
  private cam = { x: 0, y: 0, cx: 0, cy: 0, zoom: 1 };
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private camStart = { x: 0, y: 0 };
  private _inputActive = true;

  // Camera animation (smooth pan)
  private _camAnim: { targetX: number; targetY: number; startTime: number; duration: number; fromX: number; fromY: number } | null = null;

  setInputActive(active: boolean): void {
    this._inputActive = active;
    if (!active) {
      this.isDragging = false;
      this._zonePaintStart = null;
      this._zonePaintCurrent = null;
      this._hoveredUnit = null;
      this.hoveredTile = null;
    }
  }

  // Interaction
  hoveredTile: { x: number; y: number } | null = null;
  onTileClick: ((x: number, y: number, tile: LocalTile | null, screenX: number, screenY: number) => void) | null = null;
  onTileHover: ((x: number, y: number, tile: LocalTile | null) => void) | null = null;
  onTileDblClick: ((x: number, y: number, tile: LocalTile | null) => void) | null = null;

  // Spatial awareness callbacks (ported from macro pattern)
  onLocalUnitClick: ((unit: LocalUnit, screenX: number, screenY: number) => void) | null = null;
  onWorkbenchClick: ((tile: LocalTile, screenX: number, screenY: number) => void) | null = null;
  onLocalUnitHover: ((unit: LocalUnit | null, screenX: number, screenY: number) => void) | null =
    null;
  onNpcClick: ((npc: import('./types.ts').LocalNpc, screenX: number, screenY: number) => void) | null = null;
  // Phase 9: per-frame bubble position update
  onUnitRendered: ((unit: LocalUnit, screenX: number, screenY: number) => void) | null = null;
  // Phase 9 (transition): notifies parent when the exit transition completes
  onExitLocalView: (() => void) | null = null;
  // Zone painting: notifies parent when a zone rectangle is finalized
  onZonePainted: ((type: ZoneType, tiles: Array<{ x: number; y: number }>) => void) | null = null;
  onRequestExit: (() => void) | null = null;

  // Internal
  private _localUnits: LocalUnit[] = [];
  private _hoveredUnit: LocalUnit | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    this.cacheTokens();
    this.initParticlePool();
  }

  private initParticlePool() {
    this.particles = createParticlePool(LocalRenderer.MAX_PARTICLES);
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
    this._camAnim = null; // cancel any in-flight pan — its target belongs to the previous world
    void loadOfficeAtlas().then((ok) => {
      if (ok) {
        this.isoStaticLayer = null;
        this.staticLayer = null;
      }
    });
    // Center camera on the largest room (main area) rather than whole grid centroid
    if (this._isometric) {
      const largestRoom = world.rooms.reduce<LocalRoom | null>(
        (best, r) => (!best || r.width * r.height > best.width * best.height ? r : best),
        null,
      );
      if (largestRoom) {
        const cx = largestRoom.x + largestRoom.width / 2;
        const cy = largestRoom.y + largestRoom.height / 2;
        const p = isoProject(cx, cy);
        this.cam.x = p.px;
        this.cam.y = p.py;
      } else {
        const c0 = isoProject(0, 0);
        const c1 = isoProject(world.width, 0);
        const c2 = isoProject(0, world.height);
        const c3 = isoProject(world.width, world.height);
        this.cam.x = (Math.min(c0.px, c1.px, c2.px, c3.px) + Math.max(c0.px, c1.px, c2.px, c3.px)) / 2;
        this.cam.y = (Math.min(c0.py, c1.py, c2.py, c3.py) + Math.max(c0.py, c1.py, c2.py, c3.py)) / 2;
      }
    } else {
      this.cam.x = world.width * TILE_SIZE / 2;
      this.cam.y = world.height * TILE_SIZE / 2;
    }
  }

  private resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.cam.cx = this.canvas.width / 2;
    this.cam.cy = this.canvas.height / 2;
  }

  // ─── Input ───────────────────────────────────────────────────────────────────
  setupInput() {
    const canvas = this.canvas;

    // Local view owns clicks. We must stop the event from reaching the
    // GLOBAL renderer's listeners (which are registered on the same
    // canvas, earlier than us, in render()'s setupInput). stopPropagation
    // alone is insufficient: it only blocks bubbling to ancestor elements,
    // not other listeners on the same target. stopImmediatePropagation
    // also halts the remaining listeners on this canvas. The global
    // renderer also early-returns via bailIfLocal() in setupInput, so
    // these two mechanisms are defense in depth.
    const stopBubble = (e: MouseEvent) => e.stopImmediatePropagation();

    canvas.addEventListener('mousedown', (e) => {
      stopBubble(e);
      if (!this._inputActive) return;
      if (e.button === 0) {
        if (this._zonePaintMode) {
          // Zone painting: start drag-rect
          const rect = canvas.getBoundingClientRect();
          const wx = e.clientX - rect.left;
          const wy = e.clientY - rect.top;
          const tile = this.screenToTile(wx, wy);
          if (tile) {
            this._zonePaintStart = { x: tile.x, y: tile.y };
            this._zonePaintCurrent = { x: tile.x, y: tile.y };
          }
        } else {
          // Normal camera drag
          this.isDragging = true;
          this.dragStart = { x: e.clientX, y: e.clientY };
          this.camStart = { x: this.cam.x, y: this.cam.y };
          this._camAnim = null; // cancel any active camera animation
        }
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!this._inputActive) return;
      const rect = canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const tile = this.screenToTile(wx, wy);
      this.hoveredTile = tile;

      // Zone painting: update current drag position
      if (this._zonePaintMode && this._zonePaintStart && tile) {
        this._zonePaintCurrent = { x: tile.x, y: tile.y };
      }

      // Spatial awareness: unit hover (ported from macro hit-testing)
      const hoveredUnit = this.getUnitAt(wx, wy);
      if (hoveredUnit !== this._hoveredUnit) {
        this._hoveredUnit = hoveredUnit;
        this.onLocalUnitHover?.(hoveredUnit, wx, wy);
      }

      if (this.isDragging) {
        const dx = (wx - this.dragStart.x) / this.cam.zoom;
        const dy = (wy - this.dragStart.y) / this.cam.zoom;
        this.cam.x = this.camStart.x - dx;
        this.cam.y = this.camStart.y - dy;
      }

      if (tile) this.onTileHover?.(tile.x, tile.y, this.getTile(tile.x, tile.y));
    });

    canvas.addEventListener('mouseup', (e) => {
      stopBubble(e);
      if (!this._inputActive) return;
      if (e.button === 0) {
        if (this._zonePaintMode && this._zonePaintStart && this._zonePaintCurrent) {
          // Zone painting: finalize rectangle
          this._finalizeZonePaint();
          this._zonePaintStart = null;
          this._zonePaintCurrent = null;
        } else if (!this.wasDrag(e)) {
          // Normal click handling
          const rect = canvas.getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const tile = this.screenToTile(sx, sy);

          if (tile) {
            // Priority: unit > NPC > workbench > generic tile
            const unit = this.getUnitAt(sx, sy);
            if (unit) {
              this.onLocalUnitClick?.(unit, sx, sy);
            } else {
              const npc = this.getNpcAt(sx, sy);
              if (npc) {
                this.onNpcClick?.(npc, sx, sy);
              } else {
                const t = this.getTile(tile.x, tile.y);
                if (t?.workbench) {
                  this.onWorkbenchClick?.(t, sx, sy);
                } else {
                  this.onTileClick?.(tile.x, tile.y, t, sx, sy);
                }
              }
            }
          }
        }
      }
      this.isDragging = false;
    });

    canvas.addEventListener('dblclick', (e) => {
      stopBubble(e);
      if (!this._inputActive) return;
      const rect = canvas.getBoundingClientRect();
      const tile = this.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
      if (tile) this.onTileDblClick?.(tile.x, tile.y, this.getTile(tile.x, tile.y));
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this._inputActive) return;
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(0.2, Math.min(4, this.cam.zoom * factor));
        const rect = canvas.getBoundingClientRect();
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

    window.addEventListener('resize', () => this.resize());

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (!this._inputActive) return;
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
        if (this._zonePaintMode) {
          this.setZonePaintMode(null);
          return;
        }
        this.onRequestExit?.();
        return;
      }
      // Zone painting shortcuts (shift + key to avoid conflicts)
      if (e.shiftKey) {
        const zoneMap: Record<string, ZoneType> = {
          s: 'stockpile',
          g: 'growing',
          r: 'recreation',
          b: 'bedroom',
          d: 'dining',
          h: 'hospital',
        };
        const type = zoneMap[e.key.toLowerCase()];
        if (type) {
          e.preventDefault();
          this.setZonePaintMode(this._zonePaintMode === type ? null : type);
        }
        // Escape to cancel zone painting
        if (e.key === 'Escape') {
          e.preventDefault();
          this.setZonePaintMode(null);
        }
      }
    });
  }

  private wasDrag(e: MouseEvent): boolean {
    return Math.abs(e.clientX - this.dragStart.x) > 4 || Math.abs(e.clientY - this.dragStart.y) > 4;
  }

  private _finalizeZonePaint(): void {
    if (!this._zonePaintMode || !this._zonePaintStart || !this._zonePaintCurrent || !this.world) return;

    const x0 = Math.min(this._zonePaintStart.x, this._zonePaintCurrent.x);
    const y0 = Math.min(this._zonePaintStart.y, this._zonePaintCurrent.y);
    const x1 = Math.max(this._zonePaintStart.x, this._zonePaintCurrent.x);
    const y1 = Math.max(this._zonePaintStart.y, this._zonePaintCurrent.y);

    const tiles: Array<{ x: number; y: number }> = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (this.getTile(x, y)) {
          tiles.push({ x, y });
        }
      }
    }

    if (tiles.length > 0) {
      this.onZonePainted?.(this._zonePaintMode, tiles);
    }
  }

  private screenToTile(sx: number, sy: number): { x: number; y: number } | null {
    const wx = (sx - this.cam.cx) / this.cam.zoom + this.cam.x;
    const wy = (sy - this.cam.cy) / this.cam.zoom + this.cam.y;
    if (this._isometric) {
      const iso = isoUnproject(wx, wy);
      return { x: Math.floor(iso.x), y: Math.floor(iso.y) };
    }
    const x = Math.floor(wx / TILE_SIZE);
    const y = Math.floor(wy / TILE_SIZE);
    return { x, y };
  }

  private getTile(x: number, y: number): LocalTile | null {
    if (!this.world) return null;
    if (y < 0 || y >= this.world.height || x < 0 || x >= this.world.width) return null;
    return this.world.grid[y]![x] ?? null;
  }

  /** Hit-test for local units (ported from macro getUnitAt pattern). */
  private getUnitAt(screenX: number, screenY: number): LocalUnit | null {
    if (!this.world || this._localUnits.length === 0) return null;
    const wx = (screenX - this.cam.cx) / this.cam.zoom + this.cam.x;
    const wy = (screenY - this.cam.cy) / this.cam.zoom + this.cam.y;

    if (this._isometric) {
      // In isometric mode, find the unit whose iso-projected position is nearest
      const threshold = ISO_TILE_W * 0.3;
      for (const unit of this._localUnits) {
        let gx: number, gy: number;
        if (unit.path.length > 0 && unit.pathIndex < unit.path.length) {
          const from = unit.path[unit.pathIndex]!;
          const to = unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!;
          const t = unit.pathProgress;
          gx = from.x + (to.x - from.x) * t;
          gy = from.y + (to.y - from.y) * t;
        } else {
          gx = unit.gridX;
          gy = unit.gridY;
        }
        const up = isoProject(gx, gy);
        if (Math.hypot(wx - up.px, wy - up.py) < threshold) return unit;
      }
      return null;
    }

    const threshold = TILE_SIZE * 0.45;
    for (const unit of this._localUnits) {
      let ux: number, uy: number;
      if (unit.path.length > 0 && unit.pathIndex < unit.path.length) {
        const from = unit.path[unit.pathIndex]!;
        const to = unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!;
        const t = unit.pathProgress;
        ux = (from.x + (to.x - from.x) * t) * TILE_SIZE + TILE_SIZE / 2;
        uy = (from.y + (to.y - from.y) * t) * TILE_SIZE + TILE_SIZE / 2;
      } else {
        ux = unit.gridX * TILE_SIZE + TILE_SIZE / 2;
        uy = unit.gridY * TILE_SIZE + TILE_SIZE / 2;
      }
      if (Math.hypot(wx - ux, wy - uy) < threshold) return unit;
    }
    return null;
  }

  /** Hit-test for stationary NPCs. */
  private getNpcAt(screenX: number, screenY: number): import('./types.ts').LocalNpc | null {
    if (!this.world || !this.world.npcs || this.world.npcs.length === 0) return null;
    const wx = (screenX - this.cam.cx) / this.cam.zoom + this.cam.x;
    const wy = (screenY - this.cam.cy) / this.cam.zoom + this.cam.y;

    if (this._isometric) {
      const threshold = ISO_TILE_W * 0.18;
      for (const npc of this.world.npcs) {
        const np = isoProject(npc.gridX, npc.gridY);
        if (Math.hypot(wx - np.px, wy - np.py) < threshold) return npc;
      }
      return null;
    }

    const threshold = TILE_SIZE * 0.35;
    for (const npc of this.world.npcs) {
      const nx = npc.gridX * TILE_SIZE + TILE_SIZE / 2;
      const ny = npc.gridY * TILE_SIZE + TILE_SIZE / 2;
      if (Math.hypot(wx - nx, wy - ny) < threshold) return npc;
    }
    return null;
  }

  // ─── Render ───────────────────────────────────────────────────────────────────
  render(localUnits: LocalUnit[]) {
    this._localUnits = localUnits;
    const { ctx, canvas, cam, world } = this;

    // ─── Fade Transition (process FIRST — works even without world) ────────────────────────
    const transitionAlpha = this._getTransitionAlpha();
    if (transitionAlpha <= 0 && this._transitionState === 'exiting') {
      this._transitionState = null; // reset after exit
      this.onExitLocalView?.(); // notify parent
      return;
    }
    if (transitionAlpha >= 1 && this._transitionState === 'entering') {
      this._transitionState = 'active';
    }

    // World-dependent rendering — skip if no world yet
    if (!world) return;

    // ─── Fase 1: LOD + Clean Mode at local level ──────────────────────
    this._currentLod = this.calcLod();
    const lodLow = this._currentLod === 'low';
    const isClean = this._cleanMode;

    // Frame-rate independent delta time calculation (Phase 5)
    const now = performance.now();
    const dt = Math.min((now - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = now;

    // Smooth camera animation (cubic ease-out)
    if (this._camAnim) {
      const t = Math.min(1, (now - this._camAnim.startTime) / this._camAnim.duration);
      const ease = 1 - Math.pow(1 - t, 3);
      this.cam.x = this._camAnim.fromX + (this._camAnim.targetX - this._camAnim.fromX) * ease;
      this.cam.y = this._camAnim.fromY + (this._camAnim.targetY - this._camAnim.fromY) * ease;
      if (t >= 1) this._camAnim = null;
    }

    // FPS counter (for debug overlay)
    this._fpsFrames++;
    if (now - this._fpsLastTime >= 1000) {
      this._fpsValue = this._fpsFrames;
      this._fpsFrames = 0;
      this._fpsLastTime = now;
    }

    // 3b. Rebuild static layer if needed (invalidate when room density flags change)
    const cacheKey = `${world.repoId}:${world.rooms.reduce((n, r) => n + r.workbenches.length, 0)}:${world.rooms.filter((r) => r.highDensity).length}`;
    if (!this.staticLayer || this.staticWorldId !== cacheKey) {
      this.rebuildStaticLayer();
      this.staticWorldId = cacheKey;
    }

    // ─── Cozy Pastel Background ─────────────────────────────────────────
    ctx.globalAlpha = transitionAlpha;
    // Warm cream base
    ctx.fillStyle = '#FFF8F3';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;

    // Subtle warm radial glow (light center, soft edges — cozy office light)
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

    // ─── Isometric 2.5D Rendering Branch ───────────────────────────────
    if (this._isometric && world) {
      if (!this.isoStaticLayer || this.isoStaticWorldId !== world.repoId) {
        this.rebuildIsoStaticLayer();
      }
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
        zonePaintMode: this._zonePaintMode,
        zonePaintStart: this._zonePaintStart,
        zonePaintCurrent: this._zonePaintCurrent,
        hoveredTile: this.hoveredTile,
        hoveredUnit: this._hoveredUnit,
        doorOpenStates: this.doorOpenStates,
        fpsValue: this._fpsValue,
        onUnitRendered: this.onUnitRendered,
        spawnZzz: (x, y) => this.spawnZzz(x, y),
        spawnBreath: (x, y) => this.spawnBreath(x, y),
        darkenHex: (hex, pct) => darkenHex(hex, pct),
      });
      ctx.restore();
      const grad = ctx.createRadialGradient(
        canvas.width / 2, canvas.height / 2, 0,
        canvas.width / 2, canvas.height / 2, canvas.width,
      );
      grad.addColorStop(0, 'rgba(255, 248, 243, 0)');
      grad.addColorStop(0.65, 'rgba(255, 240, 230, 0)');
      grad.addColorStop(1, 'rgba(245, 220, 205, 0.35)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }

    // ─── Cozy Outside World (soft patio / garden outside office) ────────
    if (world) {
      const worldPxW = world.width * TILE_SIZE;
      const worldPxH = world.height * TILE_SIZE;
      const left = (0 - cam.cx) / cam.zoom + cam.x;
      const top = (0 - cam.cy) / cam.zoom + cam.y;
      const right = (canvas.width - cam.cx) / cam.zoom + cam.x;
      const bottom = (canvas.height - cam.cy) / cam.zoom + cam.y;

      if (left < 0 || top < 0 || right > worldPxW || bottom > worldPxH) {
        const S = TILE_SIZE;
        const x0 = Math.floor(left / S) * S;
        const y0 = Math.floor(top / S) * S;
        const x1 = Math.ceil(right / S) * S;
        const y1 = Math.ceil(bottom / S) * S;

        for (let ty = y0; ty < y1; ty += S) {
          for (let tx = x0; tx < x1; tx += S) {
            if (tx >= 0 && ty >= 0 && tx < worldPxW && ty < worldPxH) continue;

            // Soft pastel patio tiles (alternating cream and blush)
            const isEven = (Math.abs(tx / S) + Math.abs(ty / S)) % 2 === 0;
            const baseR = isEven ? 250 : 248;
            const baseG = isEven ? 240 : 235;
            const baseB = isEven ? 230 : 228;
            ctx.fillStyle = `rgb(${baseR},${baseG},${baseB})`;
            ctx.fillRect(tx, ty, S, S);

            // Patio stone seams (soft warm gray)
            ctx.strokeStyle = 'rgba(210, 200, 190, 0.4)';
            ctx.lineWidth = 0.5;
            ctx.strokeRect(tx + 0.5, ty + 0.5, S - 1, S - 1);

            // Occasional small bush / grass tuft outside the office
            const hash = (Math.abs(tx / S) * 13 + Math.abs(ty / S) * 7) % 11;
            if (hash === 0 || hash === 5) {
              // Small rounded bush
              const bx = tx + S / 2;
              const by = ty + S / 2;
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

        // Soft warm border around the office building
        ctx.strokeStyle = 'rgba(220, 200, 185, 0.5)';
        ctx.lineWidth = 2;
        ctx.strokeRect(0.5, 0.5, worldPxW - 1, worldPxH - 1);
      }
    }

    // Draw static pre-rendered layer (Phase 3b)
    if (this.staticLayer) {
      ctx.drawImage(this.staticLayer, 0, 0);
    }

    // ─── Cozy window light rays (sunlight streaming onto floors) ────────
    const view = this.visibleTileRect();
    drawWindowLightRaysModule(this.overlayState(), world, view);

    // Draw dynamic tiles on top of the static canvas (Phase 3c/3d).
    // Desks always render individually — the area-scaled grid layout
    // guarantees they fit. The cluster pill panel is only an overflow
    // summary for rooms with more files than placed desks.
    for (let y = view.y0; y <= view.y1; y++) {
      for (let x = view.x0; x <= view.x1; x++) {
        const tile = world.grid[y]![x]!;
        if (tile.type === 'door') {
          this.drawDynamicDoorTile(tile, dt, localUnits);
        } else if (tile.type === 'workbench') {
          this.drawDynamicWorkbenchTile(tile);
        }
      }
    }

    // Overflow summary for rooms whose file count exceeds placed desks
    for (const room of world.rooms) {
      const placed = room.layoutPlan?.deskCount ?? 0;
      if (room.workbenches.length > placed && room.workbenches.length >= 3) {
        // Anchor at the room's top edge (over the wall, next to the room
        // label) so the summary never covers the desks themselves.
        const sx =
          ((room.x + room.width / 2) * TILE_SIZE - this.cam.x) * this.cam.zoom + this.cam.cx;
        const sy = (room.y * TILE_SIZE - this.cam.y) * this.cam.zoom + this.cam.cy;
        drawWorkbenchClusterPanel(
          this.assetState(),
          sx,
          sy,
          room.workbenches.map((wb) => wb.extension),
        );
      }
    }

    // Draw room labels (suppressed in low LOD)
    if (!lodLow) {
      for (const room of world.rooms) {
        drawRoomLabelModule(this.assetState(), room);
      }
    }

    // Draw local units
    for (const unit of localUnits) {
      this.drawLocalUnit(unit);
    }

    // Update and draw particles (suppressed in clean mode & low LOD)
    if (!isClean && !lodLow) {
      this.updateAndDrawParticles(dt);
    }

    // Draw Power Overlay (if toggled on)
    if (this._powerOverlay) {
      drawPowerOverlayModule(this.overlayState(), world, view);
    }

    // Draw Temperature Overlay (if toggled on)
    if (this._temperatureOverlay) {
      drawTemperatureOverlayModule(this.overlayState(), world, view);
    }

    // Draw Zones (from world.zones)
    if (world.zones && world.zones.length > 0) {
      drawZonesModule(this.overlayState(), world, view);
    }

    // Draw Zone Paint Preview (while dragging)
    if (this._zonePaintMode && this._zonePaintStart && this._zonePaintCurrent) {
      drawZonePaintPreviewModule(this.overlayState(), view);
    }

    // Draw hovered highlight
    if (this.hoveredTile) {
      const { x, y } = this.hoveredTile;
      const sx = x * TILE_SIZE;
      const sy = y * TILE_SIZE;
      ctx.save();
      ctx.strokeStyle = '#A07840';
      ctx.lineWidth = 2 / cam.zoom;
      ctx.strokeRect(sx + 1, sy + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      ctx.restore();
    }

    ctx.restore();

    // ─── Cozy Vignette Overlay ───────────────────────────────────────────
    // Warm soft vignette (light center, gently darker edges — cozy ambient)
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
      isoTileW: ISO_TILE_W,
      isoTileH: ISO_TILE_H,
      isoWallH: ISO_WALL_H,
      fontMono: this.tokens.fontMono ?? "'JetBrains Mono', monospace",
      extColor: EXT_COLOR,
      zoneLight: ISO_ZONE_LIGHT,
      isoProject,
      drawIsoTile: (ctx, tile, x, y, currentWorld) => {
        drawIsoTileModule({
          ctx,
          world: currentWorld,
          tokens: this.tokens,
          extColor: EXT_COLOR,
          doorOpenStates: this.doorOpenStates,
          spawnZzz: () => {},
          spawnBreath: () => {},
          darkenHex: (hex, pct) => darkenHex(hex, pct),
        }, tile, x, y, currentWorld);
      },
    });
    this._isoStaticOffsetX = result.offsetX;
    this._isoStaticOffsetY = result.offsetY;
    this.isoStaticLayer = result.canvas;
    this.isoStaticWorldId = world.repoId;
  }

  private visibleTileRect() {
    if (!this.world) return { x0: 0, y0: 0, x1: 0, y1: 0 };
    const { canvas, cam } = this;

    if (this._isometric) {
      // Screen corners → iso grid, then expand margin generously
      const corners = [
        isoUnproject((0 - cam.cx) / cam.zoom + cam.x, (0 - cam.cy) / cam.zoom + cam.y),
        isoUnproject((canvas.width - cam.cx) / cam.zoom + cam.x, (0 - cam.cy) / cam.zoom + cam.y),
        isoUnproject((0 - cam.cx) / cam.zoom + cam.x, (canvas.height - cam.cy) / cam.zoom + cam.y),
        isoUnproject((canvas.width - cam.cx) / cam.zoom + cam.x, (canvas.height - cam.cy) / cam.zoom + cam.y),
      ];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of corners) {
        minX = Math.min(minX, c.x);
        minY = Math.min(minY, c.y);
        maxX = Math.max(maxX, c.x);
        maxY = Math.max(maxY, c.y);
      }
      const margin = 3;
      const x0 = Math.max(0, Math.floor(minX) - margin);
      const y0 = Math.max(0, Math.floor(minY) - margin);
      const x1 = Math.min(this.world.width - 1, Math.ceil(maxX) + margin);
      const y1 = Math.min(this.world.height - 1, Math.ceil(maxY) + margin);
      return { x0, y0, x1, y1 };
    }

    // Screen bounds to world coordinates
    const left = (0 - cam.cx) / cam.zoom + cam.x;
    const top = (0 - cam.cy) / cam.zoom + cam.y;
    const right = (canvas.width - cam.cx) / cam.zoom + cam.x;
    const bottom = (canvas.height - cam.cy) / cam.zoom + cam.y;

    const x0 = Math.max(0, Math.floor(left / TILE_SIZE));
    const y0 = Math.max(0, Math.floor(top / TILE_SIZE));
    const x1 = Math.min(this.world.width - 1, Math.floor(right / TILE_SIZE));
    const y1 = Math.min(this.world.height - 1, Math.floor(bottom / TILE_SIZE));

    return { x0, y0, x1, y1 };
  }

  private drawDynamicDoorTile(tile: LocalTile, dt: number, localUnits: LocalUnit[]) {
    const { ctx } = this;
    const px = tile.x * TILE_SIZE;
    const py = tile.y * TILE_SIZE;
    const s = TILE_SIZE;
    const key = `${tile.x},${tile.y}`;

    const room = tile.roomId ? this.world?.rooms.find((r) => r.id === tile.roomId) : undefined;
    const zone = room?.zoneType;
    const isGlass = zone === 'team_cluster' || zone === 'meeting';

    const dpx = px + s / 2;
    const dpy = py + s / 2;

    // Calculate nearest agent distance
    let minD = Infinity;
    for (const unit of localUnits) {
      let ux: number, uy: number;
      if (unit.path.length > 0 && unit.pathIndex < unit.path.length) {
        const from = unit.path[unit.pathIndex]!;
        const to = unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!;
        const t = unit.pathProgress;
        ux = (from.x + (to.x - from.x) * t) * TILE_SIZE + TILE_SIZE / 2;
        uy = (from.y + (to.y - from.y) * t) * TILE_SIZE + TILE_SIZE / 2;
      } else {
        ux = unit.gridX * TILE_SIZE + TILE_SIZE / 2;
        uy = unit.gridY * TILE_SIZE + TILE_SIZE / 2;
      }
      const d = Math.hypot(ux - dpx, uy - dpy) / TILE_SIZE;
      if (d < minD) minD = d;
    }

    // Determine target open factor (Phase 5)
    const openPct = Math.max(0, Math.min(1, (1.8 - minD) * 1.5));
    let currentOpen = this.doorOpenStates.get(key) ?? 0;
    currentOpen = currentOpen + (openPct - currentOpen) * (1 - Math.exp(-dt * 12));
    this.doorOpenStates.set(key, currentOpen);

    // Draw sliding panels (Phase 5)
    const panelW = s / 2;
    const offset = panelW * currentOpen;

    ctx.save();

    if (isGlass) {
      // Soft glass sliding panels (cozy pastel)
      ctx.fillStyle = 'rgba(220, 240, 255, 0.3)';
      ctx.fillRect(px - offset, py + 1, panelW, s - 2);
      ctx.fillRect(px + panelW + offset, py + 1, panelW, s - 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px - offset + 0.5, py + 1.5, panelW - 1, s - 3);
      ctx.strokeRect(px + panelW + offset + 0.5, py + 1.5, panelW - 1, s - 3);
      // Frosted stripe
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(px - offset, py + s / 2 - 1, panelW, 2);
      ctx.fillRect(px + panelW + offset, py + s / 2 - 1, panelW, 2);
    } else {
      // Warm wood sliding panels (cozy pastel)
      ctx.fillStyle = '#F5E6D3';
      ctx.fillRect(px - offset, py + 1, panelW, s - 2);
      ctx.strokeStyle = 'rgba(212, 165, 116, 0.4)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px - offset + 0.5, py + 1.5, panelW - 1, s - 3);

      // Right sliding panel
      ctx.fillRect(px + panelW + offset, py + 1, panelW, s - 2);
      ctx.strokeRect(px + panelW + offset + 0.5, py + 1.5, panelW - 1, s - 3);
    }

    ctx.restore();
  }

  private drawDynamicWorkbenchTile(tile: LocalTile) {
    const { ctx } = this;
    const wb = tile.workbench;
    if (!wb) return;

    // Check if an agent is active on this workbench
    const activeUnit = this._localUnits.find(
      (u) => u.state === 'working_on_file' && u.currentWorkbenchId === wb.id,
    );
    if (!activeUnit) return;

    const px = tile.x * TILE_SIZE;
    const py = tile.y * TILE_SIZE;
    const s = TILE_SIZE;
    const now = performance.now();
    const extColor = EXT_COLOR[wb.extension] ?? '#888';

    ctx.save();

    // Glow effect (expensive, only for active ones!)
    ctx.shadowColor = extColor;
    ctx.shadowBlur = 10 + 4 * Math.sin(now / 250);

    // Active Monitor Screen background
    ctx.fillStyle = '#0f0f12';
    ctx.fillRect(px + 6, py + 5, s - 12, 9);
    ctx.restore();

    // Scroll lines of code
    ctx.save();
    // Clip to screen area
    ctx.beginPath();
    ctx.rect(px + 6, py + 5, s - 12, 9);
    ctx.clip();

    ctx.fillStyle = extColor;
    ctx.globalAlpha = 0.75;
    const scrollY = (now / 35) % 6;
    for (let i = 0; i < 3; i++) {
      const ly = py + 6 + i * 4 - scrollY;
      if (ly >= py + 5 && ly <= py + 14) {
        ctx.fillRect(px + 7, ly, s - 14, 1.5);
      }
    }
    ctx.restore();

    // Spawning sparks with random chance
    if (Math.random() < 0.15) {
      this.spawnSpark(px + s / 2, py + 15, extColor);
    }
  }

  /** Phase E: draw a compact cluster of file-type pills for high-density rooms.
   *  cx, cy are in tile coords; ctx already has camera transform applied. */
  private drawFloorBackground(tile: LocalTile, px: number, py: number, s: number, inRoom: boolean, zone?: string) {
    const { ctx } = this;
    if (!inRoom) {
      // ─── Corridor / common area — soft cream carpet ────────────────────
      const isAvenue = tile.type === 'path';
      const brightness = ((tile.x * 7 + tile.y * 3) % 5) - 2;
      let baseR = isAvenue ? 253 : 252;
      let baseG = isAvenue ? 246 : 244;
      let baseB = isAvenue ? 236 : 234;
      baseR += brightness * 1.5;
      baseG += brightness * 1.5;
      baseB += brightness * 1.5;
      ctx.fillStyle = `rgb(${Math.round(baseR)},${Math.round(baseG)},${Math.round(baseB)})`;
      ctx.fillRect(px, py, s, s);

      // Soft carpet tile seams
      ctx.strokeStyle = 'rgba(220, 200, 190, 0.25)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);

      // Center runner strip on main avenues
      if (isAvenue) {
        ctx.fillStyle = 'rgba(245, 208, 197, 0.2)';
        ctx.fillRect(px + s / 2 - 2, py, 4, s);
      }

      return;
    }

    // ─── Room floors — Cozy Pastel palette ────────────────────────────────
    const baseColors: Record<string, string> = {
      team_cluster: '#F5D0C5',   // soft rose office carpet
      meeting: '#B09060',        // warm light wood
      focus: '#E8F5D6',          // matcha green acoustic
      break: '#D0C0A0',          // warm lemon kitchen tile
      infra: '#E2E8F0',          // cool gray server floor
      reception: '#F5F0E8',      // polished marble cream
      biophilic: '#D4E8D0',      // sage green natural
    };

    const baseColor = baseColors[zone ?? 'team_cluster'] ?? '#F5D0C5';
    const delta = ((tile.x * 7 + tile.y * 3) % 5) * 2 - 4;
    ctx.fillStyle = _adjustBrightness(baseColor, delta);
    ctx.fillRect(px, py, s, s);

    // Soft tile seams (warm cream instead of dark)
    ctx.strokeStyle = 'rgba(200, 180, 170, 0.15)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);

    // ─── Zone-specific floor patterns ──────────────────────────────────

    if (zone === 'team_cluster') {
      // Soft checkerboard accent tiles
      if ((tile.x + tile.y) % 2 === 0) {
        ctx.fillStyle = 'rgba(252, 232, 224, 0.4)';
        ctx.fillRect(px + 2, py + 2, s - 4, s - 4);
      }
    }

    if (zone === 'meeting') {
      // Light wood plank lines
      ctx.strokeStyle = 'rgba(180, 150, 120, 0.12)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(px + s / 3, py);
      ctx.lineTo(px + s / 3, py + s);
      ctx.moveTo(px + 2 * s / 3, py);
      ctx.lineTo(px + 2 * s / 3, py + s);
      ctx.stroke();
    }

    if (zone === 'focus') {
      // Subtle leaf / acoustic texture dots
      ctx.fillStyle = 'rgba(168, 213, 162, 0.15)';
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 2; c++) {
          ctx.fillRect(px + 6 + c * 14, py + 6 + r * 14, 3, 3);
        }
      }
    }

    if (zone === 'break') {
      // Kitchen tile cross pattern
      ctx.strokeStyle = 'rgba(220, 190, 140, 0.15)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(px + s / 2, py);
      ctx.lineTo(px + s / 2, py + s);
      ctx.moveTo(px, py + s / 2);
      ctx.lineTo(px + s, py + s / 2);
      ctx.stroke();
    }

    if (zone === 'infra') {
      // Raised floor grid
      ctx.strokeStyle = 'rgba(160, 170, 185, 0.2)';
      ctx.beginPath();
      ctx.moveTo(px + s / 2, py);
      ctx.lineTo(px + s / 2, py + s);
      ctx.moveTo(px, py + s / 2);
      ctx.lineTo(px + s, py + s / 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(160, 170, 185, 0.25)';
      ctx.fillRect(px + s / 2 - 1, py + s / 2 - 1, 2, 2);
    }

    if (zone === 'reception') {
      // Marble vein hint
      ctx.strokeStyle = 'rgba(200, 190, 180, 0.1)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(px + 4, py + s - 4);
      ctx.quadraticCurveTo(px + s / 2, py + s / 2, px + s - 4, py + 4);
      ctx.stroke();
    }

    if (zone === 'biophilic') {
      // Stone path texture
      ctx.fillStyle = 'rgba(168, 213, 162, 0.1)';
      ctx.beginPath();
      ctx.arc(px + s / 2, py + s / 2, s * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Soft warm edge highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
  }

  private drawPathBackground(tile: LocalTile, px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy corridor carpet — pastel cream ─────────────────────────────
    const brightness = ((tile.x * 7 + tile.y * 3) % 7) - 3;
    let baseR = 253;
    let baseG = 245;
    let baseB = 235;
    baseR += brightness * 1.5;
    baseG += brightness * 1.5;
    baseB += brightness * 1.5;
    ctx.fillStyle = `rgb(${Math.round(baseR)},${Math.round(baseG)},${Math.round(baseB)})`;
    ctx.fillRect(px, py, s, s);

    // Soft carpet tile seams
    ctx.strokeStyle = 'rgba(220, 200, 190, 0.25)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);

    // Subtle fiber lines
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    for (let i = 2; i < s; i += 4) {
      ctx.moveTo(px + i, py + 2);
      ctx.lineTo(px + i, py + s - 2);
    }
    ctx.stroke();

    // Center runner strip (soft rose)
    ctx.fillStyle = 'rgba(245, 208, 197, 0.18)';
    ctx.fillRect(px + s / 2 - 2, py, 4, s);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(px + s / 2 - 1, py, 2, s);

    // ─── Soft warm light glow from ceiling ──────────────────────────────
    const lightX = px + s / 2;
    const lightY = py + s / 2;
    const lightGrad = ctx.createRadialGradient(lightX, lightY, 0, lightX, lightY, s * 0.7);
    lightGrad.addColorStop(0, 'rgba(255, 248, 240, 0.1)');
    lightGrad.addColorStop(1, 'rgba(255, 248, 240, 0)');
    ctx.fillStyle = lightGrad;
    ctx.fillRect(px, py, s, s);

    // ─── Soft wayfinding arrows ─────────────────────────────────────────
    if ((tile.x + tile.y * 3) % 11 === 0) {
      ctx.fillStyle = 'rgba(212, 165, 116, 0.2)';
      ctx.font = `bold ${s * 0.2}px ${this.tokens.fontMono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('▸', px + s / 2, py + s / 2);
    }

    // ─── Soft warm edge shadows from walls ─────────────────────────────
    const wallNearby = (dx: number, dy: number) => {
      const t = this.getTile(tile.x + dx, tile.y + dy);
      return t?.type === 'wall' || t?.type === 'door';
    };
    const warmShadow = 'rgba(180, 150, 130, 0.1)';
    if (wallNearby(0, -1)) {
      const shadowGrad = ctx.createLinearGradient(px, py + 5, px, py);
      shadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
      shadowGrad.addColorStop(1, warmShadow);
      ctx.fillStyle = shadowGrad;
      ctx.fillRect(px, py, s, 5);
    }
    if (wallNearby(0, 1)) {
      const shadowGrad = ctx.createLinearGradient(px, py + s - 5, px, py + s);
      shadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
      shadowGrad.addColorStop(1, warmShadow);
      ctx.fillStyle = shadowGrad;
      ctx.fillRect(px, py + s - 5, s, 5);
    }
    if (wallNearby(-1, 0)) {
      const shadowGrad = ctx.createLinearGradient(px + 5, py, px, py);
      shadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
      shadowGrad.addColorStop(1, warmShadow);
      ctx.fillStyle = shadowGrad;
      ctx.fillRect(px, py, 5, s);
    }
    if (wallNearby(1, 0)) {
      const shadowGrad = ctx.createLinearGradient(px + s - 5, py, px + s, py);
      shadowGrad.addColorStop(0, 'rgba(0,0,0,0)');
      shadowGrad.addColorStop(1, warmShadow);
      ctx.fillStyle = shadowGrad;
      ctx.fillRect(px + s - 5, py, 5, s);
    }
  }

  private drawTile(tile: LocalTile) {
    const { ctx } = this;
    const px = tile.x * TILE_SIZE;
    const py = tile.y * TILE_SIZE;
    const s = TILE_SIZE;
    const inRoom = tile.roomId !== null;
    const room = tile.roomId ? this.world?.rooms.find((r) => r.id === tile.roomId) : undefined;
    const zone = room?.zoneType;

    if (tile.type === 'floor') {
      this.drawFloorBackground(tile, px, py, s, inRoom, zone);
    } else if (tile.type === 'door') {
      this.drawFloorBackground(tile, px, py, s, inRoom, zone);
      this.drawDoorTile(px, py, s);
    } else if (tile.type === 'path') {
      this.drawPathBackground(tile, px, py, s);
    } else if (tile.type === 'wall') {
      this.drawWallFacade(tile, px, py, s, zone);
    } else {
      // draw appropriate flooring under objects
      if (inRoom) {
        this.drawFloorBackground(tile, px, py, s, true, zone);
      } else {
        this.drawPathBackground(tile, px, py, s);
      }

      if (tile.type === 'debris') {
        this.drawDebrisTile(px, py, s);
      } else if (tile.type === 'kiosk') {
        this.drawKioskTile(px, py, s);
      } else if (tile.type === 'workbench') {
        // Phase E: skip individual desk rendering when >=3 workbenchs in room
        const room = tile.roomId ? this.world?.rooms.find((r) => r.id === tile.roomId) : undefined;
        if (!room || room.workbenches.length < 3) {
          this.drawWorkbenchTile(tile, px, py, s);
        }
      } else if (tile.type === 'conduit') {
        // Subtle electrical wire on the floor
        ctx.strokeStyle = 'rgba(217, 119, 6, 0.6)'; // amber/orange wire
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, py + s / 2);
        ctx.lineTo(px + s, py + s / 2);
        ctx.moveTo(px + s / 2, py);
        ctx.lineTo(px + s / 2, py + s);
        ctx.stroke();

        // Small junction connector in the center
        ctx.fillStyle = '#f59e0b';
        ctx.fillRect(px + s / 2 - 2, py + s / 2 - 2, 4, 4);
      } else if (tile.type === 'power_source') {
        this.drawPowerSourceTile(px, py, s);
      } else if (tile.type === 'power_consumer') {
        this.drawPowerConsumerTile(px, py, s);
      } else if (tile.type === 'bed') {
        this.drawBedTile(px, py, s);
      } else if (tile.type === 'heater') {
        this.drawHeaterTile(px, py, s);
      } else if (tile.type === 'cooler') {
        this.drawCoolerTile(px, py, s);
      } else if (tile.type === 'vent') {
        this.drawVentTile(px, py, s);
      }
      // ─── Office Furniture (Phase 4) ───────────────────────────────────────
      else if (tile.type === 'standing_desk') {
        this.drawStandingDeskTile(px, py, s);
      } else if (tile.type === 'phone_booth') {
        this.drawPhoneBoothTile(px, py, s);
      } else if (tile.type === 'break_area') {
        this.drawBreakAreaTile(px, py, s);
      } else if (tile.type === 'meeting_room') {
        this.drawMeetingRoomTile(px, py, s);
      } else if (tile.type === 'whiteboard') {
        this.drawWhiteboardTile(px, py, s);
      } else if (tile.type === 'server_rack') {
        this.drawServerRackTile(px, py, s);
      } else if (tile.type === 'planter') {
        this.drawPlanterTile(px, py, s);
      } else if (tile.type === 'reception') {
        this.drawReceptionTile(px, py, s);
      } else if (tile.type === 'stairs') {
        this.drawStairsTile(px, py, s);
      } else if (tile.type === 'window') {
        drawWindowTileModule(this.assetState(), px, py, s);
      } else if (tile.type === 'sofa') {
        drawSofaTileModule(this.assetState(), px, py, s);
      } else if (tile.type === 'watercooler') {
        drawWatercoolerTileModule(this.assetState(), px, py, s);
      }
    }
  }

  private drawDoorTile(px: number, py: number, s: number, zone?: string) {
    const { ctx } = this;
    const isGlass = zone === 'team_cluster' || zone === 'meeting';

    // ─── Cozy pastel door frame ─────────────────────────────────────────
    ctx.fillStyle = isGlass ? 'rgba(200, 230, 255, 0.4)' : '#F5E6D3';
    ctx.fillRect(px, py, 4, s);
    ctx.fillRect(px + s - 4, py, 4, s);

    if (isGlass) {
      // Soft glass sliding panel
      ctx.fillStyle = 'rgba(220, 240, 255, 0.35)';
      ctx.fillRect(px + 4, py + s / 2 - 3, s - 8, 6);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px + 4, py + s / 2 - 3, s - 8, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(px + 4, py + s / 2 - 1, s - 8, 2);
    } else {
      // Warm wood sliding door panel
      ctx.fillStyle = '#B09060';
      ctx.fillRect(px + 4, py + s / 2 - 3, s - 8, 6);
      ctx.strokeStyle = 'rgba(200, 170, 140, 0.5)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px + 4, py + s / 2 - 3, s - 8, 6);
    }

    // Soft gold door handle
    ctx.fillStyle = isGlass ? '#E0E8F0' : '#A07840';
    ctx.fillRect(px + s / 2 - 2, py + s / 2 - 1, 4, 2);
  }

  private drawWallFacade(tile: LocalTile, px: number, py: number, s: number, zone?: string) {
    const { ctx } = this;

    const isOpen = (x: number, y: number) => {
      const t = this.getTile(x, y);
      return (
        t !== null &&
        (t.type === 'floor' ||
          t.type === 'door' ||
          t.type === 'path' ||
          t.type === 'workbench' ||
          t.type === 'kiosk')
      );
    };

    const north = isOpen(tile.x, tile.y - 1);
    const south = isOpen(tile.x, tile.y + 1);
    const east = isOpen(tile.x + 1, tile.y);
    const west = isOpen(tile.x - 1, tile.y);

    const isCorner = (east && south) || (east && north) || (west && south) || (west && north);

    // ─── Cozy pastel zone-aware wall styling ────────────────────────────
    const isGlass = zone === 'team_cluster' || zone === 'meeting';
    const isAcoustic = zone === 'focus';
    const isWood = zone === 'break' || zone === 'biophilic';
    const isConcrete = zone === 'infra';

    if (isCorner) {
      // Rounded structural column (soft cream)
      ctx.fillStyle = isConcrete ? '#E2E8F0' : isWood ? '#F5E6D3' : '#FDFBF7';
      ctx.fillRect(px, py, s, s);
      ctx.fillStyle = isConcrete ? '#E8EDF2' : isWood ? '#FAF0E6' : '#D0D0D0';
      ctx.fillRect(px + 3, py + 3, s - 6, s - 6);
      ctx.strokeStyle = 'rgba(200, 190, 180, 0.3)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px + 3, py + 3, s - 6, s - 6);
    } else {
      if (isGlass) {
        // Soft glass partition with blue-tint
        ctx.fillStyle = 'rgba(200, 230, 255, 0.2)';
        ctx.fillRect(px, py, s, s);
        // White metal frame
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
        // Soft frosted band
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fillRect(px + 1, py + s / 2 - 2, s - 2, 4);
      } else if (isAcoustic) {
        // Soft green acoustic panels
        ctx.fillStyle = '#B0C0B0';
        ctx.fillRect(px, py, s, s);
        // Subtle dot pattern
        ctx.fillStyle = 'rgba(168, 213, 162, 0.3)';
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) {
            ctx.beginPath();
            ctx.arc(px + 6 + c * 8, py + 6 + r * 8, 1.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.strokeStyle = 'rgba(200, 220, 200, 0.4)';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
      } else if (isWood) {
        // Warm light wood paneling
        ctx.fillStyle = '#F5E6D3';
        ctx.fillRect(px, py, s, s);
        ctx.strokeStyle = 'rgba(200, 170, 140, 0.3)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(px + s / 3, py);
        ctx.lineTo(px + s / 3, py + s);
        ctx.moveTo(px + 2 * s / 3, py);
        ctx.lineTo(px + 2 * s / 3, py + s);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(200, 170, 140, 0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
      } else {
        // Standard cozy white drywall
        ctx.fillStyle = isConcrete ? '#D8DCE0' : '#FDFBF7';
        ctx.fillRect(px, py, s, s);

        // Subtle drywall seam lines (soft warm gray)
        ctx.strokeStyle = 'rgba(220, 210, 200, 0.25)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(px, py + s / 2);
        ctx.lineTo(px + s, py + s / 2);
        ctx.stroke();
      }
    }

    // ─── Warm baseboard / molding ──────────────────────────────────────
    const moldingColor = isWood ? '#B09060' : isGlass ? '#E0E8F0' : '#F5E6D3';
    ctx.fillStyle = moldingColor;
    ctx.fillRect(px, py + s - 3, s, 3);

    // ─── Soft warm shadows ─────────────────────────────────────────────
    if (east) {
      const shadowGrad = ctx.createLinearGradient(px + s - 4, py, px + s, py);
      shadowGrad.addColorStop(0, 'rgba(180, 150, 130, 0)');
      shadowGrad.addColorStop(1, 'rgba(180, 150, 130, 0.12)');
      ctx.fillStyle = shadowGrad;
      ctx.fillRect(px + s - 4, py, 4, s);
    }
    if (south) {
      const shadowGrad = ctx.createLinearGradient(px, py + s - 4, px, py + s);
      shadowGrad.addColorStop(0, 'rgba(180, 150, 130, 0)');
      shadowGrad.addColorStop(1, 'rgba(180, 150, 130, 0.12)');
      ctx.fillStyle = shadowGrad;
      ctx.fillRect(px, py + s - 4, s, 4);
    }

    // Outline
    ctx.strokeStyle = isGlass ? 'rgba(148,163,184,0.4)' : '#1d1a17';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
  }

  private drawDebrisTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // Rubble heap
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(px + 4, py + 4, s - 8, s - 8);

    // Irregular rubble blocks
    ctx.fillStyle = '#443d35';
    ctx.fillRect(px + 6, py + 8, 4, 3);
    ctx.fillStyle = '#5e544b';
    ctx.fillRect(px + 14, py + 10, 5, 4);
    ctx.fillStyle = '#3a342f';
    ctx.fillRect(px + 10, py + 18, 6, 3);

    // Cracks
    ctx.strokeStyle = '#2d2722';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + 4, py + 4);
    ctx.lineTo(px + 12, py + 12);
    ctx.lineTo(px + s - 6, py + s - 10);
    ctx.stroke();
  }

  private drawKioskTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy kiosk — light wood with soft screen ─────────────────────
    ctx.fillStyle = '#F5E6D3';
    ctx.beginPath();
    ctx.roundRect(px + 4, py + 6, s - 8, s - 12, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 170, 140, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Keyboard shelf
    ctx.fillStyle = '#B09060';
    ctx.fillRect(px + 8, py + s - 10, s - 16, 2);

    // Soft screen monitor
    ctx.fillStyle = '#D8DCE0';
    ctx.beginPath();
    ctx.roundRect(px + 6, py + 8, s - 12, 10, 1);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
    ctx.stroke();

    ctx.fillStyle = 'rgba(212, 165, 116, 0.8)';
    ctx.font = `bold 6px ${this.tokens.fontMono}`;
    ctx.fillText('SYS', px + 10, py + 14);
  }

  private drawWorkbenchTile(tile: LocalTile, px: number, py: number, s: number) {
    const { ctx } = this;
    const wb = tile.workbench;
    if (!wb) return;

    // ─── Cozy workbench — light wood desk + monitor ─────────────────────
    // Light wood desktop
    ctx.fillStyle = '#B09060';
    ctx.beginPath();
    ctx.roundRect(px + 3, py + 4, s - 6, 16, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 170, 140, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Monitor stand
    ctx.fillStyle = '#E2E8F0';
    ctx.fillRect(px + s / 2 - 2, py + 14, 4, 3);

    // Monitor Screen (white frame)
    ctx.fillStyle = '#D0D0D0';
    ctx.beginPath();
    ctx.roundRect(px + 5, py + 5, s - 10, 10, 1);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Soft screen glow
    ctx.fillStyle = 'rgba(140, 170, 190, 0.3)';
    ctx.fillRect(px + 6, py + 6, s - 12, 8);

    // File extension label
    const extColor = EXT_COLOR[wb.extension] ?? '#888';
    ctx.fillStyle = extColor;
    ctx.font = `bold 7px ${this.tokens.fontMono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(wb.extension.toUpperCase().slice(0, 3), px + s / 2, py + 10);

    // Keyboard
    ctx.fillStyle = '#E2E8F0';
    ctx.fillRect(px + 9, py + 21, s - 18, 3);
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px + 9.5, py + 21.5, s - 19, 2);

    // Test indicator dot (soft amber)
    if (wb.isTest) {
      ctx.fillStyle = '#A07840';
      ctx.beginPath();
      ctx.arc(px + s - 7, py + 7, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Cute office chair (bottom part)
    const chairX = px + s / 2;
    const chairY = py + s - 6;

    // Chair base
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(chairX, chairY);
    ctx.lineTo(chairX - 3, chairY + 3);
    ctx.moveTo(chairX, chairY);
    ctx.lineTo(chairX + 3, chairY + 3);
    ctx.stroke();

    // Round seat cushion (soft pink)
    ctx.fillStyle = '#B08090';
    ctx.beginPath();
    ctx.arc(chairX, chairY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(248, 187, 208, 0.5)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  private drawPowerSourceTile(px: number, py: number, s: number) {
    const { ctx } = this;
    const centerX = px + s / 2;
    const centerY = py + s / 2;

    // ─── Cozy power source — soft white cabinet ─────────────────────────
    ctx.fillStyle = '#D8DCE0';
    ctx.beginPath();
    ctx.roundRect(px + 3, py + 3, s - 6, s - 6, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Soft vent lines
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.4)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(px + 6, py + 8 + i * 4);
      ctx.lineTo(px + s - 6, py + 8 + i * 4);
      ctx.stroke();
    }

    // Soft power indicator (warm glow)
    const now = performance.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 400);
    ctx.fillStyle = `rgba(168, 213, 162, ${0.5 + 0.2 * pulse})`;
    ctx.beginPath();
    ctx.arc(centerX, centerY + 4, 3, 0, Math.PI * 2);
    ctx.fill();

    // Label
    ctx.fillStyle = 'rgba(180, 190, 200, 0.6)';
    ctx.font = `bold 6px ${this.tokens.fontMono}`;
    ctx.textAlign = 'center';
    ctx.fillText('PWR', centerX, centerY - 4);
  }

  private drawPowerConsumerTile(px: number, py: number, s: number) {
    const { ctx } = this;

    // ─── Soft electrical panel — pastel ────────────────────────────────
    ctx.fillStyle = '#E2E8F0';
    ctx.beginPath();
    ctx.roundRect(px + s / 2 - 5, py + s / 2 - 5, 10, 10, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Tiny soft blinking LED
    const now = performance.now();
    ctx.fillStyle = (now % 1000 < 500) ? 'rgba(168, 213, 162, 0.6)' : 'rgba(180, 190, 200, 0.3)';
    ctx.beginPath();
    ctx.arc(px + s / 2, py + s / 2, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawBedTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy daybed / sofa bed — pastel ───────────────────────────────
    const frameColor = '#B09060';
    const sheetColor = '#D0D0D0';
    const blanketColor = '#FCE4EC';

    // Headboard
    ctx.fillStyle = frameColor;
    ctx.beginPath();
    ctx.roundRect(px + 2, py + 2, s - 4, 3, 1);
    ctx.fill();

    // Bed posts
    ctx.fillStyle = frameColor;
    ctx.beginPath();
    ctx.arc(px + 2, py + 3, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px + s - 2, py + 3, 1.5, 0, Math.PI * 2);
    ctx.fill();

    // Mattress sheet
    ctx.fillStyle = sheetColor;
    ctx.beginPath();
    ctx.roundRect(px + 3, py + 5, s - 6, s - 8, 2);
    ctx.fill();

    // Pillow (top)
    ctx.fillStyle = '#D0D0D0';
    ctx.beginPath();
    ctx.roundRect(px + 5, py + 6, s - 10, 4, 1);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 200, 200, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Blanket covering the bottom half
    ctx.fillStyle = blanketColor;
    ctx.beginPath();
    ctx.roundRect(px + 3, py + s - 14, s - 6, 10, 2);
    ctx.fill();
    // Blanket fold line
    ctx.fillStyle = '#B08090';
    ctx.fillRect(px + 3, py + s - 14, s - 6, 2);

    // Footboard
    ctx.fillStyle = frameColor;
    ctx.beginPath();
    ctx.roundRect(px + 2, py + s - 3, s - 4, 2, 1);
    ctx.fill();
  }

  private drawHeaterTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy radiator — warm pastel ───────────────────────────────────
    ctx.fillStyle = '#FAF0E6';
    ctx.beginPath();
    ctx.roundRect(px + 4, py + 4, s - 8, s - 8, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 180, 160, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Warm coils (soft orange glow)
    const now = performance.now();
    const glowIntensity = 0.3 + 0.15 * Math.sin(now / 200);
    ctx.fillStyle = `rgba(255, 200, 150, ${glowIntensity})`;
    ctx.fillRect(px + 7, py + 7, s - 14, s - 14);

    // Soft grille lines
    ctx.strokeStyle = 'rgba(200, 180, 160, 0.4)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) {
      const gx = px + 8 + i * 4;
      ctx.beginPath();
      ctx.moveTo(gx, py + 7);
      ctx.lineTo(gx, py + s - 7);
      ctx.stroke();
    }
  }

  private drawCoolerTile(px: number, py: number, s: number) {
    const { ctx } = this;
    const centerX = px + s / 2;
    const centerY = py + s / 2;

    // ─── Cozy AC unit — soft white ─────────────────────────────────────
    ctx.fillStyle = '#D8DCE0';
    ctx.beginPath();
    ctx.roundRect(px + 4, py + 4, s - 8, s - 8, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Soft fan circle
    ctx.fillStyle = '#E2E8F0';
    ctx.beginPath();
    ctx.arc(centerX, centerY, 8, 0, Math.PI * 2);
    ctx.fill();

    // Rotating fan blades (soft gray)
    const now = performance.now();
    const angle = (now / 150) % (Math.PI * 2);
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.6)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const bladeAngle = angle + (i * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(centerX + Math.cos(bladeAngle) * 6, centerY + Math.sin(bladeAngle) * 6);
      ctx.stroke();
    }

    // Soft blue LED
    ctx.fillStyle = 'rgba(186, 230, 253, 0.6)';
    ctx.beginPath();
    ctx.arc(px + 7, py + 7, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawVentTile(px: number, py: number, s: number) {
    const { ctx } = this;
    const centerX = px + s / 2;
    const centerY = py + s / 2;

    // ─── Cozy vent — soft white ─────────────────────────────────────────
    ctx.fillStyle = '#D8DCE0';
    ctx.beginPath();
    ctx.roundRect(px + 2, py + 2, s - 4, s - 4, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Soft grille slats
    ctx.fillStyle = 'rgba(180, 190, 200, 0.4)';
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(px + 5, py + 5 + i * 5, s - 10, 2);
    }

    // Airflow indicator (soft animated)
    const now = performance.now();
    ctx.fillStyle = `rgba(168, 213, 162, ${0.4 + 0.2 * Math.sin(now / 200)})`;
    ctx.font = `${s * 0.22}px ${this.tokens.fontMono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('↔', centerX, centerY);
  }

  // ─── Office Furniture Tiles (Phase 4) ────────────────────────────────────────

  private drawStandingDeskTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy standing desk — light wood rounded ───────────────────────
    // Desk surface (rounded feel)
    ctx.fillStyle = '#B09060';
    ctx.beginPath();
    ctx.roundRect(px + 2, py + 4, s - 4, 10, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 170, 140, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Monitor
    ctx.fillStyle = '#D8DCE0';
    ctx.beginPath();
    ctx.roundRect(px + 5, py + 2, s - 10, 7, 1);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Screen glow
    ctx.fillStyle = 'rgba(140, 170, 190, 0.3)';
    ctx.fillRect(px + 6, py + 3, s - 12, 5);
    // Small succulent on desk
    ctx.fillStyle = '#608860';
    ctx.beginPath();
    ctx.arc(px + s - 5, py + 12, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#B09060';
    ctx.beginPath();
    ctx.arc(px + s - 5, py + 14, 2, 0, Math.PI);
    ctx.fill();
  }

  private drawPhoneBoothTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy focus pod — soft rounded ────────────────────────────────
    ctx.fillStyle = '#B0C0B0';
    ctx.beginPath();
    ctx.roundRect(px + 3, py + 3, s - 6, s - 6, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(168, 213, 162, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Soft sound wave pattern
    ctx.strokeStyle = 'rgba(168, 213, 162, 0.25)';
    ctx.lineWidth = 0.5;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(px + 5, py + 5 + i * 7);
      ctx.lineTo(px + s - 5, py + 5 + i * 7);
      ctx.stroke();
    }
    // Small interior desk
    ctx.fillStyle = '#F5E6D3';
    ctx.beginPath();
    ctx.roundRect(px + 6, py + s - 10, s - 12, 4, 1);
    ctx.fill();
    // Soft indicator
    const now = performance.now();
    ctx.fillStyle = (now % 2000 < 1000) ? '#608860' : '#D4E8D0';
    ctx.beginPath();
    ctx.arc(px + s / 2, py + 6, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawBreakAreaTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy kitchen counter — warm pastel ────────────────────────────
    ctx.fillStyle = '#FAF0E6';
    ctx.beginPath();
    ctx.roundRect(px + 2, py + 10, s - 4, s - 12, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 180, 160, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Countertop
    ctx.fillStyle = '#F5E6D3';
    ctx.fillRect(px + 1, py + 8, s - 2, 4);
    // Cute coffee machine
    ctx.fillStyle = '#D8DCE0';
    ctx.beginPath();
    ctx.roundRect(px + 4, py + 2, 8, 8, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.4)';
    ctx.stroke();
    // Coffee machine warm glow
    const now = performance.now();
    ctx.fillStyle = `rgba(212, 165, 116, ${0.4 + 0.2 * Math.sin(now / 300)})`;
    ctx.fillRect(px + 6, py + 4, 2, 2);
    // Small microwave
    ctx.fillStyle = '#E2E8F0';
    ctx.beginPath();
    ctx.roundRect(px + s - 10, py + 3, 7, 6, 1);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
    ctx.stroke();
  }

  private drawMeetingRoomTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy meeting table — oval wood with soft chairs ───────────────
    // Oval table surface
    ctx.fillStyle = 'rgba(232, 197, 150, 0.5)';
    ctx.beginPath();
    ctx.ellipse(px + s / 2, py + s / 2, (s - 8) / 2, (s - 12) / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 170, 140, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Table legs
    ctx.fillStyle = '#B09060';
    ctx.beginPath();
    ctx.roundRect(px + 8, py + s - 6, 3, 4, 1);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(px + s - 11, py + s - 6, 3, 4, 1);
    ctx.fill();
    // Soft rounded chairs around table
    ctx.fillStyle = '#D0C0A0';
    ctx.beginPath();
    ctx.roundRect(px + 2, py + s / 2 - 3, 4, 6, 2);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(px + s - 6, py + s / 2 - 3, 4, 6, 2);
    ctx.fill();
    // Tiny coffee cup
    ctx.fillStyle = '#D0D0D0';
    ctx.beginPath();
    ctx.arc(px + s / 2, py + s / 2 + 2, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawWhiteboardTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy whiteboard — rounded with colorful notes ─────────────────
    ctx.fillStyle = '#D0D0D0';
    ctx.beginPath();
    ctx.roundRect(px + 2, py + 3, s - 4, s - 6, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 190, 180, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Colorful marker scribbles
    const colors = ['rgba(248, 187, 208, 0.4)', 'rgba(168, 213, 162, 0.4)', 'rgba(186, 230, 253, 0.4)'];
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = colors[i]!;
      ctx.beginPath();
      ctx.moveTo(px + 5, py + 7 + i * 5);
      ctx.lineTo(px + s - 5 - i * 2, py + 7 + i * 5 + (i % 2));
      ctx.stroke();
    }
    // Sticky notes
    ctx.fillStyle = 'rgba(248, 187, 208, 0.6)';
    ctx.fillRect(px + s - 8, py + 5, 4, 4);
    ctx.fillStyle = 'rgba(168, 213, 162, 0.6)';
    ctx.fillRect(px + s - 8, py + 11, 4, 4);
    // Small tray at bottom
    ctx.fillStyle = '#F5E6D3';
    ctx.beginPath();
    ctx.roundRect(px + 3, py + s - 5, s - 6, 3, 1);
    ctx.fill();
  }

  private drawServerRackTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // Rack body
    ctx.fillStyle = '#1e293b'; // slate-800
    ctx.fillRect(px + 2, py + 2, s - 4, s - 4);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 2, py + 2, s - 4, s - 4);
    // Server rows with blinking LEDs
    const now = performance.now();
    const rowCount = 4;
    for (let i = 0; i < rowCount; i++) {
      const ry = py + 4 + i * 7;
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 4, ry, s - 8, 5);
      // LED strip
      const ledColors = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444'];
      for (let j = 0; j < 3; j++) {
        const blink = Math.sin(now / 200 + i * 3 + j * 2) > 0;
        ctx.fillStyle = blink ? ledColors[(i + j) % ledColors.length]! : '#1e293b';
        ctx.fillRect(px + 6 + j * 7, ry + 1.5, 3, 2);
      }
    }
    // Soft cable hint at bottom
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(px + 4, py + s - 4);
    ctx.lineTo(px + s / 2, py + s - 1);
    ctx.lineTo(px + s - 4, py + s - 4);
    ctx.stroke();
  }

  private drawPlanterTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Large cozy indoor plant — terracotta pot ───────────────────────
    // Pot
    ctx.fillStyle = '#B09060';
    ctx.beginPath();
    ctx.moveTo(px + 5, py + s - 3);
    ctx.lineTo(px + s - 5, py + s - 3);
    ctx.lineTo(px + s - 4, py + s - 10);
    ctx.lineTo(px + 4, py + s - 10);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 170, 140, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Large plant foliage (lush green)
    ctx.fillStyle = '#608860';
    ctx.beginPath();
    ctx.ellipse(px + s / 2, py + s / 2 - 2, s * 0.32, s * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#90B090';
    ctx.beginPath();
    ctx.ellipse(px + s / 2 - 2, py + s / 2 - 5, s * 0.2, s * 0.18, -0.3, 0, Math.PI * 2);
    ctx.fill();
    // Small highlight leaf
    ctx.fillStyle = '#D4E8D0';
    ctx.beginPath();
    ctx.ellipse(px + s / 2 + 3, py + s / 2 - 3, s * 0.12, s * 0.1, 0.5, 0, Math.PI * 2);
    ctx.fill();
    // Soft shadow
    ctx.fillStyle = 'rgba(180, 150, 130, 0.1)';
    ctx.beginPath();
    ctx.ellipse(px + s / 2, py + s - 2, s * 0.25, 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawReceptionTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy reception desk — warm pastel wood ─────────────────────────
    // Curved desk body
    ctx.fillStyle = '#B09060';
    ctx.beginPath();
    ctx.moveTo(px + 4, py + s - 4);
    ctx.lineTo(px + s - 4, py + s - 4);
    ctx.lineTo(px + s - 5, py + 10);
    ctx.quadraticCurveTo(px + s / 2, py + 4, px + 5, py + 10);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 170, 140, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Countertop
    ctx.fillStyle = '#FAF0E6';
    ctx.beginPath();
    ctx.moveTo(px + 3, py + s - 4);
    ctx.lineTo(px + s - 3, py + s - 4);
    ctx.lineTo(px + s - 4, py + 10);
    ctx.quadraticCurveTo(px + s / 2, py + 5, px + 4, py + 10);
    ctx.closePath();
    ctx.fill();
    // Small computer monitor
    ctx.fillStyle = '#D8DCE0';
    ctx.beginPath();
    ctx.roundRect(px + s / 2 - 3, py + 8, 6, 5, 1);
    ctx.fill();
    ctx.fillStyle = 'rgba(186, 230, 253, 0.6)';
    ctx.fillRect(px + s / 2 - 2, py + 9, 4, 3);
  }

  private drawStairsTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy stairs — warm wood tones ─────────────────────────────────
    const steps = 4;
    const stepH = (s - 4) / steps;
    for (let i = 0; i < steps; i++) {
      const sy = py + 2 + i * stepH;
      const r = 232 + i * 3;
      const g = 197 + i * 2;
      const b = 150 + i * 2;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(px + 2, sy, s - 4, stepH - 0.5);
      // Step edge
      ctx.strokeStyle = 'rgba(200, 170, 140, 0.3)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(px + 2, sy + stepH - 0.5);
      ctx.lineTo(px + s - 2, sy + stepH - 0.5);
      ctx.stroke();
    }
    // Handrail hint
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px + s - 3, py + 2);
    ctx.lineTo(px + s - 3, py + s - 2);
    ctx.stroke();
  }

  private drawLocalUnit(unit: LocalUnit) {
    const { ctx } = this;
    let ux: number, uy: number;

    if (unit.path.length > 0 && unit.pathIndex < unit.path.length) {
      const from = unit.path[unit.pathIndex]!;
      const to = unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!;
      const t = unit.pathProgress;
      ux = (from.x + (to.x - from.x) * t) * TILE_SIZE + TILE_SIZE / 2;
      uy = (from.y + (to.y - from.y) * t) * TILE_SIZE + TILE_SIZE / 2;
    } else {
      ux = unit.gridX * TILE_SIZE + TILE_SIZE / 2;
      uy = unit.gridY * TILE_SIZE + TILE_SIZE / 2;
    }

    // Spawning Zzzs if unit is idle or resting (Phase 8)
    if ((unit.state === 'idle_in_room' || unit.state === 'resting') && Math.random() < 0.02) {
      this.spawnZzz(ux, uy);
    }

    // Determine motion vectors & angles
    //
    // Pre-fix, working units were rotated to face the workbench
    // (atan2(desk.y - unit.gridY, ...)) which made the 2D body sprite lie
    // down — same bug the iso renderer had. Stationary units now keep
    // their body upright; the shared computeUnitDirAngle() helper returns
    // 0 for non-moving units. See isoLocalRenderer.ts for the rationale
    // and isoLocalRenderer.test.ts for coverage.
    const isMoving = isUnitMoving(unit);
    const dirAngle = computeUnitDirAngle(unit);

    // Physically-correct Squash & Stretch (Fase 7)
    const speed = isMoving ? 3.6 * unit.effectiveSpeed : 0;
    const Sf = 1 + Math.min(0.25, speed * 0.08); // cap at 1.25 max stretch
    const Sc = 1 / Sf;

    // Harmonic bobbing vertically during walks
    const bobbingY = isMoving ? Math.sin(unit.pathProgress * Math.PI * 2) * 2.5 : 0;

    ctx.save();
    ctx.translate(ux, uy + bobbingY);
    if (unit.ephemeral) ctx.scale(0.8, 0.8);

    // Selection ring in cozy warm tone
    const isHovered = this._hoveredUnit?.id === unit.id;
    if (isHovered) {
      ctx.strokeStyle = '#A07840';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, TILE_SIZE * 0.55, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Squash & Stretch applied along the directional movement vector
    ctx.save();
    ctx.rotate(dirAngle);
    ctx.scale(Sf, Sc);

    // 1. Soft warm shadow
    ctx.fillStyle = 'rgba(180, 150, 130, 0.15)';
    ctx.beginPath();
    ctx.ellipse(-2, 1, TILE_SIZE * 0.28, TILE_SIZE * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();

    // 2. Torso (Shoulders/Clothing) - perpendicular to movement
    ctx.fillStyle = unit.color;
    ctx.strokeStyle = 'rgba(180, 150, 130, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(-2, 0, TILE_SIZE * 0.2, TILE_SIZE * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Draw tool belt/backpack on rear
    ctx.fillStyle = '#2d2722';
    ctx.fillRect(-8, -4, 3, 8);

    // 3. Head (skin tone) - offset forward
    ctx.fillStyle = '#f5d6b8';
    ctx.beginPath();
    ctx.arc(4, 0, TILE_SIZE * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 4. Safety Hard-hat / Helmet (Yellow/Orange)
    ctx.fillStyle = '#eab308'; // safety yellow
    ctx.beginPath();
    ctx.arc(4, 0, TILE_SIZE * 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Helmet brim/visor line
    ctx.strokeStyle = '#ca8a04';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(4, 0, TILE_SIZE * 0.16, -Math.PI / 3, Math.PI / 3);
    ctx.stroke();

    // Helmet top ridge
    ctx.strokeStyle = '#fef08a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(1, 0);
    ctx.lineTo(8, 0);
    ctx.stroke();

    // Visual direction visors / LED indicators flashing when working
    const now = performance.now();
    const isWorking = unit.state === 'working_on_file';
    if (isWorking) {
      const flash = Math.sin(now / 150) > 0;
      ctx.fillStyle = flash ? '#22C55E' : '#14532d';
      ctx.beginPath();
      ctx.arc(8, -2, 1.2, 0, Math.PI * 2);
      ctx.arc(8, 2, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore(); // restore Squash & Stretch

    // 5. Draw initials in a clean capsule below the character
    const initials = unit.name.slice(0, 2).toUpperCase();
    ctx.save();
    ctx.translate(0, TILE_SIZE * 0.52);

    ctx.font = `bold 8px ${this.tokens.fontMono}`;
    const textW = ctx.measureText(initials).width + 8;

    // capsule base
    ctx.fillStyle = 'rgba(30, 30, 30, 0.85)';
    ctx.fillRect(-textW / 2, -6, textW, 12);
    ctx.strokeStyle = 'rgba(200, 200, 200, 0.2)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(-textW / 2, -6, textW, 12);

    // text
    ctx.fillStyle = unit.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, 0, 0);
    ctx.restore();

    // Dynamic work progress ring in gstack success color
    if (unit.state === 'working_on_file' && unit.workProgress > 0) {
      ctx.strokeStyle = this.tokens.success || '#22C55E';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(
        0,
        0,
        TILE_SIZE * 0.46,
        -Math.PI / 2,
        -Math.PI / 2 + (Math.PI * 2 * unit.workProgress) / 100,
      );
      ctx.stroke();
    }

    // Status icon indicator in JetBrains Mono
    const statusIcon: Record<string, string> = {
      idle_in_room: '◌',
      walking_to_workbench: '→',
      walking_to_room: '→',
      working_on_file: '⚙',
      resting: '☾',
    };
    const icon = statusIcon[unit.state] ?? '?';
    ctx.fillStyle = unit.color;
    ctx.font = `${TILE_SIZE * 0.28}px ${this.tokens.fontMono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(icon, 0, -TILE_SIZE * 0.42);

    ctx.restore();

    if (this.onUnitRendered) {
      const sx = (ux - this.cam.x) * this.cam.zoom + this.cam.cx;
      const sy = (uy + bobbingY - this.cam.y) * this.cam.zoom + this.cam.cy;
      this.onUnitRendered(unit, sx, sy);
    }
  }

  private spawnSpark(x: number, y: number, color: string) {
    spawnSparkParticle(this.particles, x, y, color);
  }

  private spawnZzz(x: number, y: number) {
    spawnZzzParticle(this.particles, x, y, this.tokens.amber400 || '#FBBF24');
  }

  private updateAndDrawParticles(dt: number) {
    updateAndDrawLocalParticles(this.ctx, this.particles, dt, this.tokens.fontMono || "'JetBrains Mono', monospace");
  }

  private overlayState() {
    return {
      ctx: this.ctx,
      tokens: this.tokens,
      tileSize: TILE_SIZE,
      zonePaintMode: this._zonePaintMode,
      zonePaintStart: this._zonePaintStart,
      zonePaintCurrent: this._zonePaintCurrent,
      spawnBreath: (x: number, y: number) => this.spawnBreath(x, y),
    };
  }

  private assetState() {
    return {
      ctx: this.ctx,
      fontMono: this.tokens.fontMono || "'JetBrains Mono', monospace",
      tileSize: TILE_SIZE,
    };
  }

  private spawnBreath(x: number, y: number) {
    spawnBreathParticle(this.particles, x, y);
  }

  // ─── Zoom controls ────────────────────────────────────────────────────────────
  getCamera() {
    return this.cam;
  }

  jumpToTile(tileX: number, tileY: number) {
    if (this._isometric) {
      const p = isoProject(tileX, tileY);
      this.cam.x = p.px;
      this.cam.y = p.py;
    } else {
      this.cam.x = tileX * TILE_SIZE + TILE_SIZE / 2;
      this.cam.y = tileY * TILE_SIZE + TILE_SIZE / 2;
    }
  }

  /** Smooth animated camera pan (cubic ease-out). Cancels on user drag. */
  animateCameraTo(px: number, py: number, duration = 400): void {
    this._camAnim = {
      fromX: this.cam.x,
      fromY: this.cam.y,
      targetX: px,
      targetY: py,
      startTime: performance.now(),
      duration,
    };
  }

  /** Smoothly pan the camera to center on a grid coordinate, projecting per the active render mode. */
  animateCameraToGrid(gridX: number, gridY: number, duration = 400): void {
    const p = this._isometric
      ? isoProject(gridX, gridY)
      : { px: gridX * TILE_SIZE, py: gridY * TILE_SIZE };
    this.animateCameraTo(p.px, p.py, duration);
  }

}

