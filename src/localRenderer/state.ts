// ─── Shared types for LocalRenderer extracted modules ────────────────────────

export interface CameraState {
  x: number;
  y: number;
  cx: number;
  cy: number;
  zoom: number;
}

export interface CamAnim {
  targetX: number;
  targetY: number;
  startTime: number;
  duration: number;
  fromX: number;
  fromY: number;
}
