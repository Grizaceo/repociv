// ─── Transitions — entering/exiting, intro zoom ────────────────────────────

export interface TransitionState {
  state: 'entering' | 'active' | 'exiting' | null;
  startTime: number;
  enterDuration: number;
  exitDuration: number;
  introZoomActive: boolean;
  introZoomStart: number;
  introZoomDuration: number;
  introZoomFrom: number;
  introZoomTo: number;
}

export function createTransitionState(): TransitionState {
  return {
    state: null,
    startTime: 0,
    enterDuration: 400,
    exitDuration: 300,
    introZoomActive: false,
    introZoomStart: 0,
    introZoomDuration: 600,
    introZoomFrom: 0.8,
    introZoomTo: 1.0,
  };
}

export function startEnterTransition(
  ts: TransitionState,
  inputActive: { value: boolean },
  _camZoom: { value: number },
): void {
  inputActive.value = true;
  ts.state = 'entering';
  ts.startTime = performance.now();
  ts.introZoomActive = true;
  ts.introZoomStart = performance.now();
}

export function startExitTransition(ts: TransitionState, inputActive: { value: boolean }): void {
  inputActive.value = false;
  ts.state = 'exiting';
  ts.startTime = performance.now();
}

export function isTransitionComplete(ts: TransitionState): boolean {
  return ts.state === null || ts.state === 'active';
}

export function getTransitionAlpha(ts: TransitionState): number {
  if (!ts.state || ts.state === 'active') return 1;
  const elapsed = performance.now() - ts.startTime;
  if (ts.state === 'entering') {
    return Math.min(elapsed / ts.enterDuration, 1);
  } else if (ts.state === 'exiting') {
    return 1 - Math.min(elapsed / ts.exitDuration, 1);
  }
  return 1;
}

export function resetTransition(ts: TransitionState): void {
  ts.state = null;
}

/** Process intro zoom. Returns the zoom level to use, and whether it's still active. */
export function tickIntroZoom(ts: TransitionState, now: number): { zoom: number; active: boolean } {
  if (!ts.introZoomActive) return { zoom: 1, active: false };
  const t = Math.min(1, (now - ts.introZoomStart) / ts.introZoomDuration);
  const ease = 1 - Math.pow(1 - t, 3);
  const zoom = ts.introZoomFrom + (ts.introZoomTo - ts.introZoomFrom) * ease;
  const active = t < 1;
  if (!active) ts.introZoomActive = false;
  return { zoom, active };
}
