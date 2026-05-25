// ─── RepoCiv — Wonder env helpers ─────────────────────────────────────────────
// URLs for maravilla iframes (Bibliotheca / Institutum) and LGB backend health.

import type { WonderType } from './types.ts';

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
export const WONDER_INSTITUTUM_URL =
  import.meta.env.VITE_WONDER_INSTITUTUM_URL ?? 'http://localhost:5280';
export const LGB_BACKEND_URL =
  import.meta.env.VITE_LGB_BACKEND_URL ?? `http://${_lgbHost}:3001`;

export const WONDER_UI_URLS: Record<WonderType, string> = {
  bibliotheca: WONDER_BIBLIOTHECA_URL,
  institutum: WONDER_INSTITUTUM_URL,
};

export function wonderUiUrl(type: WonderType): string {
  return WONDER_UI_URLS[type];
}

export function lgbHealthUrl(base = LGB_BACKEND_URL): string {
  return `${base.replace(/\/$/, '')}/api/health`;
}

/** Bridge often binds 127.0.0.1 only; UI may be on Tailscale via Vite :5173. */
const LGB_BACKEND_FALLBACKS = [
  'http://127.0.0.1:3001',
  'http://localhost:3001',
] as const;

export function lgbBackendProbeUrls(): string[] {
  const primary = LGB_BACKEND_URL.replace(/\/$/, '');
  const urls = [primary];
  for (const fb of LGB_BACKEND_FALLBACKS) {
    if (!urls.includes(fb)) urls.push(fb);
  }
  return urls;
}

export type LgbReachability = { backend: boolean; ui: boolean };

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
  const base = WONDER_BIBLIOTHECA_URL.replace(/\/$/, '');
  if (await _probeReachable(`${base}/`)) return true;
  return _probeReachable(base);
}

export async function checkLgbReachability(): Promise<LgbReachability> {
  const [backend, ui] = await Promise.all([checkLgbBackend(), checkLgbUi()]);
  return { backend, ui };
}
