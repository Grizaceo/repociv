// ─── MCP connectivity poller (plan C2) ───────────────────────────────────────
// Polls the bridge /health endpoint for its `mcp` liveness block and drives the
// HUD indicator. Kept independent of BridgeEvents.checkHealth() because that
// path short-circuits the HTTP fetch while the WebSocket is connected — the MCP
// indicator must stay fresh regardless of transport, so it owns its own cadence.
import { bridgeUrl, bridgeHeaders } from '../bridgeEnv.ts';

const POLL_MS = 10_000;

interface HealthMcp {
  mcp?: { connected?: boolean; lastSeen?: number };
}

/**
 * MCP connectivity indicator (plan C2). "Connected" means the bridge saw a
 * request from the stdio MCP server within its liveness window — i.e. an
 * external client (Claude/Cursor/Codex) is currently driving RepoCiv through
 * the 43 MCP tools. Lives here (not hud.ts) so the poller stays free of hud.ts's
 * top-level `window` access and is testable in the node test environment.
 */
export function setMcpStatus(connected: boolean, lastSeen?: number): void {
  const el = document.getElementById('mcp-status');
  if (!el) return;
  el.classList.toggle('mcp-online', connected);
  el.classList.toggle('mcp-offline', !connected);
  el.textContent = connected ? 'MCP ●' : 'MCP ○';
  if (connected) {
    const ago =
      typeof lastSeen === 'number' && lastSeen > 0
        ? ` · actividad hace ${Math.max(0, Math.round(Date.now() / 1000 - lastSeen))}s`
        : '';
    el.title = `MCP conectado — un cliente externo (Claude/Cursor/Codex) opera RepoCiv vía las 43 tools del servidor MCP${ago}.\nRecetas: docs/MCP.md`;
  } else {
    el.title =
      'MCP inactivo — ningún cliente MCP en los últimos 60s.\nConéctate desde Claude/Cursor/Codex: ver docs/MCP.md';
  }
}

/** One poll cycle. `fetchImpl` is injectable for tests. */
export async function pollMcpStatusOnce(fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const res = await fetchImpl(bridgeUrl('/health'), { headers: bridgeHeaders() });
    if (!res.ok) {
      setMcpStatus(false);
      return;
    }
    const data = (await res.json()) as HealthMcp;
    setMcpStatus(Boolean(data.mcp?.connected), data.mcp?.lastSeen);
  } catch {
    setMcpStatus(false);
  }
}

let timer = 0;

export function startMcpStatusPolling(): void {
  if (timer) return;
  void pollMcpStatusOnce();
  timer = window.setInterval(() => void pollMcpStatusOnce(), POLL_MS);
}

export function stopMcpStatusPolling(): void {
  if (timer) {
    clearInterval(timer);
    timer = 0;
  }
}
