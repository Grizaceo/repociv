// ─── Unit rendering, movement, animations ──────────────────────────────────
import type { LocalUnit, LocalTile, LocalWorld } from '../types.ts';
import { EXT_COLOR } from '../local2dAssets.ts';
import { worldToScreen } from '../hex.ts';
import { computeUnitDirAngle, isUnitMoving } from '../isoLocalRenderer.ts';
import type { CameraState } from './state.ts';

const TILE_SIZE = 32;

// ─── Hit-testing ───────────────────────────────────────────────────────────

export function getUnitAt(
  cam: CameraState,
  isometric: boolean,
  _localUnitsToScan: LocalUnit[],
  world: LocalWorld | null,
  screenX: number,
  screenY: number,
  isoProject: (x: number, y: number) => { px: number; py: number },
  screenToWorld: (cam: CameraState, sx: number, sy: number) => { wx: number; wy: number },
): LocalUnit | null {
  if (!world || _localUnitsToScan.length === 0) return null;
  const { wx, wy } = screenToWorld(cam, screenX, screenY);

  if (isometric) {
    const threshold = 48 * 0.3;
    for (const unit of _localUnitsToScan) {
      const [gx, gy] = getUnitGridPos(unit);
      const up = isoProject(gx, gy);
      if (Math.hypot(wx - up.px, wy - up.py) < threshold) return unit;
    }
    return null;
  }

  const threshold = TILE_SIZE * 0.45;
  for (const unit of _localUnitsToScan) {
    const [gx, gy] = getUnitGridPos(unit);
    const ux = gx * TILE_SIZE + TILE_SIZE / 2;
    const uy = gy * TILE_SIZE + TILE_SIZE / 2;
    if (Math.hypot(wx - ux, wy - uy) < threshold) return unit;
  }
  return null;
}

export function getNpcAt(
  cam: CameraState,
  isometric: boolean,
  world: LocalWorld | null,
  screenX: number,
  screenY: number,
  isoProject: (x: number, y: number) => { px: number; py: number },
  screenToWorld: (cam: CameraState, sx: number, sy: number) => { wx: number; wy: number },
): import('../types.ts').LocalNpc | null {
  if (!world || !world.npcs || world.npcs.length === 0) return null;
  const { wx, wy } = screenToWorld(cam, screenX, screenY);

  if (isometric) {
    const threshold = 48 * 0.18;
    for (const npc of world.npcs) {
      const np = isoProject(npc.gridX, npc.gridY);
      if (Math.hypot(wx - np.px, wy - np.py) < threshold) return npc;
    }
    return null;
  }

  const threshold = TILE_SIZE * 0.35;
  for (const npc of world.npcs) {
    const nx = npc.gridX * TILE_SIZE + TILE_SIZE / 2;
    const ny = npc.gridY * TILE_SIZE + TILE_SIZE / 2;
    if (Math.hypot(wx - nx, wy - ny) < threshold) return npc;
  }
  return null;
}

// ─── Unit drawing ──────────────────────────────────────────────────────────

export function getUnitGridPos(unit: LocalUnit): [number, number] {
  if (unit.path.length > 0 && unit.pathIndex < unit.path.length) {
    const from = unit.path[unit.pathIndex]!;
    const to = unit.path[Math.min(unit.pathIndex + 1, unit.path.length - 1)]!;
    const t = unit.pathProgress;
    return [from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t];
  }
  return [unit.gridX, unit.gridY];
}

export function drawLocalUnit(
  ctx: CanvasRenderingContext2D,
  cam: CameraState,
  unit: LocalUnit,
  hoveredUnitId: string | null,
  tokens: Record<string, string>,
  spawnZzzFn: (x: number, y: number) => void,
  onUnitRendered: ((unit: LocalUnit, sx: number, sy: number) => void) | null,
): void {
  const [gx, gy] = getUnitGridPos(unit);
  const ux = gx * TILE_SIZE + TILE_SIZE / 2;
  const uy = gy * TILE_SIZE + TILE_SIZE / 2;

  // Spawning Zzzs if unit is idle or resting
  if ((unit.state === 'idle_in_room' || unit.state === 'resting') && Math.random() < 0.02) {
    spawnZzzFn(ux, uy);
  }

  const moving = isUnitMoving(unit);
  const dirAngle = computeUnitDirAngle(unit);

  // Squash & Stretch
  const speed = moving ? 3.6 * unit.effectiveSpeed : 0;
  const Sf = 1 + Math.min(0.25, speed * 0.08);
  const Sc = 1 / Sf;

  // Per-step bounce
  const bobbingY = moving ? Math.sin(unit.pathProgress * Math.PI) * 2.5 : 0;

  // Idle breathing
  let breatheScale = 1;
  if (!moving && (unit.state === 'idle_in_room' || unit.state === 'resting')) {
    breatheScale = 1 + Math.sin((performance.now() / 1000) * Math.PI) * 0.02;
  }

  const fadeAlpha = unit.despawning ? Math.max(0, unit.fadeAlpha ?? 1) : 1;
  if (fadeAlpha <= 0) return;

  ctx.save();
  ctx.globalAlpha = fadeAlpha;
  ctx.translate(ux, uy + bobbingY);
  if (unit.ephemeral) ctx.scale(0.8, 0.8);
  ctx.scale(breatheScale, breatheScale);

  const isHovered = hoveredUnitId === unit.id;
  if (isHovered) {
    ctx.strokeStyle = '#A07840';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, TILE_SIZE * 0.55, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.save();
  ctx.rotate(dirAngle);
  ctx.scale(Sf, Sc);

  // Shadow
  ctx.fillStyle = 'rgba(180, 150, 130, 0.15)';
  ctx.beginPath();
  ctx.ellipse(-2, 1, TILE_SIZE * 0.28, TILE_SIZE * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();

  // Torso
  ctx.fillStyle = unit.color;
  ctx.strokeStyle = 'rgba(180, 150, 130, 0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(-2, 0, TILE_SIZE * 0.2, TILE_SIZE * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Tool belt
  ctx.fillStyle = '#2d2722';
  ctx.fillRect(-8, -4, 3, 8);

  // Head
  ctx.fillStyle = '#f5d6b8';
  ctx.beginPath();
  ctx.arc(4, 0, TILE_SIZE * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Helmet
  ctx.fillStyle = '#eab308';
  ctx.beginPath();
  ctx.arc(4, 0, TILE_SIZE * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = '#ca8a04';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(4, 0, TILE_SIZE * 0.16, -Math.PI / 3, Math.PI / 3);
  ctx.stroke();

  ctx.strokeStyle = '#fef08a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(1, 0);
  ctx.lineTo(8, 0);
  ctx.stroke();

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

  ctx.restore();

  // Initials capsule
  const initials = unit.name.slice(0, 2).toUpperCase();
  ctx.save();
  ctx.translate(0, TILE_SIZE * 0.52);
  ctx.font = `bold 8px ${tokens.fontMono ?? "'JetBrains Mono', monospace"}`;
  const textW = ctx.measureText(initials).width + 8;
  ctx.fillStyle = 'rgba(30, 30, 30, 0.85)';
  ctx.fillRect(-textW / 2, -6, textW, 12);
  ctx.strokeStyle = 'rgba(200, 200, 200, 0.2)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(-textW / 2, -6, textW, 12);
  ctx.fillStyle = unit.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials, 0, 0);
  ctx.restore();

  // Work progress ring
  if (unit.state === 'working_on_file' && unit.workProgress > 0) {
    ctx.strokeStyle = tokens.success || '#22C55E';
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

  // Status icon
  const statusIcon: Record<string, string> = {
    idle_in_room: '◌',
    walking_to_workbench: '→',
    walking_to_room: '→',
    working_on_file: '⚙',
    resting: '☾',
  };
  const icon = statusIcon[unit.state] ?? '?';
  ctx.fillStyle = unit.color;
  ctx.font = `${TILE_SIZE * 0.28}px ${tokens.fontMono ?? "'JetBrains Mono', monospace"}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(icon, 0, -TILE_SIZE * 0.42);

  ctx.restore();

  if (onUnitRendered) {
    const { sx, sy } = worldToScreen(cam, ux, uy + bobbingY);
    onUnitRendered(unit, sx, sy);
  }
}

// ─── Workbench Labels (2D) ─────────────────────────────────────────────────

export function drawWorkbenchLabels2D(
  ctx: CanvasRenderingContext2D,
  cam: CameraState,
  world: LocalWorld,
  view: { x0: number; y0: number; x1: number; y1: number },
  workbenchLabelOverlay: boolean,
  tokens: Record<string, string>,
): void {
  const labelAlpha = workbenchLabelOverlay ? 1 : Math.max(0, Math.min(1, (cam.zoom - 0.5) / 0.3));
  if (labelAlpha < 0.02) return;
  const fontMono = tokens.fontMono ?? "'JetBrains Mono', monospace";

  for (let y = view.y0; y <= view.y1; y++) {
    for (let x = view.x0; x <= view.x1; x++) {
      const tile = world.grid[y]![x]!;
      if (tile.type !== 'workbench' || !tile.workbench) continue;
      const room = tile.roomId ? world.rooms.find((r) => r.id === tile.roomId) : undefined;
      if (room && room.workbenches.length >= 3) continue;

      const px = x * TILE_SIZE;
      const py = y * TILE_SIZE;
      const s = TILE_SIZE;
      const name = tile.workbench.fileName;
      const short = name.length > 10 ? name.slice(0, 8) + '..' : name;

      ctx.save();
      ctx.globalAlpha = labelAlpha;
      const yOff = 14 + (cam.zoom > 1.2 ? 4 : 0);
      ctx.font = `bold 7px ${fontMono}`;
      const textW = ctx.measureText(short).width + 8;
      const labelW = Math.max(24, textW);
      const lx = px + s / 2 - labelW / 2;
      const ly = py - yOff;

      ctx.fillStyle = 'rgba(20, 20, 30, 0.85)';
      ctx.beginPath();
      ctx.roundRect(lx, ly, labelW, 10, 2);
      ctx.fill();

      const extCol = EXT_COLOR[tile.workbench.extension] ?? '#888';
      ctx.fillStyle = extCol;
      ctx.beginPath();
      ctx.arc(lx + 5, ly + 5, 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#E2E8F0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(short, px + s / 2 + 2, ly + 5);
      ctx.restore();
    }
  }
}

// ─── Workbench Tooltip ─────────────────────────────────────────────────────

export function drawWorkbenchTooltip2D(
  ctx: CanvasRenderingContext2D,
  cam: CameraState,
  canvas: HTMLCanvasElement,
  hoveredTile: { x: number; y: number } | null,
  world: LocalWorld | null,
  wb: NonNullable<LocalTile['workbench']>,
  tokens: Record<string, string>,
): void {
  if (!world || !hoveredTile) return;
  const px = hoveredTile.x * TILE_SIZE + TILE_SIZE / 2;
  const py = hoveredTile.y * TILE_SIZE;
  const { sx, sy } = worldToScreen(cam, px, py);
  const fontMono = tokens.fontMono ?? "'JetBrains Mono', monospace";

  const padX = 8,
    padY = 6,
    lineHeight = 11;
  const extCol = EXT_COLOR[wb.extension] ?? '#888';
  const fileName = wb.fileName;
  const testBadge = wb.isTest ? ' [TEST]' : '';
  const pathShort = wb.filePath.length > 40 ? '...' + wb.filePath.slice(-37) : wb.filePath;
  const titleLine = `${fileName}${testBadge}`;
  const extLine = `Type: ${wb.extension.toUpperCase()}`;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `bold 10px ${fontMono}`;
  const titleW = ctx.measureText(titleLine).width;
  ctx.font = `8px ${fontMono}`;
  const pathW = ctx.measureText(pathShort).width;
  const extW = ctx.measureText(extLine).width;
  const maxW = Math.max(titleW, pathW, extW);
  const tooltipW = maxW + padX * 2;
  const tooltipH = lineHeight * 3 + padY * 2;

  let tx = sx - tooltipW / 2;
  let ty = sy - tooltipH - 12;
  tx = Math.max(4, Math.min(tx, canvas.width - tooltipW - 4));
  if (ty < 4) ty = sy + 12;

  ctx.fillStyle = 'rgba(15, 15, 22, 0.95)';
  ctx.beginPath();
  ctx.roundRect(tx, ty, tooltipW, tooltipH, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(200, 200, 200, 0.2)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = extCol;
  ctx.beginPath();
  ctx.arc(tx + padX + 2, ty + padY + 6, 3, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = `bold 10px ${fontMono}`;
  ctx.fillStyle = '#F0F0F0';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(titleLine, tx + padX + 10, ty + padY + 6);

  ctx.font = `8px ${fontMono}`;
  ctx.fillStyle = '#A0A0A0';
  ctx.fillText(pathShort, tx + padX, ty + padY + 6 + lineHeight);
  ctx.fillStyle = extCol;
  ctx.fillText(extLine, tx + padX, ty + padY + 6 + lineHeight * 2);
  ctx.restore();
}

// ─── Drag-to-assign overlay ─────────────────────────────────────────────────

export function drawDragAssignOverlay(
  ctx: CanvasRenderingContext2D,
  cam: CameraState,
  unit: LocalUnit,
  mouseX: number,
  mouseY: number,
  world: LocalWorld | null,
  screenToTile: (sx: number, sy: number) => { x: number; y: number } | null,
  getTile: (x: number, y: number) => LocalTile | null,
): void {
  if (!world) return;
  const [gx, gy] = getUnitGridPos(unit);
  const ux = gx * TILE_SIZE + TILE_SIZE / 2;
  const uy = gy * TILE_SIZE + TILE_SIZE / 2;

  const { wx, wy } = hexScreenToWorld(cam, mouseX, mouseY);

  ctx.save();
  ctx.strokeStyle = unit.color;
  ctx.lineWidth = 2 / cam.zoom;
  ctx.setLineDash([6 / cam.zoom, 4 / cam.zoom]);
  ctx.beginPath();
  ctx.moveTo(ux, uy);
  ctx.lineTo(wx, wy);
  ctx.stroke();
  ctx.setLineDash([]);

  const hoverTile = screenToTile(mouseX, mouseY);
  if (hoverTile) {
    const tile = getTile(hoverTile.x, hoverTile.y);
    if (tile?.workbench) {
      const sx = hoverTile.x * TILE_SIZE;
      const sy = hoverTile.y * TILE_SIZE;
      ctx.strokeStyle = '#22C55E';
      ctx.lineWidth = 3 / cam.zoom;
      ctx.strokeRect(sx + 1, sy + 1, TILE_SIZE - 2, TILE_SIZE - 2);
      const pulse = 0.3 + 0.2 * Math.sin(performance.now() / 200);
      ctx.fillStyle = `rgba(34, 197, 94, ${pulse})`;
      ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
    }
  }
  ctx.restore();
}

// Helper for hex coordinate conversion in drag-assign
function hexScreenToWorld(cam: CameraState, sx: number, sy: number): { wx: number; wy: number } {
  return {
    wx: (sx - cam.cx) / cam.zoom + cam.x,
    wy: (sy - cam.cy) / cam.zoom + cam.y,
  };
}

// ─── Loading indicator ─────────────────────────────────────────────────────

export function drawLoadingIndicator(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  tokens: Record<string, string>,
): void {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const now = performance.now();
  const fontMono = tokens.fontMono ?? "'JetBrains Mono', monospace";

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = 'rgba(255, 248, 243, 0.6)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const radius = 24;
  const angle = now / 400;
  for (let i = 0; i < 8; i++) {
    const a = angle + (i / 8) * Math.PI * 2;
    const alpha = 0.3 + 0.7 * (i / 8);
    ctx.fillStyle = `rgba(160, 120, 64, ${alpha})`;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#5C4033';
  ctx.font = `bold 14px ${fontMono}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Generating office...', cx, cy + radius + 20);
  ctx.restore();
}
