// ─── RepoCiv — Local Renderer (RimWorld-style 2D grid) ─────────────────────────
import type { LocalWorld, LocalTile, LocalRoom, LocalUnit, ZoneType } from './types.ts';

const TILE_SIZE = 32; // px per tile

interface LocalParticle {
  active: boolean;
  type: 'spark' | 'zzz';
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  life: number;
  maxLife: number;
  char?: string;
  baseX: number;
}

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

  // Door Animation State (Phase 5)
  private doorOpenStates = new Map<string, number>();
  private lastFrameTime = performance.now();

  // Particle Pool (Phase 8)
  private static readonly MAX_PARTICLES = 64;
  private particles: LocalParticle[] = [];

  // ─── Fase 1: LOD + Clean Mode ──────────────────────────────────────
  private _cleanMode = false;
  private _currentLod: 'low' | 'medium' | 'high' = 'medium';
  private _powerOverlay = false;

  setCleanMode(active: boolean): void {
    this._cleanMode = active;
  }
  isCleanMode(): boolean {
    return this._cleanMode;
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
  onTileClick: ((x: number, y: number, tile: LocalTile | null) => void) | null = null;
  onTileHover: ((x: number, y: number, tile: LocalTile | null) => void) | null = null;
  onTileDblClick: ((x: number, y: number, tile: LocalTile | null) => void) | null = null;

  // Spatial awareness callbacks (ported from macro pattern)
  onLocalUnitClick: ((unit: LocalUnit, screenX: number, screenY: number) => void) | null = null;
  onWorkbenchClick: ((tile: LocalTile, screenX: number, screenY: number) => void) | null = null;
  onLocalUnitHover: ((unit: LocalUnit | null, screenX: number, screenY: number) => void) | null =
    null;
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
    this.particles = [];
    for (let i = 0; i < LocalRenderer.MAX_PARTICLES; i++) {
      this.particles.push({
        active: false,
        type: 'spark',
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        color: '#000',
        size: 0,
        life: 0,
        maxLife: 0,
        baseX: 0,
      });
    }
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
    this.staticLayer = null; // force rebuild on setWorld
    // Center camera on the grid
    this.cam.x = world.width / 2;
    this.cam.y = world.height / 2;
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

    canvas.addEventListener('mousedown', (e) => {
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
            // Priority: unit > workbench > generic tile (matches macro pattern)
            const unit = this.getUnitAt(sx, sy);
            if (unit) {
              this.onLocalUnitClick?.(unit, sx, sy);
            } else {
              const t = this.getTile(tile.x, tile.y);
              if (t?.workbench) {
                this.onWorkbenchClick?.(t, sx, sy);
              } else {
                this.onTileClick?.(tile.x, tile.y, t);
              }
            }
          }
        }
      }
      this.isDragging = false;
    });

    canvas.addEventListener('dblclick', (e) => {
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
    const x = Math.floor(wx / TILE_SIZE);
    const y = Math.floor(wy / TILE_SIZE);
    return { x, y };
  }

  private getTile(x: number, y: number): LocalTile | null {
    if (!this.world) return null;
    if (y < 0 || y >= this.world.height || x < 0 || x >= this.world.width) return null;
    return this.world.grid[y]![x] ?? null;
  }

  /** Hit-test for local units (ported from macro getUnitAt pattern).
   *  Returns the unit whose interpolated world position is within TILE_SIZE*0.45 of screen coords. */
  private getUnitAt(screenX: number, screenY: number): LocalUnit | null {
    if (!this.world || this._localUnits.length === 0) return null;
    const wx = (screenX - this.cam.cx) / this.cam.zoom + this.cam.x;
    const wy = (screenY - this.cam.cy) / this.cam.zoom + this.cam.y;
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

    // 3b. Rebuild static layer if needed
    if (!this.staticLayer || this.staticWorldId !== world.repoId) {
      this.rebuildStaticLayer();
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
              ctx.fillStyle = hash === 0 ? '#A8D5A2' : '#C8E6C9';
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
    this.drawWindowLightRays(world, view);

    // Draw dynamic tiles on top of the static canvas (Phase 3c/3d)
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

    // Draw room labels (suppressed in low LOD)
    if (!lodLow) {
      for (const room of world.rooms) {
        this.drawRoomLabel(room);
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
      this.drawPowerOverlay(world, view);
    }

    // Draw Temperature Overlay (if toggled on)
    if (this._temperatureOverlay) {
      this.drawTemperatureOverlay(world, view);
    }

    // Draw Zones (from world.zones)
    if (world.zones && world.zones.length > 0) {
      this.drawZones(world, view);
    }

    // Draw Zone Paint Preview (while dragging)
    if (this._zonePaintMode && this._zonePaintStart && this._zonePaintCurrent) {
      this.drawZonePaintPreview(view);
    }

    // Draw hovered highlight
    if (this.hoveredTile) {
      const { x, y } = this.hoveredTile;
      const sx = x * TILE_SIZE;
      const sy = y * TILE_SIZE;
      ctx.save();
      ctx.strokeStyle = '#D4A574';
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
    const c = document.createElement('canvas');
    c.width = this.world.width * TILE_SIZE;
    c.height = this.world.height * TILE_SIZE;
    const sctx = c.getContext('2d')!;

    // Temporarily swap context
    const originalCtx = this.ctx;
    this.ctx = sctx;

    // Draw all tiles to offscreen canvas
    for (let y = 0; y < this.world.height; y++) {
      for (let x = 0; x < this.world.width; x++) {
        const tile = this.world.grid[y]![x]!;
        if (tile.type === 'door') {
          // Draw floor underneath sliding door
          this.drawTile({ ...tile, type: 'floor' });
        } else {
          this.drawTile(tile);
        }
      }
    }

    this.ctx = originalCtx;
    this.staticLayer = c;
    this.staticWorldId = this.world.repoId;
  }

  private visibleTileRect() {
    if (!this.world) return { x0: 0, y0: 0, x1: 0, y1: 0 };
    const { canvas, cam } = this;

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
      meeting: '#E8C596',        // warm light wood
      focus: '#E8F5D6',          // matcha green acoustic
      break: '#FCE8C5',          // warm lemon kitchen tile
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
        this.drawWorkbenchTile(tile, px, py, s);
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
        this.drawWindowTile(px, py, s);
      } else if (tile.type === 'sofa') {
        this.drawSofaTile(px, py, s);
      } else if (tile.type === 'watercooler') {
        this.drawWatercoolerTile(px, py, s);
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
      ctx.fillStyle = '#E8C596';
      ctx.fillRect(px + 4, py + s / 2 - 3, s - 8, 6);
      ctx.strokeStyle = 'rgba(200, 170, 140, 0.5)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px + 4, py + s / 2 - 3, s - 8, 6);
    }

    // Soft gold door handle
    ctx.fillStyle = isGlass ? '#E0E8F0' : '#D4A574';
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
      ctx.fillStyle = isConcrete ? '#E8EDF2' : isWood ? '#FAF0E6' : '#FFFFFF';
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
        ctx.fillStyle = '#E8F5E9';
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
        ctx.fillStyle = isConcrete ? '#F0F4F8' : '#FDFBF7';
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
    const moldingColor = isWood ? '#E8C596' : isGlass ? '#E0E8F0' : '#F5E6D3';
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
    ctx.fillStyle = '#E8C596';
    ctx.fillRect(px + 8, py + s - 10, s - 16, 2);

    // Soft screen monitor
    ctx.fillStyle = '#F0F4F8';
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
    ctx.fillStyle = '#E8C596';
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
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(px + 5, py + 5, s - 10, 10, 1);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.3)';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Soft screen glow
    ctx.fillStyle = 'rgba(200, 230, 255, 0.3)';
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
      ctx.fillStyle = '#D4A574';
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
    ctx.fillStyle = '#F8BBD0';
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
    ctx.fillStyle = '#F0F4F8';
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
    const frameColor = '#E8C596';
    const sheetColor = '#FFFFFF';
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
    ctx.fillStyle = '#FFFFFF';
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
    ctx.fillStyle = '#F8BBD0';
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
    ctx.fillStyle = '#F0F4F8';
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
    ctx.fillStyle = '#F0F4F8';
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
    ctx.fillStyle = '#E8C596';
    ctx.beginPath();
    ctx.roundRect(px + 2, py + 4, s - 4, 10, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 170, 140, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Monitor
    ctx.fillStyle = '#F0F4F8';
    ctx.beginPath();
    ctx.roundRect(px + 5, py + 2, s - 10, 7, 1);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 190, 200, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Screen glow
    ctx.fillStyle = 'rgba(200, 230, 255, 0.3)';
    ctx.fillRect(px + 6, py + 3, s - 12, 5);
    // Small succulent on desk
    ctx.fillStyle = '#A8D5A2';
    ctx.beginPath();
    ctx.arc(px + s - 5, py + 12, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#E8C596';
    ctx.beginPath();
    ctx.arc(px + s - 5, py + 14, 2, 0, Math.PI);
    ctx.fill();
  }

  private drawPhoneBoothTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy focus pod — soft rounded ────────────────────────────────
    ctx.fillStyle = '#E8F5E9';
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
    ctx.fillStyle = (now % 2000 < 1000) ? '#A8D5A2' : '#D4E8D0';
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
    ctx.fillStyle = '#F0F4F8';
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
    ctx.fillStyle = '#E8C596';
    ctx.beginPath();
    ctx.roundRect(px + 8, py + s - 6, 3, 4, 1);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(px + s - 11, py + s - 6, 3, 4, 1);
    ctx.fill();
    // Soft rounded chairs around table
    ctx.fillStyle = '#FCE8C5';
    ctx.beginPath();
    ctx.roundRect(px + 2, py + s / 2 - 3, 4, 6, 2);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(px + s - 6, py + s / 2 - 3, 4, 6, 2);
    ctx.fill();
    // Tiny coffee cup
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(px + s / 2, py + s / 2 + 2, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawWhiteboardTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy whiteboard — rounded with colorful notes ─────────────────
    ctx.fillStyle = '#FFFFFF';
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
    ctx.fillStyle = '#E8C596';
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
    ctx.fillStyle = '#A8D5A2';
    ctx.beginPath();
    ctx.ellipse(px + s / 2, py + s / 2 - 2, s * 0.32, s * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#C8E6C9';
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
    ctx.fillStyle = '#E8C596';
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
    ctx.fillStyle = '#F0F4F8';
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

  // ─── Window light rays (sunlight streaming onto adjacent floors) ─────
  private drawWindowLightRays(
    world: LocalWorld,
    view: { x0: number; y0: number; x1: number; y1: number },
  ) {
    const { ctx } = this;
    const S = TILE_SIZE;

    for (let y = view.y0; y <= view.y1; y++) {
      for (let x = view.x0; x <= view.x1; x++) {
        const tile = world.grid[y]?.[x];
        if (!tile || tile.type !== 'window') continue;

        // Find adjacent floor/path tiles and paint soft light rays
        const dirs = [
          { dx: 0, dy: 1 }, // south (into room)
          { dx: 0, dy: -1 }, // north
          { dx: 1, dy: 0 }, // east
          { dx: -1, dy: 0 }, // west
        ];
        for (const { dx, dy } of dirs) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < view.x0 || nx > view.x1 || ny < view.y0 || ny > view.y1) continue;
          const neighbor = world.grid[ny]?.[nx];
          if (!neighbor) continue;
          if (neighbor.type === 'floor' || neighbor.type === 'path') {
            // Soft warm sunlight ray on floor
            const npx = nx * S;
            const npy = ny * S;
            const rayGrad = ctx.createLinearGradient(
              npx + S / 2 - dx * S * 0.3,
              npy + S / 2 - dy * S * 0.3,
              npx + S / 2 + dx * S * 0.5,
              npy + S / 2 + dy * S * 0.5,
            );
            rayGrad.addColorStop(0, 'rgba(255, 248, 240, 0.25)');
            rayGrad.addColorStop(1, 'rgba(255, 248, 240, 0)');
            ctx.fillStyle = rayGrad;
            ctx.fillRect(npx, npy, S, S);
          }
        }
      }
    }
  }

  private drawWindowTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy large window with curtains ────────────────────────────────

    // White window frame with rounded feel
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(px + 1, py + 1, s - 2, s - 2);
    ctx.strokeStyle = '#F5E6D3';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 1, py + 1, s - 2, s - 2);

    // Sky view through window (soft blue gradient)
    const skyGrad = ctx.createLinearGradient(px, py, px, py + s);
    skyGrad.addColorStop(0, 'rgba(186, 230, 253, 0.6)');
    skyGrad.addColorStop(0.5, 'rgba(224, 242, 254, 0.4)');
    skyGrad.addColorStop(1, 'rgba(255, 250, 245, 0.3)');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(px + 4, py + 4, s - 8, s - 8);

    // Soft white window cross bars
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px + s / 2, py + 4);
    ctx.lineTo(px + s / 2, py + s - 4);
    ctx.moveTo(px + 4, py + s / 2);
    ctx.lineTo(px + s - 4, py + s / 2);
    ctx.stroke();

    // Pink curtains on sides
    ctx.fillStyle = 'rgba(248, 187, 208, 0.7)';
    ctx.fillRect(px + 2, py + 2, 5, s - 4); // left curtain
    ctx.fillRect(px + s - 7, py + 2, 5, s - 4); // right curtain

    // Curtain tie-backs (soft gold)
    ctx.fillStyle = 'rgba(212, 165, 116, 0.6)';
    ctx.fillRect(px + 5, py + s / 2 - 2, 3, 4);
    ctx.fillRect(px + s - 8, py + s / 2 - 2, 3, 4);

    // Sunlight streaming diagonal reflection
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.beginPath();
    ctx.moveTo(px + 4, py + 4);
    ctx.lineTo(px + s / 2 - 3, py + 4);
    ctx.lineTo(px + 4, py + s / 2 - 3);
    ctx.closePath();
    ctx.fill();
  }

  private drawSofaTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cozy plush sofa — soft pastel fabric ───────────────────────────
    ctx.fillStyle = '#F8BBD0';
    ctx.beginPath();
    ctx.roundRect(px + 2, py + 6, s - 4, s - 8, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(248, 187, 208, 0.5)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Seat cushion
    ctx.fillStyle = '#FCE4EC';
    ctx.beginPath();
    ctx.roundRect(px + 4, py + 10, s - 8, s - 14, 2);
    ctx.fill();
    // Backrest
    ctx.fillStyle = '#F8BBD0';
    ctx.beginPath();
    ctx.roundRect(px + 3, py + 6, s - 6, 5, 2);
    ctx.fill();
    // Cushion highlight
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(px + 5, py + 8, s - 10, 1.5);
    // Soft rounded armrests
    ctx.fillStyle = '#F48FB1';
    ctx.beginPath();
    ctx.roundRect(px + 2, py + 8, 3, 8, 1.5);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(px + s - 5, py + 8, 3, 8, 1.5);
    ctx.fill();
  }

  private drawWatercoolerTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // ─── Cute water cooler — pastel blue ────────────────────────────────
    // Base
    ctx.fillStyle = '#E3F2FD';
    ctx.beginPath();
    ctx.roundRect(px + s / 2 - 4, py + s - 8, 8, 6, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180, 200, 220, 0.4)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Water bottle (cute rounded)
    ctx.fillStyle = 'rgba(186, 230, 253, 0.4)';
    ctx.beginPath();
    ctx.ellipse(px + s / 2, py + s / 2 + 2, 5, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(186, 230, 253, 0.6)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Water level
    ctx.fillStyle = 'rgba(186, 230, 253, 0.6)';
    ctx.beginPath();
    ctx.ellipse(px + s / 2, py + s / 2 + 4, 4, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Small cup stack
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(px + s - 7, py + s - 6, 3, 4, 1);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200, 200, 200, 0.3)';
    ctx.stroke();
    // Soft glow
    const now = performance.now();
    ctx.fillStyle = `rgba(186, 230, 253, ${0.15 + 0.08 * Math.sin(now / 400)})`;
    ctx.beginPath();
    ctx.arc(px + s / 2, py + s / 2 + 2, 10, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawRoomLabel(room: LocalRoom) {
    const { ctx } = this;
    const px = room.x * TILE_SIZE;
    const py = room.y * TILE_SIZE;
    const pw = room.width * TILE_SIZE;

    // Office zone label takes precedence; fallback to folder name
    const primary = (room.zoneLabel ?? room.folderName).toUpperCase();
    const secondary = room.zoneLabel ? room.folderName.toUpperCase() : '';
    ctx.save();

    // ─── Cozy pastel zone-colored plaque tab ────────────────────────────
    const zoneColors: Record<string, string> = {
      team_cluster: '#F5D0C5',
      meeting: '#E8C596',
      focus: '#E8F5D6',
      break: '#FCE8C5',
      infra: '#E2E8F0',
      reception: '#F5F0E8',
      biophilic: '#D4E8D0',
    };
    const plaqueColor = zoneColors[room.zoneType ?? 'team_cluster'] ?? '#F5D0C5';

    ctx.fillStyle = plaqueColor;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 0.5;

    const plaqueW = Math.min(pw - 4, Math.max(80, primary.length * 7 + 12));
    ctx.beginPath();
    ctx.moveTo(px + 4, py + 2);
    ctx.lineTo(px + plaqueW, py + 2);
    ctx.lineTo(px + plaqueW + 2, py + 4);
    ctx.lineTo(px + plaqueW + 2, py + 14);
    ctx.lineTo(px + plaqueW, py + 16);
    ctx.lineTo(px + 4, py + 16);
    ctx.lineTo(px + 2, py + 14);
    ctx.lineTo(px + 2, py + 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.font = `bold 9px ${this.tokens.fontMono}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#5C4033'; // warm brown text for all pastel plaques
    ctx.fillText(primary.slice(0, 12), px + 6, py + 4);

    // Secondary label (folder name) if zone label is present
    if (secondary) {
      ctx.font = `7px ${this.tokens.fontMono}`;
      ctx.fillStyle = 'rgba(92, 64, 51, 0.6)';
      ctx.fillText(secondary.slice(0, 14), px + 6, py + 18);
    }

    ctx.restore();
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
    let dirAngle = 0;
    let isMoving = false;
    if (unit.path.length > 0 && unit.pathIndex < unit.path.length) {
      isMoving = true;
      const from = unit.path[unit.pathIndex]!;
      const to = unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!;
      dirAngle = Math.atan2(to.y - from.y, to.x - from.x);
    } else if (unit.state === 'working_on_file' && unit.currentWorkbenchId) {
      const wbTile = this.world?.grid
        .flat()
        .find((t) => t.workbench?.id === unit.currentWorkbenchId);
      if (wbTile) dirAngle = Math.atan2(wbTile.y - unit.gridY, wbTile.x - unit.gridX);
    }

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
      ctx.strokeStyle = '#D4A574';
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
    ctx.fillStyle = 'rgba(15, 13, 11, 0.85)';
    ctx.fillRect(-textW / 2, -6, textW, 12);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
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
    const p = this.particles.find((part) => !part.active);
    if (!p) return;

    p.active = true;
    p.type = 'spark';
    p.x = x;
    p.y = y;
    p.baseX = x;
    p.vx = (Math.random() - 0.5) * 12;
    p.vy = -15 - Math.random() * 20;
    p.color = color;
    p.size = 1.5 + Math.random() * 2;
    p.life = 0;
    p.maxLife = 0.6 + Math.random() * 0.4;
  }

  private spawnZzz(x: number, y: number) {
    const p = this.particles.find((part) => !part.active);
    if (!p) return;

    p.active = true;
    p.type = 'zzz';
    p.x = x;
    p.y = y;
    p.baseX = x;
    p.vx = 8 + Math.random() * 8;
    p.vy = -10 - Math.random() * 10;
    p.color = this.tokens.amber400 || '#FBBF24';
    p.size = 7 + Math.random() * 4;
    p.life = 0;
    p.maxLife = 1.2 + Math.random() * 0.8;
    p.char = Math.random() > 0.5 ? 'z' : 'Z';
  }

  private updateAndDrawParticles(dt: number) {
    const { ctx } = this;
    for (const p of this.particles) {
      if (!p.active) continue;

      p.life += dt;
      if (p.life >= p.maxLife) {
        p.active = false;
        continue;
      }

      p.baseX += p.vx * dt;
      p.y += p.vy * dt;

      if (p.type === 'spark') {
        p.x = p.baseX + Math.sin(p.life * 10) * 4;

        const alpha = Math.max(0, 1 - p.life / p.maxLife);
        ctx.save();
        ctx.fillStyle = p.color;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        p.x = p.baseX + Math.sin(p.life * 4) * 5;

        const alpha = Math.max(0, (1 - p.life / p.maxLife) * 0.6);
        ctx.save();
        ctx.fillStyle = p.color;
        ctx.globalAlpha = alpha;
        ctx.font = `${p.size}px ${this.tokens.fontMono}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.char || 'Z', p.x, p.y);
        ctx.restore();
      }
    }
  }

  private drawPowerOverlay(world: LocalWorld, view: { x0: number; y0: number; x1: number; y1: number }) {
    const { ctx } = this;
    const pg = world.powerGrid;
    if (!pg) return;

    ctx.save();
    ctx.globalAlpha = 0.6;

    // Draw conduit connections more prominently
    for (const key of pg.conduits) {
      const parts = key.split(',');
      if (parts.length < 2) continue;
      const sx = Number(parts[0]);
      const sy = Number(parts[1]);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      if (sx < view.x0 || sx > view.x1 || sy < view.y0 || sy > view.y1) continue;

      const px = sx * TILE_SIZE;
      const py = sy * TILE_SIZE;
      const s = TILE_SIZE;

      // Bright amber conduit lines
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px + s / 2, py);
      ctx.lineTo(px + s / 2, py + s);
      ctx.moveTo(px, py + s / 2);
      ctx.lineTo(px + s, py + s / 2);
      ctx.stroke();

      // Node highlight at intersections
      ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
      ctx.beginPath();
      ctx.arc(px + s / 2, py + s / 2, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw power sources with enhanced glow
    for (const src of pg.sources) {
      if (src.tileX < view.x0 || src.tileX > view.x1 || src.tileY < view.y0 || src.tileY > view.y1) continue;

      const px = src.tileX * TILE_SIZE;
      const py = src.tileY * TILE_SIZE;
      const s = TILE_SIZE;
      const centerX = px + s / 2;
      const centerY = py + s / 2;

      // Pulsing outer glow
      const now = performance.now();
      const pulse = 0.5 + 0.5 * Math.sin(now / 500);
      const glowR = s * 0.6 + 10 * pulse;

      const grad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, glowR);
      grad.addColorStop(0, `rgba(245, 158, 11, ${0.4 * pulse})`);
      grad.addColorStop(1, 'rgba(245, 158, 11, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(px - glowR, py - glowR, s + 2 * glowR, s + 2 * glowR);

      // Watts label
      ctx.fillStyle = this.tokens.amber500 || '#F59E0B';
      ctx.font = `bold 9px ${this.tokens.fontMono}`;
      ctx.textAlign = 'center';
      ctx.fillText(`${src.outputWatts}W`, centerX, py - 4);
    }

    // Draw power consumers with load indicator
    for (const cons of pg.consumers) {
      if (cons.tileX < view.x0 || cons.tileX > view.x1 || cons.tileY < view.y0 || cons.tileY > view.y1) continue;

      const px = cons.tileX * TILE_SIZE;
      const py = cons.tileY * TILE_SIZE;
      const s = TILE_SIZE;

      // Small load bar
      const barW = s * 0.8;
      const barH = 3;
      const bx = px + (s - barW) / 2;
      const by = py + s + 2;

      // Background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(bx, by, barW, barH);

      // Load (based on watts, max 200W)
      const loadPct = Math.min(1, cons.watts / 200);
      ctx.fillStyle = loadPct > 0.8 ? '#EF4444' : loadPct > 0.5 ? '#F59E0B' : '#22C55E';
      ctx.fillRect(bx, by, barW * loadPct, barH);
    }

    // Global power stats in corner
    if (pg.generatedWatts > 0 || pg.consumedWatts > 0) {
      const statsX = view.x0 * TILE_SIZE + 10;
      const statsY = view.y0 * TILE_SIZE + 20;
      ctx.fillStyle = 'rgba(13, 13, 20, 0.9)';
      ctx.fillRect(statsX - 5, statsY - 5, 160, 50);
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
      ctx.strokeRect(statsX - 5, statsY - 5, 160, 50);

      ctx.fillStyle = '#22C55E';
      ctx.font = `11px ${this.tokens.fontMono}`;
      ctx.textAlign = 'left';
      ctx.fillText(`⚡ Gen: ${pg.generatedWatts}W`, statsX, statsY + 12);
      ctx.fillStyle = '#EF4444';
      ctx.fillText(`🔌 Con: ${pg.consumedWatts}W`, statsX, statsY + 28);
      ctx.fillStyle = pg.storedWatts > 0 ? '#3B82F6' : '#6B7280';
      ctx.fillText(`🔋 Bat: ${pg.storedWatts}W`, statsX, statsY + 44);
    }

    ctx.restore();
  }

  private drawTemperatureOverlay(world: LocalWorld, view: { x0: number; y0: number; x1: number; y1: number }) {
    const { ctx } = this;
    const climates = world.roomClimates;
    if (!climates) return;

    ctx.save();
    ctx.globalAlpha = 0.5;

    // Color scale: blue (cold) -> white (comfort) -> red (hot)
    function tempToColor(temp: number): string {
      const comfortMin = 16, comfortMax = 26;
      if (temp <= comfortMin) {
        // Cold: blue to cyan
        const t = Math.max(0, (temp + 20) / (comfortMin + 20)); // -20 to comfortMin
        const r = Math.round(0 + t * 0);
        const g = Math.round(100 + t * 155);
        const b = 255;
        return `rgb(${r},${g},${b})`;
      } else if (temp >= comfortMax) {
        // Hot: yellow to red
        const t = Math.min(1, (temp - comfortMax) / (50 - comfortMax)); // comfortMax to 50
        const r = 255;
        const g = Math.round(255 * (1 - t));
        const b = 0;
        return `rgb(${r},${g},${b})`;
      } else {
        // Comfort zone: white to light green
        const t = (temp - comfortMin) / (comfortMax - comfortMin);
        const r = Math.round(200 * (1 - t));
        const g = 255;
        const b = Math.round(200 * (1 - t));
        return `rgb(${r},${g},${b})`;
      }
    }

    // Draw room temperature overlay
    for (const [roomId, climate] of climates) {
      const room = world.rooms.find(r => r.id === roomId);
      if (!room) continue;

      const roomCenterX = (room.x + room.width / 2) * TILE_SIZE;
      const roomCenterY = (room.y + room.height / 2) * TILE_SIZE;

      // Skip if room center not in view
      if (roomCenterX < view.x0 * TILE_SIZE || roomCenterX > view.x1 * TILE_SIZE ||
          roomCenterY < view.y0 * TILE_SIZE || roomCenterY > view.y1 * TILE_SIZE) continue;

      const color = tempToColor(climate.temperature);
      
      // Temperature indicator at room center
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.arc(roomCenterX, roomCenterY, Math.max(room.width, room.height) * TILE_SIZE * 0.35, 0, Math.PI * 2);
      ctx.fill();

      // Temperature label
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.font = `bold 12px ${this.tokens.fontMono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${climate.temperature.toFixed(1)}°C`, roomCenterX, roomCenterY);
      
      // Target temperature indicator
      if (Math.abs(climate.temperature - climate.targetTemperature) > 0.5) {
        ctx.fillStyle = '#FBBF24'; // amber
        ctx.font = `9px ${this.tokens.fontMono}`;
        const arrow = climate.temperature < climate.targetTemperature ? '▲' : '▼';
        ctx.fillText(`${arrow} ${climate.targetTemperature.toFixed(1)}°C`, roomCenterX, roomCenterY + 18);
      }

      // Breath particles for cold rooms
      if (climate.temperature < 10 && Math.random() < 0.02) {
        const px = room.x * TILE_SIZE + Math.random() * room.width * TILE_SIZE;
        const py = room.y * TILE_SIZE + Math.random() * room.height * TILE_SIZE;
        this.spawnBreath(px, py);
      }
    }

    // Draw heater/cooler/vent indicators
    for (const [roomId, climate] of climates) {
      const room = world.rooms.find(r => r.id === roomId);
      if (!room) continue;

      // Heaters
      for (const heater of climate.heaters) {
        if (heater.tileX < view.x0 || heater.tileX > view.x1 || heater.tileY < view.y0 || heater.tileY > view.y1) continue;
        const px = heater.tileX * TILE_SIZE;
        const py = heater.tileY * TILE_SIZE;
        const s = TILE_SIZE;
        const centerX = px + s / 2;

        // Heat wave effect
        const now = performance.now();
        ctx.strokeStyle = `rgba(239, 83, 80, ${0.4 + 0.3 * Math.sin(now / 120)})`;
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.moveTo(centerX - 6 + i * 6, py + s);
          ctx.quadraticCurveTo(centerX + 4 * Math.sin(now / 100 + i), py + s - 8, centerX - 6 + i * 6, py + s - 16);
          ctx.stroke();
        }
      }

      // Coolers
      for (const cooler of climate.coolers) {
        if (cooler.tileX < view.x0 || cooler.tileX > view.x1 || cooler.tileY < view.y0 || cooler.tileY > view.y1) continue;
        const px = cooler.tileX * TILE_SIZE;
        const py = cooler.tileY * TILE_SIZE;
        const s = TILE_SIZE;
        const centerX = px + s / 2;

        // Cold air particles
        const now = performance.now();
        ctx.fillStyle = `rgba(100, 181, 246, ${0.4 + 0.3 * Math.sin(now / 150)})`;
        for (let i = 0; i < 4; i++) {
          const px2 = centerX + (i - 1.5) * 4;
          const py2 = py + s - 3 - (now / 80 + i * 0.5) % 10;
          ctx.beginPath();
          ctx.arc(px2, py2, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Vents (airflow indicator)
      for (const vent of climate.vents) {
        if (!vent.open) continue;
        if (vent.tileX < view.x0 || vent.tileX > view.x1 || vent.tileY < view.y0 || vent.tileY > view.y1) continue;
        const px = vent.tileX * TILE_SIZE;
        const py = vent.tileY * TILE_SIZE;
        const s = TILE_SIZE;
        const centerX = px + s / 2;
        const centerY = py + s / 2;

        ctx.fillStyle = `rgba(144, 164, 174, ${0.6 + 0.3 * Math.sin(performance.now() / 200)})`;
        ctx.font = `${s * 0.3}px ${this.tokens.fontMono}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('↔', centerX, centerY);
      }
    }

    ctx.restore();
  }

  private spawnBreath(x: number, y: number) {
    const p = this.particles.find((part) => !part.active);
    if (!p) return;

    p.active = true;
    p.type = 'zzz';
    p.x = x;
    p.y = y;
    p.baseX = x;
    p.vx = (Math.random() - 0.5) * 10;
    p.vy = -8 - Math.random() * 8;
    p.color = 'rgba(200, 230, 255, 0.7)'; // pale blue
    p.size = 6 + Math.random() * 4;
    p.life = 0;
    p.maxLife = 1.5 + Math.random() * 1.0;
    p.char = '∼';
  }

  private drawZones(world: LocalWorld, view: { x0: number; y0: number; x1: number; y1: number }) {
    const { ctx } = this;
    if (!world.zones) return;

    const zoneColors: Record<string, string> = {
      stockpile: '#8B5A2B',      // brown
      growing: '#4A7C2E',        // green
      recreation: '#D4A537',     // gold
      bedroom: '#6B4F8A',        // purple
      dining: '#C46B3B',         // orange-brown
      hospital: '#C0392B',       // red
    };

    for (const zone of world.zones) {
      const color = zoneColors[zone.type] || '#888';
      const alpha = 0.15;

      // Draw filled tiles
      ctx.fillStyle = `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
      for (const tile of zone.tiles) {
        if (tile.x < view.x0 || tile.x > view.x1 || tile.y < view.y0 || tile.y > view.y1) continue;
        const px = tile.x * TILE_SIZE;
        const py = tile.y * TILE_SIZE;
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      }

      // Draw border around zone bounds
      if (zone.tiles.length > 0) {
        const xs = zone.tiles.map((t: { x: number; y: number }) => t.x);
        const ys = zone.tiles.map((t: { x: number; y: number }) => t.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        const px = minX * TILE_SIZE;
        const py = minY * TILE_SIZE;
        const pw = (maxX - minX + 1) * TILE_SIZE;
        const ph = (maxY - minY + 1) * TILE_SIZE;

        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
        ctx.setLineDash([]);

        // Zone type label
        ctx.fillStyle = color;
        ctx.font = `bold 9px ${this.tokens.fontMono}`;
        ctx.textAlign = 'left';
        ctx.fillText(zone.type.toUpperCase(), px + 3, py + 12);
      }
    }
  }

  private drawZonePaintPreview(view: { x0: number; y0: number; x1: number; y1: number }) {
    const { ctx } = this;
    if (!this._zonePaintStart || !this._zonePaintCurrent) return;

    const x0 = Math.min(this._zonePaintStart.x, this._zonePaintCurrent.x);
    const y0 = Math.min(this._zonePaintStart.y, this._zonePaintCurrent.y);
    const x1 = Math.max(this._zonePaintStart.x, this._zonePaintCurrent.x);
    const y1 = Math.max(this._zonePaintStart.y, this._zonePaintCurrent.y);

    const zoneColors: Record<string, string> = {
      stockpile: '#8B5A2B',
      growing: '#4A7C2E',
      recreation: '#D4A537',
      bedroom: '#6B4F8A',
      dining: '#C46B3B',
      hospital: '#C0392B',
    };
    const color = zoneColors[this._zonePaintMode || 'stockpile'] || '#888';

    // Semi-transparent fill
    ctx.fillStyle = `${color}33`; // 20% alpha
    for (let y = y0; y <= y1; y++) {
      if (y < view.y0 || y > view.y1) continue;
      for (let x = x0; x <= x1; x++) {
        if (x < view.x0 || x > view.x1) continue;
        const px = x * TILE_SIZE;
        const py = y * TILE_SIZE;
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      }
    }

    // Dashed border
    const px = x0 * TILE_SIZE;
    const py = y0 * TILE_SIZE;
    const pw = (x1 - x0 + 1) * TILE_SIZE;
    const ph = (y1 - y0 + 1) * TILE_SIZE;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.strokeRect(px, py, pw, ph);
    ctx.setLineDash([]);

    // Dimensions label
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    ctx.fillStyle = color;
    ctx.font = `bold 10px ${this.tokens.fontMono}`;
    ctx.textAlign = 'center';
    ctx.fillText(`${w}×${h} (${w * h} tiles)`, px + pw / 2, py - 5);
  }

  // ─── Zoom controls ────────────────────────────────────────────────────────────
  getCamera() {
    return this.cam;
  }

  jumpToTile(tileX: number, tileY: number) {
    this.cam.x = tileX * TILE_SIZE + TILE_SIZE / 2;
    this.cam.y = tileY * TILE_SIZE + TILE_SIZE / 2;
  }
}

// ─── Helper: vary brightness of a hex color by ±percent ───────────────────────
function _adjustBrightness(hex: string, delta: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, v + delta));
  const toHex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${toHex(clamp(r))}${toHex(clamp(g))}${toHex(clamp(b))}`;
}

// ─── Extension → color map ────────────────────────────────────────────────────
const EXT_COLOR: Record<string, string> = {
  ts: '#4a9bd4',
  tsx: '#4a9bd4',
  js: '#e8c44a',
  jsx: '#e8c44a',
  py: '#4ab4d4',
  rs: '#b4a04a',
  go: '#4ad4b4',
  json: '#a04ab4',
  md: '#b4a04a',
  css: '#4ad44a',
  html: '#d44a4a',
  yaml: '#4a4ad4',
  yml: '#4a4ad4',
  sh: '#4ad4a0',
  bash: '#4ad4a0',
  toml: '#d4a04a',
  png: '#888',
  svg: '#888',
};
