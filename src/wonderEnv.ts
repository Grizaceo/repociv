// ─── RepoCiv — Wonder env helpers ─────────────────────────────────────────────
// Low-level URL defaults and reachability probes for Wonder integrations.
// The registry/source-of-truth now lives in src/wonders/manifest.ts.

/** Match RepoCiv page host (localhost vs 127.0.0.1) so CORS + iframe stay consistent. */
function _defaultLgbHost(): string {
  if (typeof window !== 'undefined' && window.location.hostname) {
    return window.location.hostname;
  }
  return '127.0.0.1';
}

const _lgbHost = _defaultLgbHost();

export const WONDER_BIBLIOTHECA_URL =
  import.meta.env.VITE_WONDER_BIBLIOTHECA_URL ?? `http://${_lgbHost}:5173`;
/** Institutum (LabHub) UI — the Vite dev server. Bridge/API lives on :5281. */
export const WONDER_INSTITUTUM_URL =
  import.meta.env.VITE_WONDER_INSTITUTUM_URL ?? `http://${_lgbHost}:5280`;
/** Backend API port for Institutum/LabHub health checks and metrics. */
export const WONDER_INSTITUTUM_API_URL =
  import.meta.env.VITE_WONDER_INSTITUTUM_API_URL ?? `http://${_lgbHost}:5281`;
export const LGB_BACKEND_URL = import.meta.env.VITE_LGB_BACKEND_URL ?? `http://${_lgbHost}:3001`;

export function lgbHealthUrl(base = LGB_BACKEND_URL): string {
  return `${base.replace(/\/$/, '')}/api/health`;
}

/** Bridge often binds 127.0.0.1 only; UI may be on Tailscale via Vite :5173. */
const LGB_BACKEND_FALLBACKS = ['http://127.0.0.1:3001', 'http://localhost:3001'] as const;
const LGB_UI_FALLBACKS = [
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://localhost:3000',
] as const;
/** LabHub UI: Vite dev server. Bridge often binds 127.0.0.1 only; UI may be on Tailscale. */
const INSTITUTUM_UI_FALLBACKS = ['http://127.0.0.1:5280', 'http://localhost:5280'] as const;
const INSTITUTUM_API_FALLBACKS = ['http://127.0.0.1:5281', 'http://localhost:5281'] as const;

export function lgbBackendProbeUrls(): string[] {
  const primary = LGB_BACKEND_URL.replace(/\/$/, '');
  const urls = [primary];
  for (const fb of LGB_BACKEND_FALLBACKS) {
    if (!urls.includes(fb)) urls.push(fb);
  }
  return urls;
}

export function lgbUiProbeUrls(): string[] {
  const primary = WONDER_BIBLIOTHECA_URL.replace(/\/$/, '');
  const urls = [primary];
  for (const fb of LGB_UI_FALLBACKS) {
    if (!urls.includes(fb)) urls.push(fb);
  }
  return urls;
}

export function institutumApiProbeUrls(): string[] {
  const primary = WONDER_INSTITUTUM_API_URL.replace(/\/$/, '');
  const urls = [primary];
  for (const fb of INSTITUTUM_API_FALLBACKS) {
    if (!urls.includes(fb)) urls.push(fb);
  }
  return urls;
}

export function institutumUiProbeUrls(): string[] {
  const primary = WONDER_INSTITUTUM_URL.replace(/\/$/, '');
  const urls = [primary];
  for (const fb of INSTITUTUM_UI_FALLBACKS) {
    if (!urls.includes(fb)) urls.push(fb);
  }
  return urls;
}

export type LgbReachability = { backend: boolean; ui: boolean };
export type InstitutumReachability = { backend: boolean; ui: boolean };

const PROBE_MS = 4000;

async function _probe(url: string, mode: RequestMode = 'cors'): Promise<boolean> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), PROBE_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, mode });
    if (mode === 'no-cors') return true;
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(tid);
  }
}

/** When API/UI are on Tailscale IP but RepoCiv is on localhost, CORS may block cors probes. */
async function _probeReachable(url: string): Promise<boolean> {
  if (await _probe(url, 'cors')) return true;
  return _probe(url, 'no-cors');
}

export async function checkLgbBackend(): Promise<boolean> {
  for (const base of lgbBackendProbeUrls()) {
    if (await _probeReachable(lgbHealthUrl(base))) return true;
  }
  return false;
}

/** Vite dev UI (GET /). */
export async function checkLgbUi(): Promise<boolean> {
  return (await findReachableLgbUiUrl()) !== null;
}

export async function findReachableLgbUiUrl(): Promise<string | null> {
  for (const base of lgbUiProbeUrls()) {
    if (await _probeReachable(`${base}/`)) return base;
    if (await _probeReachable(base)) return base;
  }
  return null;
}

export async function checkLgbReachability(): Promise<LgbReachability> {
  const [backend, ui] = await Promise.all([checkLgbBackend(), checkLgbUi()]);
  return { backend, ui };
}

// ─── Institutum (LabHub) reachability probes ──────────────────────────────────

export function institutumHealthUrl(base: string = WONDER_INSTITUTUM_API_URL): string {
  return `${base.replace(/\/$/, '')}/health`;
}

export async function checkInstitutumBackend(): Promise<boolean> {
  for (const base of institutumApiProbeUrls()) {
    if (await _probeReachable(institutumHealthUrl(base))) return true;
  }
  return false;
}

/** Vite dev UI (GET /). */
export async function checkInstitutumUi(): Promise<boolean> {
  return (await findReachableInstitutumUiUrl()) !== null;
}

export async function findReachableInstitutumUiUrl(): Promise<string | null> {
  for (const base of institutumUiProbeUrls()) {
    if (await _probeReachable(`${base}/`)) return base;
    if (await _probeReachable(base)) return base;
  }
  return null;
}

export async function checkInstitutumReachability(): Promise<InstitutumReachability> {
  const [backend, ui] = await Promise.all([checkInstitutumBackend(), checkInstitutumUi()]);
  return { backend, ui };
}
