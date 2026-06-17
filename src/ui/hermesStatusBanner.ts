// ─── RepoCiv — Hermes degraded-mode banner (Fase 1 / audit 1.1) ──────────────
// Persistent top strip shown when the bridge's /api/hermes/status returns
// available=false. Renders the affected features + activation steps so
// a self-hosting operator can see at a glance what's broken and how to
// fix it, without leaving the UI.
//
// Lifecycle:
//   mountHermesStatusBanner() → DOM appended to #app, internal poll loop
//   starts. Stays mounted across scene changes (only the welcome splash
//   is removed; this stays).
//
// Dismissal:
//   Per-session only (sessionStorage). Reloading the page brings the
//   banner back if Hermes is still down. Intentionally NOT persisted
//   to localStorage so a returning user sees the current state.

import {
  checkHermesStatus,
  formatActivationSteps,
  listAffectedFeatures,
  type HermesStatus,
} from '../hermesStatus.ts';

const BANNER_ID = 'hermes-degraded-banner';
const SESSION_DISMISS_KEY = 'repociv:hermes-banner-dismissed';
const POLL_MS = 30_000; // bridge cache is 30s; no point polling faster

let _pollHandle: number | null = null;

export function isHermesBannerDismissed(): boolean {
  try {
    return sessionStorage.getItem(SESSION_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function setHermesBannerDismissed(value: boolean): void {
  try {
    if (value) sessionStorage.setItem(SESSION_DISMISS_KEY, '1');
    else sessionStorage.removeItem(SESSION_DISMISS_KEY);
  } catch {
    // sessionStorage unavailable (private mode, etc.) — silently ignore
  }
}

/**
 * Build the banner DOM for a given status. Pure function — exposed for
 * tests so the layout/contents are easy to assert.
 *
 * Returns null when Hermes is up (caller deletes the banner) or when
 * the user has dismissed the banner for this session.
 */
export function buildHermesBannerHtml(status: HermesStatus): string | null {
  if (status.available) return null;
  if (isHermesBannerDismissed()) return null;

  const features = listAffectedFeatures();
  const steps = formatActivationSteps();
  const errorLine = status.error
    ? `<div class="hermes-banner-error">Error del probe: <code>${escapeHtml(status.error)}</code></div>`
    : '';
  const urlLine = status.url
    ? `<div class="hermes-banner-url">URL probada: <code>${escapeHtml(status.url)}</code></div>`
    : '';

  return `
    <div class="hermes-banner-header">
      <span class="hermes-banner-icon" aria-hidden="true">⚠️</span>
      <strong>Hermes no detectado — modo degradado</strong>
      <button class="hermes-banner-close" type="button" aria-label="Cerrar banner">×</button>
    </div>
    <div class="hermes-banner-body">
      <p>El bridge está corriendo pero Hermes (el harness de LLM) no responde. Las siguientes features quedan afectadas hasta que Hermes esté disponible:</p>
      <ul class="hermes-banner-features">
        ${features
          .map(
            (f) => `<li><strong>${escapeHtml(f.label)}</strong> — ${escapeHtml(f.impact)}</li>`,
          )
          .join('')}
      </ul>
      <details>
        <summary>Cómo activar Hermes</summary>
        <ol class="hermes-banner-steps">
          ${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
        </ol>
      </details>
      <div class="hermes-banner-meta">
        ${urlLine}
        ${errorLine}
      </div>
    </div>
    <div class="hermes-banner-footer">
      <button class="hermes-banner-refresh" type="button">Reintentar probe</button>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Mount the banner into the DOM and start the polling loop.
 * Idempotent: calling twice does nothing the second time.
 */
export async function mountHermesStatusBanner(): Promise<void> {
  if (document.getElementById(BANNER_ID)) return;
  // First paint
  const status = await checkHermesStatus();
  if (!status.available) {
    const html = buildHermesBannerHtml(status);
    if (html) {
      const el = renderBanner(html);
      document.getElementById('app')?.prepend(el);
    }
  }
  // Poll loop
  if (_pollHandle != null) return;
  _pollHandle = window.setInterval(async () => {
    try {
      const next = await checkHermesStatus();
      const existing = document.getElementById(BANNER_ID);
      if (next.available) {
        existing?.remove();
        return;
      }
      if (existing) {
        // Re-render in case error/url changed
        const html = buildHermesBannerHtml(next);
        if (html) {
          existing.innerHTML = html;
          wireBannerEvents(existing);
        } else {
          // Was dismissed this session
          existing.remove();
        }
      } else {
        const html = buildHermesBannerHtml(next);
        if (html) {
          const el = renderBanner(html);
          document.getElementById('app')?.prepend(el);
        }
      }
    } catch {
      // Network blip — leave the previous banner as-is
    }
  }, POLL_MS);
}

/** Stop the poll loop. Tests use this to clean up between cases. */
export function unmountHermesStatusBanner(): void {
  if (_pollHandle != null) {
    window.clearInterval(_pollHandle);
    _pollHandle = null;
  }
  document.getElementById(BANNER_ID)?.remove();
}

function renderBanner(html: string): HTMLElement {
  const el = document.createElement('div');
  el.id = BANNER_ID;
  el.className = 'hermes-degraded-banner';
  el.setAttribute('role', 'alert');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = html;
  wireBannerEvents(el);
  return el;
}

function wireBannerEvents(root: HTMLElement): void {
  root.querySelector('.hermes-banner-close')?.addEventListener('click', () => {
    setHermesBannerDismissed(true);
    root.remove();
  });
  root.querySelector('.hermes-banner-refresh')?.addEventListener('click', async () => {
    const status = await checkHermesStatus();
    if (status.available) {
      root.remove();
    } else {
      const html = buildHermesBannerHtml(status);
      if (html) {
        root.innerHTML = html;
        wireBannerEvents(root);
      }
    }
  });
}
