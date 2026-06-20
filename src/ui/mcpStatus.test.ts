import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pollMcpStatusOnce } from './mcpStatus.ts';

// No jsdom in this project — tests run in node and stub the DOM (see hudMode.test.ts).
function fakeEl() {
  const classes = new Set<string>(['mcp-offline']);
  return {
    textContent: 'MCP ○',
    title: '',
    classList: {
      toggle(name: string, on?: boolean) {
        const want = on ?? !classes.has(name);
        if (want) classes.add(name);
        else classes.delete(name);
      },
      contains: (n: string) => classes.has(n),
      add: (n: string) => classes.add(n),
    },
  };
}

function makeRes(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe('mcpStatus poller', () => {
  let el: ReturnType<typeof fakeEl>;
  beforeEach(() => {
    el = fakeEl();
    vi.stubGlobal('document', {
      getElementById: (id: string) => (id === 'mcp-status' ? el : null),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows connected when bridge reports mcp.connected', async () => {
    await pollMcpStatusOnce(async () => makeRes({ mcp: { connected: true, lastSeen: 123 } }));
    expect(el.classList.contains('mcp-online')).toBe(true);
    expect(el.classList.contains('mcp-offline')).toBe(false);
    expect(el.textContent).toBe('MCP ●');
  });

  it('shows disconnected when mcp.connected is false', async () => {
    el.classList.add('mcp-online');
    await pollMcpStatusOnce(async () => makeRes({ mcp: { connected: false, lastSeen: 0 } }));
    expect(el.classList.contains('mcp-offline')).toBe(true);
    expect(el.textContent).toBe('MCP ○');
  });

  it('treats a non-ok response as disconnected', async () => {
    el.classList.add('mcp-online');
    await pollMcpStatusOnce(async () => makeRes({}, false));
    expect(el.classList.contains('mcp-offline')).toBe(true);
  });

  it('treats a fetch rejection as disconnected (no throw)', async () => {
    el.classList.add('mcp-online');
    await expect(
      pollMcpStatusOnce(async () => {
        throw new Error('network down');
      }),
    ).resolves.toBeUndefined();
    expect(el.classList.contains('mcp-offline')).toBe(true);
  });

  it('treats a missing mcp block as disconnected', async () => {
    el.classList.add('mcp-online');
    await pollMcpStatusOnce(async () => makeRes({ ok: true }));
    expect(el.classList.contains('mcp-offline')).toBe(true);
  });
});
