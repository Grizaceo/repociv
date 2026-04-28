// ─── RepoCiv — Local Renderer (RimWorld-style 2D grid) ─────────────────────────
import type { LocalWorld, LocalTile, LocalRoom, LocalUnit, Workbench } from './types.ts';

const TILE_SIZE = 24; // px per tile

// ─── Tile colors (RimWorld-inspired dark palette) ─────────────────────────────
const TILE_COLOR: Record<string, string> = {
  floor:      '#2a2a35',
  wall:       '#0f0f18',
  door:       '#4a3a1a',
  workbench:  '#1a3040',
  debris:     '#1a1a1a',
};

const TILE_BORDER: Record<string, string> = {
  floor:      '#35354a',
  wall:       '#1a1a28',
  door:       '#8a6a2a',
  workbench:  '#2a5060',
  debris:     '#252525',
};

// ─── Main renderer class ───────────────────────────────────────────────────────
export class LocalRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private world: LocalWorld | null = null;

  // Camera
  private cam = { x: 0, y: 0, cx: 0, cy: 0, zoom: 1 };
  private isDragging = false;
  private dragStart  = { x: 0, y: 0 };
  private camStart   = { x: 0, y: 0 };

  // Interaction
  hoveredTile: { x: number; y: number } | null = null;
  onTileClick:  ((x: number, y: number, tile: LocalTile | null) => void) | null = null;
  onTileHover:  ((x: number, y: number, tile: LocalTile | null) => void) | null = null;
  onTileDblClick: ((x: number, y: number, tile: LocalTile | null) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  setWorld(world: LocalWorld) {
    this.world = world;
    // Center camera on the grid
    this.cam.x = world.width / 2;
    this.cam.y = world.height / 2;
  }

  private resize() {
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.cam.cx = this.canvas.width  / 2;
    this.cam.cy = this.canvas.height / 2;
  }

  // ─── Input ───────────────────────────────────────────────────────────────────
  setupInput() {
    const canvas = this.canvas;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.isDragging = true;
        this.dragStart  = { x: e.clientX, y: e.clientY };
        this.camStart   = { x: this.cam.x, y: this.cam.y };
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const wx = e.clientX - rect.left;
      const wy = e.clientY - rect.top;
      const tile = this.screenToTile(wx, wy);
      this.hoveredTile = tile;

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
        const tile = this.screenToTile(e.clientX - canvas.getBoundingClientRect().left,
                                       e.clientY - canvas.getBoundingClientRect().top);
        if (tile) this.onTileClick?.(tile.x, tile.y, this.getTile(tile.x, tile.y));
      }
      this.isDragging = false;
    });

    canvas.addEventListener('dblclick', (e) => {
      const rect = canvas.getBoundingClientRect();
      const tile = this.screenToTile(e.clientX - rect.left, e.clientY - rect.top);
      if (tile) this.onTileDblClick?.(tile.x, tile.y, this.getTile(tile.x, tile.y));
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.2, Math.min(4, this.cam.zoom * factor));
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const before = { x: (mx - this.cam.cx) / this.cam.zoom + this.cam.x,
                       y: (my - this.cam.cy) / this.cam.zoom + this.cam.y };
      this.cam.zoom = newZoom;
      const after = { x: (mx - this.cam.cx) / this.cam.zoom + this.cam.x,
                      y: (my - this.cam.cy) / this.cam.zoom + this.cam.y };
      this.cam.x += before.x - after.x;
      this.cam.y += before.y - after.y;
    }, { passive: false });

    window.addEventListener('resize', () => this.resize());
  }

  private wasDrag(e: MouseEvent): boolean {
    return Math.abs(e.clientX - this.dragStart.x) > 4 ||
           Math.abs(e.clientY - this.dragStart.y) > 4;
  }

  private screenToTile(sx: number, sy: number): { x: number; y: number } | null {
    const wx = (sx - this.cam.cx) / this.cam.zoom + this.cam.x;
    const wy = (sy - this.cam.cy) / this.cam.zoom + this.cam.y;
    const x = Math.floor(wx / TILE_SIZE);
    const y = Math.floor(wy / TILE_SIZE);
    return { x, y };
  }

  private worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx - this.cam.x) * this.cam.zoom + this.cam.cx,
      y: (wy - this.cam.y) * this.cam.zoom + this.cam.cy,
    };
  }

  private getTile(x: number, y: number): LocalTile | null {
    if (!this.world) return null;
    if (y < 0 || y >= this.world.height || x < 0 || x >= this.world.width) return null;
    return this.world.grid[y]![x] ?? null;
  }

  // ─── Render ───────────────────────────────────────────────────────────────────
  render(localUnits: LocalUnit[]) {
    const { ctx, canvas, cam, world } = this;
    if (!world) return;

    // Background
    ctx.fillStyle = '#0d0d14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(cam.cx, cam.cy);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    // Draw grid tiles (with depth sort by y)
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]![x]!;
        this.drawTile(tile);
      }
    }

    // Draw room labels
    for (const room of world.rooms) {
      this.drawRoomLabel(room);
    }

    // Draw local units
    for (const unit of localUnits) {
      this.drawLocalUnit(unit);
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
      canvas.width / 2, canvas.height / 2, 0,
      canvas.width / 2, canvas.height / 2, canvas.width,
    );
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  private drawTile(tile: LocalTile) {
    const { ctx } = this;
    const px = tile.x * TILE_SIZE;
    const py = tile.y * TILE_SIZE;
    const s  = TILE_SIZE;

    const fillColor   = TILE_COLOR[tile.type]   ?? TILE_COLOR.floor;
    const borderColor = TILE_BORDER[tile.type] ?? TILE_BORDER.floor;

    // Fill
    ctx.fillStyle = fillColor;
    ctx.fillRect(px, py, s, s);

    // Subtle texture based on type
    if (tile.type === 'workbench') {
      this.drawWorkbenchTile(tile, px, py, s);
    } else if (tile.type === 'wall') {
      ctx.fillStyle = '#00000022';
      ctx.fillRect(px + 2, py + 2, s - 4, s - 4);
    } else if (tile.type === 'debris') {
      this.drawDebrisTile(px, py, s);
    }

    // Grid lines
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 0.5;
    ctx.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1);
  }

  private drawDebrisTile(px: number, py: number, s: number) {
    const { ctx } = this;
    // Dark inner fill — already done by TILE_COLOR.debris, add debris texture
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(px + 3, py + 3, s - 6, s - 6);

    // Crack lines (two diagonal strokes)
    ctx.strokeStyle = 'rgba(80,60,30,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + 4, py + s * 0.5);
    ctx.lineTo(px + s * 0.5, py + 4);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(px + s - 4, py + s * 0.5);
    ctx.lineTo(px + s * 0.5, py + s - 4);
    ctx.stroke();
  }

  private drawWorkbenchTile(tile: LocalTile, px: number, py: number, s: number) {
    const { ctx } = this;
    const wb = tile.workbench;
    if (!wb) return;

    // Workbench icon: small "desk" shape
    ctx.fillStyle = '#2a6080';
    ctx.fillRect(px + 3, py + s - 8, s - 6, 5);       // desk top
    ctx.fillStyle = '#1a4055';
    ctx.fillRect(px + 5, py + s - 8, 2, 4);            // left leg
    ctx.fillRect(px + s - 7, py + s - 8, 2, 4);         // right leg

    // File type indicator (color dot)
    const extColor = EXT_COLOR[wb.extension] ?? '#888';
    ctx.fillStyle = extColor;
    ctx.beginPath();
    ctx.arc(px + s - 5, py + 5, 3, 0, Math.PI * 2);
    ctx.fill();

    // Test badge
    if (wb.isTest) {
      ctx.fillStyle = '#c8a84b';
      ctx.font = `bold ${s * 0.3}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('T', px + s / 2, py + 2);
    }
  }

  private drawRoomLabel(room: LocalRoom) {
    const { ctx } = this;
    const px = room.x * TILE_SIZE;
    const py = room.y * TILE_SIZE;
    const pw = room.width  * TILE_SIZE;
    const ph = room.height * TILE_SIZE;

    const label = room.folderName.toUpperCase();
    ctx.save();

    // Label background
    ctx.fillStyle = 'rgba(10,8,5,0.75)';
    ctx.fillRect(px + 2, py + 2, Math.min(pw - 4, 80), 14);

    ctx.font = `bold 9px 'Cinzel', serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#c8a84b';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 3;
    ctx.fillText(label, px + 4, py + 3);
    ctx.restore();
  }

  private drawLocalUnit(unit: LocalUnit) {
    const { ctx } = this;
    let ux: number, uy: number;

    if (unit.path.length > 0 && unit.pathIndex < unit.path.length) {
      const from = unit.path[unit.pathIndex]!;
      const to   = unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!;
      const t    = unit.pathProgress;
      ux = (from.x + (to.x - from.x) * t) * TILE_SIZE + TILE_SIZE / 2;
      uy = (from.y + (to.y - from.y) * t) * TILE_SIZE + TILE_SIZE / 2;
    } else {
      ux = unit.gridX * TILE_SIZE + TILE_SIZE / 2;
      uy = unit.gridY * TILE_SIZE + TILE_SIZE / 2;
    }

    const floatY = Math.sin(performance.now() / 300 + ux * 0.1) * 1.5;
    ctx.save();
    ctx.translate(ux, uy + floatY);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, TILE_SIZE * 0.35, TILE_SIZE * 0.2, TILE_SIZE * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();

    // Selection ring
    ctx.strokeStyle = '#f0c050';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, TILE_SIZE * 0.4, 0, Math.PI * 2);
    ctx.stroke();

    // Body
    ctx.beginPath();
    ctx.arc(0, 0, TILE_SIZE * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = '#1a1208';
    ctx.fill();
    ctx.strokeStyle = unit.color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Initials
    const initials = unit.name.slice(0, 2).toUpperCase();
    ctx.fillStyle = unit.color;
    ctx.font = `bold ${TILE_SIZE * 0.3}px 'Cinzel', serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, 0, 0);

    // Work progress ring
    if (unit.state === 'working_on_file' && unit.workProgress > 0) {
      ctx.strokeStyle = '#5b9b5b';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, TILE_SIZE * 0.44,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * unit.workProgress / 100);
      ctx.stroke();
    }

    // Status indicator
    const statusIcon: Record<string, string> = {
      idle_in_room:         '◌',
      walking_to_workbench:  '→',
      walking_to_room:      '→',
      working_on_file:      '⚙',
      resting:              '☾',
    };
    const icon = statusIcon[unit.state] ?? '?';
    ctx.fillStyle = unit.color;
    ctx.font = `${TILE_SIZE * 0.28}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(icon, 0, -TILE_SIZE * 0.35);

    ctx.restore();
  }

  // ─── Zoom controls ────────────────────────────────────────────────────────────
  getCamera() { return this.cam; }

  jumpToTile(tileX: number, tileY: number) {
    this.cam.x = tileX * TILE_SIZE + TILE_SIZE / 2;
    this.cam.y = tileY * TILE_SIZE + TILE_SIZE / 2;
  }
}

// ─── Extension → color map ────────────────────────────────────────────────────
const EXT_COLOR: Record<string, string> = {
  ts:    '#4a9bd4',
  tsx:   '#4a9bd4',
  js:    '#e8c44a',
  jsx:   '#e8c44a',
  py:    '#4ab4d4',
  rs:    '#b4a04a',
  go:    '#4ad4b4',
  json:  '#a04ab4',
  md:    '#b4a04a',
  css:   '#4ad44a',
  html:  '#d44a4a',
  yaml:  '#4a4ad4',
  yml:   '#4a4ad4',
  sh:    '#4ad4a0',
  bash:  '#4ad4a0',
  toml:  '#d4a04a',
  png:   '#888',
  svg:   '#888',
};
