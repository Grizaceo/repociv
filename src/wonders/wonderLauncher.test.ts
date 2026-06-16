import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureWondersUp,
  getWonderLaunchStatus,
  isAutoStartWondersEnabled,
  launchWonder,
  pollWonderUntilReady,
  setAutoStartWondersEnabled,
  stopWonder,
} from './wonderLauncher.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('wonderLauncher client (F3)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ─── launchWonder ──────────────────────────────────────────────────────

  it('launchWonder POSTs to /api/wonders/{id}/launch and returns the body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, id: 'institutum', status: 'starting', ready: false }),
    );
    const out = await launchWonder('institutum');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/bridge/api/wonders/institutum/launch');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(out.id).toBe('institutum');
    expect(out.status).toBe('starting');
  });

  it('launchWonder returns ok=false on HTTP 4xx with the code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, code: 'repo_not_found', error: 'wonder repo not found' }, 412),
    );
    const out = await launchWonder('institutum');
    expect(out.ok).toBe(false);
    expect(out.error).toBe('repo_not_found');
    // The body's code field is preferred over the synthetic http_* fallback.
    expect(out.code).toBe('repo_not_found');
  });

  it('launchWonder returns ok=false on network error without throwing', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const out = await launchWonder('institutum');
    expect(out.ok).toBe(false);
    expect(out.error).toBe('network');
    expect(out.error_message).toContain('Failed to fetch');
  });

  // ─── pollWonderUntilReady ──────────────────────────────────────────────

  it('pollWonderUntilReady returns immediately when first call is ready', async () => {
    fetchMock
      .mockResolvedValueOnce(  // launchWonder
        jsonResponse({ ok: true, id: 'institutum', status: 'ready', ready: true }),
      );
    // (no further polls expected)
    const out = await pollWonderUntilReady('institutum', {
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(out.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('pollWonderUntilReady polls until ready (starting → ready)', async () => {
    fetchMock
      .mockResolvedValueOnce(  // first launch
        jsonResponse({ ok: true, id: 'bibliotheca', status: 'starting', ready: false }),
      )
      .mockResolvedValueOnce(  // status poll 1
        jsonResponse({ ok: true, id: 'bibliotheca', status: 'starting', ready: false }),
      )
      .mockResolvedValueOnce(  // status poll 2
        jsonResponse({ ok: true, id: 'bibliotheca', status: 'ready', ready: true }),
      );
    const out = await pollWonderUntilReady('bibliotheca', {
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(out.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('pollWonderUntilReady does NOT cut on transient error (keeps polling)', async () => {
    // F3.1-B regression: the cold-start window for institutum can show
    // status='error' briefly (npm died, bridge not bound yet) before the
    // backend grace period settles. The poller must keep waiting
    // through that — only true 4xx rejections (unknown_wonder,
    // remote_rejected, repo_not_found) are terminal.
    fetchMock
      .mockResolvedValueOnce(  // first launch
        jsonResponse({ ok: true, id: 'institutum', status: 'starting', ready: false }),
      )
      .mockResolvedValueOnce(  // status poll → error (transient)
        jsonResponse({ ok: true, id: 'institutum', status: 'error', ready: false }),
      )
      .mockResolvedValueOnce(  // status poll → ready (eventually)
        jsonResponse({ ok: true, id: 'institutum', status: 'ready', ready: true }),
      );
    const out = await pollWonderUntilReady('institutum', {
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(out.status).toBe('ready');
    // Did NOT stop on the transient error — kept polling until ready.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('pollWonderUntilReady does NOT return on degraded (waits for ready)', async () => {
    // F3.1-B regression: a degraded status (api up, ui cold-compiling)
    // is not enough — the vignette mounts the iframe and the partial
    // render is jarring. Keep polling.
    fetchMock
      .mockResolvedValueOnce(  // first launch
        jsonResponse({ ok: true, id: 'institutum', status: 'starting', ready: false }),
      )
      .mockResolvedValueOnce(  // status poll → degraded
        jsonResponse({ ok: true, id: 'institutum', status: 'degraded', ready: false }),
      )
      .mockResolvedValueOnce(  // status poll → ready
        jsonResponse({ ok: true, id: 'institutum', status: 'ready', ready: true }),
      );
    const out = await pollWonderUntilReady('institutum', {
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(out.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('pollWonderUntilReady calls onUpdate at each step', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, id: 'institutum', status: 'starting', ready: false }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, id: 'institutum', status: 'ready', ready: true }),
      );
    const updates: string[] = [];
    await pollWonderUntilReady('institutum', {
      intervalMs: 1,
      timeoutMs: 5_000,
      onUpdate: (s) => updates.push(s.status),
    });
    expect(updates).toEqual(['starting', 'ready']);
  });

  it('pollWonderUntilReady returns early on unknown_wonder (404)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: false, code: 'unknown_wonder', error: 'unknown' }, 404),
    );
    const out = await pollWonderUntilReady('nonexistent', {
      intervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(out.error).toBe('unknown_wonder');
    expect(fetchMock).toHaveBeenCalledOnce(); // no further polls
  });

  // ─── ensureWondersUp ──────────────────────────────────────────────────

  it('ensureWondersUp fires launch for each id, no await', async () => {
    // Each poll returns ready on the first launch → no further polls.
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, status: 'ready', ready: true }),
    );
    ensureWondersUp(['bibliotheca', 'institutum'], { intervalMs: 1, timeoutMs: 1_000 });
    // give the microtask queue a chance to flush
    await new Promise((r) => setTimeout(r, 50));
    // We expect at least one fetch per id (the first launch).
    const calls = fetchMock.mock.calls as Array<[unknown, RequestInit?]>;
    const urls = calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/api/wonders/bibliotheca/launch'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/wonders/institutum/launch'))).toBe(true);
  });

  it('ensureWondersUp swallows errors (logs to console.warn, no throw)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('boom'));
    // Must not throw synchronously and must not surface an unhandled
    // rejection that escapes the .catch() in ensureWondersUp.
    expect(() =>
      ensureWondersUp(['institutum'], { intervalMs: 1, timeoutMs: 100 }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 150));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // ─── getWonderLaunchStatus / stopWonder ────────────────────────────────

  it('getWonderLaunchStatus GETs the status endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ok: true, id: 'institutum', status: 'ready', ready: true }),
    );
    const out = await getWonderLaunchStatus('institutum');
    const firstCall = fetchMock.mock.calls[0]!;
    expect(firstCall[0]).toBe('/bridge/api/wonders/institutum/launch-status');
    expect(out.status).toBe('ready');
  });

  it('stopWonder POSTs to /stop', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, id: 'institutum' }));
    const out = await stopWonder('institutum');
    const firstCall = fetchMock.mock.calls[0]!;
    expect(firstCall[0]).toBe('/bridge/api/wonders/institutum/stop');
    expect((firstCall[1] as RequestInit).method).toBe('POST');
    expect(out.ok).toBe(true);
  });

  // ─── localStorage helpers ──────────────────────────────────────────────

  describe('autoStartWonders localStorage flag', () => {
    let store: Record<string, string>;

    beforeEach(() => {
      store = {};
      const ls = {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
          store[k] = String(v);
        },
        removeItem: (k: string) => {
          delete store[k];
        },
        clear: () => {
          for (const k of Object.keys(store)) delete store[k];
        },
        key: (i: number) => (Object.keys(store) as string[])[i] ?? null,
        length: 0,
      };
      vi.stubGlobal('localStorage', ls);
    });

    it('defaults to ON (no key set)', () => {
      expect(isAutoStartWondersEnabled()).toBe(true);
    });

    it('setAutoStartWondersEnabled(false) → reads false', () => {
      setAutoStartWondersEnabled(false);
      expect(isAutoStartWondersEnabled()).toBe(false);
    });

    it('setAutoStartWondersEnabled(true) → reads true even if key is "false"', () => {
      setAutoStartWondersEnabled(false);
      setAutoStartWondersEnabled(true);
      expect(isAutoStartWondersEnabled()).toBe(true);
    });

    it('only the literal string "false" disables', () => {
      vi.stubGlobal('localStorage', {
        ...store,
        getItem: (k: string) => (k === 'repociv:auto-start-wonders' ? 'FALSE' : null),
        setItem: store['setItem'],
      });
      expect(isAutoStartWondersEnabled()).toBe(true);
    });
  });
});
