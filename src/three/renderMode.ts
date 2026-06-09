// ─── WebGL renderer activation (opt-in; iso25d remains default) ─────────────
export type WorldRenderMode = 'flat' | 'iso25d' | 'webgl';

const STORAGE_KEY = 'repociv:renderer';

export function resolveInitialRenderMode(): WorldRenderMode {
  const params = new URLSearchParams(window.location.search);
  const urlMode = params.get('renderer');
  if (urlMode === 'webgl' || urlMode === 'iso25d' || urlMode === 'flat') {
    return urlMode;
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  // WebGL is session-only (hotkey 3 / URL); restoring it from storage caused blank maps.
  if (stored === 'webgl') {
    localStorage.setItem(STORAGE_KEY, 'iso25d');
    return 'iso25d';
  }
  if (stored === 'iso25d' || stored === 'flat') {
    return stored;
  }
  return 'iso25d';
}

export function persistRenderMode(mode: WorldRenderMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
}

/** Cycle webgl → iso25d → flat → webgl (hotkey 3). */
export function cycleRenderMode(current: WorldRenderMode): WorldRenderMode {
  if (current === 'webgl') return 'iso25d';
  if (current === 'iso25d') return 'flat';
  return 'webgl';
}

export async function loadThreeMapRenderer(): Promise<
  typeof import('./ThreeMapRenderer.ts').ThreeMapRenderer
> {
  const mod = await import('./ThreeMapRenderer.ts');
  return mod.ThreeMapRenderer;
}
