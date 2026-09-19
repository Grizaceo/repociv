// ─── Same-origin proxy for iframe wonders ────────────────────────────────────
// An iframe wonder whose manifest points at http://127.0.0.1:<port> only works
// in a browser running on this host: from another machine (e.g. the notebook
// over Tailscale hitting http://<host>:5273) 127.0.0.1 is that machine. Listing
// the wonder in REPOCIV_WONDER_PROXIES serves it under
// /wonder-proxy/<id>/ on RepoCiv's own origin instead — HTTP and WebSocket —
// so the service itself stays bound to loopback.
//
//   REPOCIV_WONDER_PROXIES=ghostdesk=http://127.0.0.1:6080,other=http://localhost:9000
//
// Targets must be loopback: this is a tunnel to local services, not an open
// forward proxy. Invalid entries are skipped with a warning.

import type { ProxyOptions } from 'vite';

export const WONDER_PROXY_PREFIX = '/wonder-proxy';

const ID_RE = /^[a-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function tryUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function parseWonderProxies(
  raw: string | undefined,
  // eslint-disable-next-line no-console -- Vite config time: stderr is the log
  warn: (msg: string) => void = (msg) => console.warn(msg),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const id = eq > 0 ? trimmed.slice(0, eq).trim() : '';
    const target = eq > 0 ? trimmed.slice(eq + 1).trim() : '';
    const url = tryUrl(target);
    if (
      !ID_RE.test(id) ||
      !url ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !LOOPBACK_HOSTS.has(url.hostname) ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search ||
      url.username
    ) {
      warn(
        `[repociv] REPOCIV_WONDER_PROXIES: ignoring "${trimmed}" (want <id>=http://127.0.0.1:<port>)`,
      );
      continue;
    }
    out[id] = url.origin;
  }
  return out;
}

/** `/wonder-proxy/<id>/a?b` → `/a?b`; `/wonder-proxy/<id>?b` → `/?b`. */
export function stripWonderPrefix(path: string, id: string): string {
  const rest = path.slice(`${WONDER_PROXY_PREFIX}/${id}`.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/**
 * WebSocket upgrades must come from a page on this same origin. Services like
 * websockify do not check Origin, so without this any website open in the
 * viewer's browser could reach the proxied socket (cross-site WebSocket
 * hijacking). Browsers always send Origin on WS; its absence is refused too.
 */
export function isSameOriginUpgrade(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Vite `server.proxy` entries: `^/wonder-proxy/<id>(/|?|$)` → target, ws included. */
export function wonderProxyConfig(raw: string | undefined): Record<string, ProxyOptions> {
  const entries: Record<string, ProxyOptions> = {};
  for (const [id, target] of Object.entries(parseWonderProxies(raw))) {
    entries[`^${WONDER_PROXY_PREFIX}/${id}(/|\\?|$)`] = {
      target,
      changeOrigin: true,
      ws: true,
      secure: false,
      rewrite: (path) => stripWonderPrefix(path, id),
      configure: (proxy) => {
        proxy.on('proxyReqWs', (proxyReq, req, socket) => {
          if (isSameOriginUpgrade(req.headers.origin, req.headers.host)) return;
          proxyReq.destroy();
          socket.destroy();
        });
      },
    };
  }
  return entries;
}
