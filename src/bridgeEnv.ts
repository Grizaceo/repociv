// ─── RepoCiv — Bridge env helpers ─────────────────────────────────────────────
// Single source of truth for bridge URL and token headers in the frontend.

export const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL ?? 'http://localhost:5274';
export const BRIDGE_TOKEN =
  import.meta.env.VITE_BRIDGE_TOKEN ?? import.meta.env.VITE_REPOCIV_TOKEN ?? '';

export function bridgeUrl(path = ''): string {
  return `${BRIDGE_URL}${path}`;
}

export function bridgeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return BRIDGE_TOKEN ? { ...extra, 'X-RepoCiv-Token': BRIDGE_TOKEN } : extra;
}
