// ─── RepoCiv — Local Renderer (RimWorld-style 2D grid) ─────────────────────────
import type { LocalWorld, LocalTile, LocalRoom, LocalUnit } from './types.ts';

const TILE_SIZE = 24; // px per tile

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

  setCleanMode(active: boolean): void {
    this._cleanMode = active;
  }
  isCleanMode(): boolean {
    return this._cleanMode;
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
      if (e.button === 0) {
        this.isDragging = true;
        this.dragStart = { x: e.clientX, y: e.clientY };
        this.camStart = { x: this.cam.x, y: this.cam.y };
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const tile = this.screenToTile(wx, wy);
      this.hoveredTile = tile;

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
      if (e.button === 0 && !this.wasDrag(e)) {
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
            if (t?.type === 'workbench' && t.workbench) {
              this.onWorkbenchClick?.(t, sx, sy);
            } else {
              this.onTileClick?.(tile.x, tile.y, t);
            }
          }
        }
      }
      this.isDragging = false;
    });

    canvas.addEventListener('dblclick', (e) => {
      const rect = canvas.getBoundingClientRect();
      const tile = this.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
      if (tile) this.onTileDblClick?.(tile.x, tile.y, this.getTile(tile.x, tile.y));
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
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
  }

  private wasDrag(e: MouseEvent): boolean {
    return Math.abs(e.clientX - this.dragStart.x) > 4 || Math.abs(e.clientY - this.dragStart.y) > 4;
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

    // Background
    ctx.fillStyle = '#0d0d14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(cam.cx, cam.cy);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    // Draw static pre-rendered layer (Phase 3b)
    if (this.staticLayer) {
      ctx.drawImage(this.staticLayer, 0, 0);
    }

    // Draw dynamic tiles on top of the static canvas (Phase 3c/3d)
    const view = this.visibleTileRect();
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

    // Draw hovered highlight
    if (this.hoveredTile) {
      const { x, y } = this.hoveredTile;
      const sx = x * TILE_SIZE;
      const sy = y * TILE_SIZE;
      ctx.save();
      ctx.strokeStyle = '#c8a84b';
      ctx.lineWidth = 2 / cam.zoom;
      ctx.strokeRect(sx + 1, sy + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      ctx.restore();
    }

    ctx.restore();

    // Vignette overlay
    const grad = ctx.createRadialGradient(
      canvas.width / 2,
      canvas.height / 2,
      0,
      canvas.width / 2,
      canvas.height / 2,
      canvas.width,
    );
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.25)');
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

    // Left sliding panel
    ctx.fillStyle = this.tokens.zinc600 || '#52525B';
    ctx.fillRect(px - offset, py + 1, panelW, s - 2);
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.45)'; // Amber outline
    ctx.lineWidth = 1;
    ctx.strokeRect(px - offset + 0.5, py + 1.5, panelW - 1, s - 3);

    // Right sliding panel
    ctx.fillRect(px + panelW + offset, py + 1, panelW, s - 2);
    ctx.strokeRect(px + panelW + offset + 0.5, py + 1.5, panelW - 1, s - 3);

    ctx.restore();
  }

  private drawDynamicWorkbenchTile(tile: LocalTile) {
    const { ctx } = this;
    const wb = tile.workbench;
    if (!wb) return;

    // Check if an agent is active on this workbench (Phase 6)
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
    ctx.shadowBlur = 12 + 6 * Math.sin(now / 250);

    // Terminal Monitor Screen background
    ctx.fillStyle = '#1c1c1f';
    ctx.fillRect(px + 4, py + 4, s - 8, s - 10);
    ctx.restore();

    // Scroll lines of code
    ctx.save();
    // Clip to screen area
    ctx.beginPath();
    ctx.rect(px + 4, py + 4, s - 8, s - 10);
    ctx.clip();

    ctx.fillStyle = extColor;
    ctx.globalAlpha = 0.6;
    const scrollY = (now / 40) % 6;
    for (let i = 0; i < 3; i++) {
      const ly = py + 6 + i * 5 - scrollY;
      if (ly >= py + 4 && ly <= py + s - 7) {
        ctx.fillRect(px + 6, ly, s - 12, 1.5);
      }
    }
    ctx.restore();

    // Spawning sparks with random chance (Phase 8)
    if (Math.random() < 0.15) {
      this.spawnSpark(px + s / 2, py + s / 2, extColor);
    }
  }

  private drawTile(tile: LocalTile) {
    const { ctx } = this;
    const px = tile.x * TILE_SIZE;
    const py = tile.y * TILE_SIZE;
    const s = TILE_SIZE;

    // Floor and Wall base styling using cached CSS variables (Phase 4)
    if (tile.type === 'floor' || tile.type === 'door') {
      let fillColor = this.tokens.zinc800 || '#27272A';
      const delta = ((tile.x * 7 + tile.y * 3) % 7) - 3; // -3..+3
      fillColor = _adjustBrightness(fillColor, delta);

      ctx.fillStyle = fillColor;
      ctx.fillRect(px, py, s, s);

      // Steel grid lines
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.015)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);

      // Micro-remaches in corners
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.fillRect(px + 2, py + 2, 1, 1);
      ctx.fillRect(px + s - 3, py + 2, 1, 1);
      ctx.fillRect(px + 2, py + s - 3, 1, 1);
      ctx.fillRect(px + s - 3, py + s - 3, 1, 1);
    } else if (tile.type === 'path') {
      // Corridor floor: cleaner, with a guiding center line
      let fillColor = this.tokens.zinc800 || '#27272A';
      const delta = ((tile.x * 7 + tile.y * 3) % 7) - 3;
      fillColor = _adjustBrightness(fillColor, delta);

      ctx.fillStyle = fillColor;
      ctx.fillRect(px, py, s, s);

      // Metallic side edging
      ctx.fillStyle = 'rgba(82, 82, 91, 0.25)';
      ctx.fillRect(px + 1, py, 1, s);
      ctx.fillRect(px + s - 2, py, 1, s);

      // Center guide line (subtle amber)
      ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
      ctx.fillRect(px + s / 2 - 0.5, py + 2, 1, s - 4);

      // Steel grid lines (lighter than floor)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.025)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
    } else if (tile.type === 'wall') {
      this.drawWallFacade(tile, px, py, s);
    } else if (tile.type === 'debris') {
      // Base floor under debris
      const fillColor = this.tokens.base || '#0C0C0C';
      ctx.fillStyle = fillColor;
      ctx.fillRect(px, py, s, s);

      this.drawDebrisTile(px, py, s);

      // Grid line
      ctx.strokeStyle = this.tokens.border || '#262626';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
    } else if (tile.type === 'kiosk') {
      // Base floor under kiosk
      ctx.fillStyle = this.tokens.zinc800 || '#27272A';
      ctx.fillRect(px, py, s, s);

      this.drawKioskTile(px, py, s);

      ctx.strokeStyle = this.tokens.border || '#262626';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
    } else if (tile.type === 'workbench') {
      // Base floor under workbench
      ctx.fillStyle = this.tokens.zinc800 || '#27272A';
      ctx.fillRect(px, py, s, s);

      this.drawWorkbenchTile(tile, px, py, s);

      ctx.strokeStyle = this.tokens.border || '#262626';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
    }
  }

  private drawWallFacade(tile: LocalTile, px: number, py: number, s: number) {
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

    // Roof line (simulated height)
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(px, py - 3, s, 3);

    // Solid carbon wall core
    ctx.fillStyle = this.tokens.zinc800 || '#27272A';
    ctx.fillRect(px, py, s, s);

    // Corner detection: open on two perpendicular cardinal sides
    const isCorner = (east && south) || (east && north) || (west && south) || (west && north);

    if (isCorner) {
      // Reinforced pillar
      ctx.fillStyle = '#1a1a1e';
      ctx.fillRect(px + 4, py + 4, s - 8, s - 8);
      // Corner accent lines
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 3.5, py + 3.5, s - 7, s - 7);
    } else {
      // Industrial window/panel on straight walls
      ctx.fillStyle = '#1c1c1f';
      ctx.fillRect(px + 6, py + 5, s - 12, s - 10);
      // Window frame
      ctx.strokeStyle = 'rgba(82, 82, 91, 0.5)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(px + 6.5, py + 5.5, s - 13, s - 11);
    }

    // Directional shadows from neighboring open tiles
    if (east) {
      const shadowGrad = ctx.createLinearGradient(px + s - 4, py, px + s, py);
      shadowGrad.addColorStop(0, 'rgba(0,0,0,0.35)');
      shadowGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = shadowGrad;
      ctx.fillRect(px + s - 4, py, 4, s);
    }
    if (south) {
      const shadowGrad = ctx.createLinearGradient(px, py + s - 4, px, py + s);
      shadowGrad.addColorStop(0, 'rgba(0,0,0,0.35)');
      shadowGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = shadowGrad;
      ctx.fillRect(px, py + s - 4, s, 4);
    }

    // Ambient occlusion shadow at bottom
    const grad = ctx.createLinearGradient(px, py + s - 4, px, py + s);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.5)');
    ctx.fillStyle = grad;
    ctx.fillRect(px, py + s - 4, s, 4);

    // Golden bevel top border
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, py + 0.5);
    ctx.lineTo(px + s, py + 0.5);
    ctx.stroke();

    // Steel border outline
    ctx.strokeStyle = this.tokens.border || '#262626';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
  }

  private drawDebrisTile(px: number, py: number, s: number) {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(px + 2, py + 2, s - 4, s - 4);

    // Crack lines using lt-error alpha 0.18 (Phase 4)
    const hash = (px * 17 + py * 13) % 4;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.18)'; // error color
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (hash === 0) {
      ctx.moveTo(px + 4, py + 4);
      ctx.lineTo(px + s - 4, py + s - 4);
    } else if (hash === 1) {
      ctx.moveTo(px + s - 4, py + 4);
      ctx.lineTo(px + 4, py + s - 4);
    } else {
      ctx.moveTo(px + 3, py + s * 0.4);
      ctx.lineTo(px + s * 0.5, py + 3);
      ctx.moveTo(px + s - 3, py + s * 0.6);
      ctx.lineTo(px + s * 0.5, py + s - 3);
    }
    ctx.stroke();
  }

  private drawKioskTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // CRT terminal kiosk in zinc style (Phase 4)
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(px + 2, py + 2, s - 4, s - 4);

    // Terminal Screen
    ctx.fillStyle = '#1c1c1f';
    ctx.fillRect(px + 4, py + 4, s - 8, s - 8);

    // Glowing screen indicator
    ctx.fillStyle = 'rgba(245, 158, 11, 0.7)'; // amber-500
    ctx.fillRect(px + 6, py + 6, s - 12, s - 12);
  }

  private drawWorkbenchTile(tile: LocalTile, px: number, py: number, s: number) {
    const { ctx } = this;
    const wb = tile.workbench;
    if (!wb) return;

    // Desk body in zinc grays (Phase 6 / gstack style)
    ctx.fillStyle = this.tokens.zinc600 || '#52525B';
    ctx.fillRect(px + 2, py + 4, s - 4, s - 10); // desk top / body
    ctx.fillStyle = this.tokens.border || '#262626';
    ctx.fillRect(px + 4, py + s - 6, s - 8, 2); // drawer line
    ctx.fillRect(px + 4, py + s - 9, s - 8, 1); // second drawer

    // File extension label centered, larger, with monospaced font
    const extColor = EXT_COLOR[wb.extension] ?? '#888';
    ctx.fillStyle = extColor;
    ctx.font = `bold ${Math.max(7, s * 0.32)}px ${this.tokens.fontMono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(wb.extension.slice(0, 3), px + s / 2, py + s / 2 - 1);

    // Test badge in amber-500 (Phase 6 / gstack style)
    if (wb.isTest) {
      ctx.fillStyle = this.tokens.amber500 || '#F59E0B';
      ctx.beginPath();
      ctx.arc(px + s - 4, py + 4, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawRoomLabel(room: LocalRoom) {
    const { ctx } = this;
    const px = room.x * TILE_SIZE;
    const py = room.y * TILE_SIZE;
    const pw = room.width * TILE_SIZE;

    const label = room.folderName.toUpperCase();
    ctx.save();

    // Label background in gstack style (Phase 7)
    ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
    ctx.fillRect(px + 2, py + 2, Math.min(pw - 4, 80), 14);

    // Border outline
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)'; // Amber alpha 0.35
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px + 2, py + 2, Math.min(pw - 4, 80), 14);

    ctx.font = `10px ${this.tokens.fontMono}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = this.tokens.amber400 || '#FBBF24';
    ctx.fillText(label, px + 4, py + 4);
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

    // Selection ring in gstack amber
    ctx.strokeStyle = this.tokens.amber500 || '#F59E0B';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, TILE_SIZE * 0.4, 0, Math.PI * 2);
    ctx.stroke();

    // Squash & Stretch applied along the directional movement vector
    ctx.save();
    ctx.rotate(dirAngle);
    ctx.scale(Sf, Sc);

    // Elliptical dynamic shadow
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(0, TILE_SIZE * 0.38, TILE_SIZE * 0.22, TILE_SIZE * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();

    // Unit Body (Sleek graphite dome)
    ctx.beginPath();
    ctx.arc(0, 0, TILE_SIZE * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = '#1c1c1f';
    ctx.fill();
    ctx.strokeStyle = unit.color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Visual direction visors / dual LED sensors parpeding (Phase 7)
    const now = performance.now();
    const isWorking = unit.state === 'working_on_file';
    const flash = isWorking && Math.sin(now / 180) > 0;
    if (isWorking) {
      ctx.fillStyle = flash ? '#22C55E' : 'rgba(34, 197, 94, 0.4)';
      ctx.beginPath();
      ctx.arc(TILE_SIZE * 0.22, -TILE_SIZE * 0.1, 1.5, 0, Math.PI * 2);
      ctx.arc(TILE_SIZE * 0.22, TILE_SIZE * 0.1, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore(); // restore Squash & Stretch

    // Initials centered in JetBrains Mono
    const initials = unit.name.slice(0, 2).toUpperCase();
    ctx.fillStyle = unit.color;
    ctx.font = `bold ${TILE_SIZE * 0.3}px ${this.tokens.fontMono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, 0, 0);

    // Dynamic work progress ring in gstack success color
    if (unit.state === 'working_on_file' && unit.workProgress > 0) {
      ctx.strokeStyle = this.tokens.success || '#22C55E';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(
        0,
        0,
        TILE_SIZE * 0.44,
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
    ctx.fillText(icon, 0, -TILE_SIZE * 0.35);

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
