// ─── World render mode: flat (2D hex) | webgl (3D) ──────────────────────────
//
// The intermediate "iso25d" (canvas 2D extruded) renderer was retired: it
// was a halfway house between the legacy flat view and the real WebGL
// view, and parity with WebGL was always going to be a maintenance
// trap. Users with `iso25d` persisted in localStorage are silently
// migrated to `webgl` (we don't drop them on the floor; we just give
// them the better view). WebGL itself is session-only (URL/hotkey
// activation) — we still rewrite storage so reloads land in `flat`.
export type WorldRenderMode = 'flat' | 'webgl';

const STORAGE_KEY = 'repociv:renderer';

export function resolveInitialRenderMode(): WorldRenderMode {
  const params = new URLSearchParams(window.location.search);
  const urlMode = params.get('renderer');
  if (urlMode === 'webgl' || urlMode === 'flat') {
    return urlMode;
  }
  // Defensive: reject unknown values persisted by older builds.
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'flat') return 'flat';
  if (stored === 'webgl') {
    // WebGL is session-only (hotkey 3 / URL); restoring from storage
    // caused blank maps in the past. Rewrite to flat so the next
    // reload is predictable.
    localStorage.setItem(STORAGE_KEY, 'flat');
    return 'webgl';
  }
  // Legacy 'iso25d' value from a previous install: upgrade in place
  // and surface the 3D view (better than the old canvas extrusion).
  if (stored === 'iso25d') {
    localStorage.setItem(STORAGE_KEY, 'webgl');
    return 'webgl';
  }
  return 'flat';
}

export function persistRenderMode(mode: WorldRenderMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
}

export async function loadThreeMapRenderer(): Promise<
  typeof import('./ThreeMapRenderer.ts').ThreeMapRenderer
> {
  const mod = await import('./ThreeMapRenderer.ts');
  return mod.ThreeMapRenderer;
}
