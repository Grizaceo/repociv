// ─── Input handling — mouse, drag-assign, zone paint, keyboard ─────────────
import type { LocalWorld, LocalUnit, LocalTile, ZoneType } from '../types.ts';
import type { CameraState } from './state.ts';

export interface InputState {
  isDragging: boolean;
  dragStart: { x: number; y: number };
  camStart: { x: number; y: number };
  inputActive: boolean;
  zonePaintMode: ZoneType | null;
  zonePaintStart: { x: number; y: number } | null;
  zonePaintCurrent: { x: number; y: number } | null;
  dragAssignState: 'idle' | 'dragging';
  dragAssignUnit: LocalUnit | null;
  dragAssignMouseX: number;
  dragAssignMouseY: number;
  hoveredUnit: LocalUnit | null;
  hoveredTile: { x: number; y: number } | null;
  cam: CameraState;
}

export function createInputState(cam: CameraState): InputState {
  return {
    isDragging: false,
    dragStart: { x: 0, y: 0 },
    camStart: { x: 0, y: 0 },
    inputActive: true,
    zonePaintMode: null,
    zonePaintStart: null,
    zonePaintCurrent: null,
    dragAssignState: 'idle',
    dragAssignUnit: null,
    dragAssignMouseX: 0,
    dragAssignMouseY: 0,
    hoveredUnit: null,
    hoveredTile: null,
    cam,
  };
}

export function wasDrag(e: { clientX: number; clientY: number }, input: InputState): boolean {
  return Math.abs(e.clientX - input.dragStart.x) > 4 || Math.abs(e.clientY - input.dragStart.y) > 4;
}

export function setInputActive(input: InputState, active: boolean): void {
  input.inputActive = active;
  if (!active) {
    input.isDragging = false;
    input.zonePaintStart = null;
    input.zonePaintCurrent = null;
    input.hoveredUnit = null;
    input.hoveredTile = null;
  }
}

export function finalizeZonePaint(
  input: InputState,
  world: LocalWorld | null,
  onZonePainted: ((type: ZoneType, tiles: Array<{ x: number; y: number }>) => void) | null,
  getTile: (x: number, y: number) => LocalTile | null,
): void {
  if (!input.zonePaintMode || !input.zonePaintStart || !input.zonePaintCurrent || !world) return;

  const x0 = Math.min(input.zonePaintStart.x, input.zonePaintCurrent.x);
  const y0 = Math.min(input.zonePaintStart.y, input.zonePaintCurrent.y);
  const x1 = Math.max(input.zonePaintStart.x, input.zonePaintCurrent.x);
  const y1 = Math.max(input.zonePaintStart.y, input.zonePaintCurrent.y);

  const tiles: Array<{ x: number; y: number }> = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (getTile(x, y)) tiles.push({ x, y });
    }
  }
  if (tiles.length > 0) onZonePainted?.(input.zonePaintMode, tiles);
}

// Zone painting keyboard shortcuts
export function getZoneForShortcut(key: string): ZoneType | undefined {
  const zoneMap: Record<string, ZoneType> = {
    s: 'stockpile',
    g: 'growing',
    r: 'recreation',
    b: 'bedroom',
    d: 'dining',
    h: 'hospital',
  };
  return zoneMap[key.toLowerCase()];
}
