// ─── Access gate + CSP for the RepoCiv UI server (dev and preview) ──────────
// The UI server is also the only door to the bridge from a browser: /bridge
// and /repociv-ws are proxied, and the proxy (not the bundle) attaches the
// bridge token. Whoever reaches this server can therefore drive agents, so:
//
//  * Loopback requests (Host localhost/127.0.0.1/[::1], no Tailscale identity)
//    are the local operator — same trust as any local process, as before.
//  * Requests that arrive through Tailscale Serve carry `Tailscale-User-Login`
//    (Serve strips client-supplied copies, so it cannot be spoofed through the
//    tailnet). When REPOCIV_TAILNET_USERS lists logins, only those users pass;
//    tagged devices and shared-in users without a listed login get 403.
//    Empty list = legacy behavior (allowedHosts is the only filter).
//  * Every response carries a Content-Security-Policy: an injected script
//    could otherwise call the token-bearing proxy freely.

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin, ProxyOptions } from 'vite';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function parseTailnetUsers(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOOPBACK.has((name ?? '').toLowerCase());
}

export interface AccessDecision {
  ok: boolean;
  reason?: string;
}

function header(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export function decideAccess(headers: IncomingHttpHeaders, allowed: string[]): AccessDecision {
  const login = header(headers, 'tailscale-user-login').trim().toLowerCase();
  const viaTailnet = Boolean(login) || !isLoopbackHost(header(headers, 'host'));
  if (!viaTailnet || allowed.length === 0) return { ok: true };
  if (login && allowed.includes(login)) return { ok: true };
  return {
    ok: false,
    reason: login
      ? 'tailnet user not listed in REPOCIV_TAILNET_USERS'
      : 'no Tailscale identity (tagged device or not via Tailscale Serve)',
  };
}

export function contentSecurityPolicy(extraConnect: string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Inline style attributes are pervasive (panels, xterm); scripts are not.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Direct local WS fallback (ws://localhost:5275) keeps working on this host;
    // blob: is required by Three.js GLTFLoader when decoding embedded GLB textures.
    ['connect-src', "'self'", 'blob:', 'ws://localhost:*', 'ws://127.0.0.1:*', ...extraConnect].join(
      ' ',
    ),
    // Wonders are user-configured iframes (any http/https origin).
    "frame-src 'self' http: https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** Proxy `configure` hook: refuse WebSocket upgrades the gate would refuse. */
export function guardProxyUpgrades(allowed: string[]): ProxyOptions['configure'] {
  return (proxy) => {
    proxy.on('proxyReqWs', (proxyReq, req, socket) => {
      if (decideAccess(req.headers, allowed).ok) return;
      proxyReq.destroy();
      socket.destroy();
    });
  };
}

export function accessGatePlugin(allowed: string[], extraConnect: string[] = []): Plugin {
  const csp = contentSecurityPolicy(extraConnect);
  const middleware: Connect.NextHandleFunction = (
    req: IncomingMessage,
    res: ServerResponse,
    next: Connect.NextFunction,
  ) => {
    const decision = decideAccess(req.headers, allowed);
    if (!decision.ok) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'forbidden', reason: decision.reason }));
      return;
    }
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  };
  return {
    name: 'repociv-access-gate',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
