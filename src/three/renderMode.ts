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
  // A persisted webgl choice is now sticky (plan B5): 3D is the default view, so
  // honouring an explicit 3D preference across reloads is consistent. (The old
  // session-only "rewrite to flat" made sense when flat was the default and
  // webgl was experimental; the runtime fallback in main.ts now covers the
  // GPU-less / blank-map case that motivated it.)
  if (stored === 'webgl') return 'webgl';
  // Legacy 'iso25d' value from a previous install: upgrade in place
  // and surface the 3D view (better than the old canvas extrusion).
  if (stored === 'iso25d') {
    localStorage.setItem(STORAGE_KEY, 'webgl');
    return 'webgl';
  }
  // Default (no URL, nothing persisted): 3D first impression (plan B5, owner
  // decision 2026-06-20). Sells the Civ V metaphor far better than flat 2D.
  // Safe on GPU-less machines — main.ts boots WebGL and, on context failure,
  // the renderer stays in `flat` and a toast explains the downgrade.
  return 'webgl';
}

export function persistRenderMode(mode: WorldRenderMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
}

// ─── Post-processing toggle (vignette + warm grade + bloom) ─────────────────
// Default ON — the graded warm look IS the Civ V read. URL param wins over
// the persisted choice so captures/debug can pin it per navigation.
const POSTFX_KEY = 'repociv:postfx';

export function resolveInitialPostFx(): boolean {
  const params = new URLSearchParams(window.location.search);
  const urlValue = params.get('postfx');
  if (urlValue === '0' || urlValue === 'off') return false;
  if (urlValue === '1' || urlValue === 'on') return true;
  return localStorage.getItem(POSTFX_KEY) !== '0';
}

export function persistPostFx(enabled: boolean): void {
  localStorage.setItem(POSTFX_KEY, enabled ? '1' : '0');
}

// ─── Local sector renderer choice (2D iso vs 3D scene) ──────────────────────
// The 2D isometric renderer owns the local sector. The 3D scene (LocalScene3D
// + LocalTile3D + LocalAgent3D) is a real but unfinished second implementation:
// it renders correctly now, but it has no zone colouring, its walls are opaque
// slabs that hide the interior, and the 2D renderer still paints an opaque
// background over it every frame. Until that layering contract is settled,
// shipping it as the default would be a regression over a view that already
// looks right.
//
// Opt in with ?local3d=1 (or repociv:local3d=1 in localStorage) to work on it.
const LOCAL3D_KEY = 'repociv:local3d';

export function resolveLocalScene3DEnabled(): boolean {
  const urlValue = new URLSearchParams(window.location.search).get('local3d');
  if (urlValue === '0' || urlValue === 'off') return false;
  if (urlValue === '1' || urlValue === 'on') return true;
  return localStorage.getItem(LOCAL3D_KEY) === '1';
}

export async function loadThreeMapRenderer(): Promise<
  typeof import('./ThreeMapRenderer.ts').ThreeMapRenderer
> {
  const mod = await import('./ThreeMapRenderer.ts');
  return mod.ThreeMapRenderer;
}

export async function loadLocalScene3D(): Promise<typeof import('./LocalScene3D.ts').LocalScene3D> {
  const mod = await import('./LocalScene3D.ts');
  return mod.LocalScene3D;
}
