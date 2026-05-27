import { afterEach, describe, expect, it, vi } from 'vitest';

describe('wonderEnv LGB UI fallbacks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses localhost fallback when primary UI URL is down', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:5173')) {
        return { ok: true, status: 200 } as Response;
      }
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { findReachableLgbUiUrl } = await import('./wonderEnv.ts');
    const reachable = await findReachableLgbUiUrl();

    expect(reachable).toBe('http://127.0.0.1:5173');
  });

  it('returns null when no UI probe URL is reachable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { findReachableLgbUiUrl, checkLgbUi } = await import('./wonderEnv.ts');
    const reachable = await findReachableLgbUiUrl();
    const uiUp = await checkLgbUi();

    expect(reachable).toBeNull();
    expect(uiUp).toBe(false);
  });
});
