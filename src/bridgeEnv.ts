// ─── RepoCiv — Bridge env helpers ─────────────────────────────────────────────
// Single source of truth for bridge URL and token headers in the frontend.
//
// In dev mode (Vite), all bridge calls go through Vite's proxy (/api/* → bridge)
// so the browser doesn't need to reach the bridge directly (fixes WSL/Windows
// localhost mismatch). In production, set VITE_BRIDGE_URL to the full URL.

const DEV_PROXY_PREFIX = '/bridge';

export const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? '';
export const BRIDGE_TOKEN = import.meta.env.VITE_BRIDGE_TOKEN ?? import.meta.env.VITE_REPOCIV_TOKEN ?? '';
// Hermes web server (for /model/switch and /model/providers)
export const HERMES_WEB_URL = import.meta.env.VITE_HERMES_WEB_URL ?? 'http://localhost:9119';

/** Map a logical bridge path to the actual URL.
 *  In dev: /pending → /api/pending (Vite proxy → bridge)
 *  In prod: /pending → http://host:5274/pending (direct)
 */
export function bridgeUrl(path = ''): string {
  if (BRIDGE_URL) return `${BRIDGE_URL}${path}`;
  return `${DEV_PROXY_PREFIX}${path}`;
}

export function hermesWebUrl(path = ''): string {
  return `${HERMES_WEB_URL}${path}`;
}

export function bridgeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return BRIDGE_TOKEN ? { ...extra, 'X-RepoCiv-Token': BRIDGE_TOKEN } : extra;
}
