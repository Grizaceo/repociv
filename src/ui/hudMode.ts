// ─── HUD density mode: Quick (default) vs Advanced ──────────────────────────
// Civ V-style progressive disclosure. In Quick mode the advanced toolbar
// buttons (data-hud-tier="advanced") are hidden so a first-time / casual user
// sees only the core controls; Advanced reveals everything. The choice
// persists. Hotkeys still reach the hidden panels — this only declutters the
// visible surface, it does not disable functionality.
//
// See docs/UX_IMPROVEMENT_PLAN.md (B1). The core/advanced split lives in
// index.html via the data-hud-tier attribute; this module just flips a body
// class and remembers the preference.

const KEY = 'repociv:hud-mode';
const BODY_CLASS = 'hud-advanced';

export type HudMode = 'quick' | 'advanced';

export function getHudMode(): HudMode {
  try {
    return localStorage.getItem(KEY) === 'advanced' ? 'advanced' : 'quick';
  } catch {
    return 'quick';
  }
}

function persist(mode: HudMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* storage full / unavailable — non-fatal, mode just won't persist */
  }
}

/** Reflect the mode onto <body> and the toggle button's pressed state. */
function apply(mode: HudMode): void {
  const advanced = mode === 'advanced';
  document.body.classList.toggle(BODY_CLASS, advanced);
  const btn = document.getElementById('btn-hud-mode');
  if (btn) {
    btn.setAttribute('aria-pressed', String(advanced));
    btn.classList.toggle('active', advanced);
    btn.title = advanced
      ? 'Ocultar controles avanzados (modo Quick)'
      : 'Mostrar controles avanzados';
  }
}

export function setHudMode(mode: HudMode): void {
  persist(mode);
  apply(mode);
}

export function toggleHudMode(): HudMode {
  const next: HudMode = getHudMode() === 'advanced' ? 'quick' : 'advanced';
  setHudMode(next);
  return next;
}

/** Wire the toggle button and apply the persisted mode. Idempotent-safe to
 *  call once during HUD bootstrap. */
export function initHudMode(): void {
  apply(getHudMode());
  document.getElementById('btn-hud-mode')?.addEventListener('click', () => {
    toggleHudMode();
  });
}
