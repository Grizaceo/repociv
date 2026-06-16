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

describe('wonderEnv defaults — drift guards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('Institutum UI default points to Vite (5280), not bridge (5281)', async () => {
    // When VITE_WONDER_INSTITUTUM_URL is not set, the default must point to the Vite
    // UI (5280) — the bridge/API on 5281 serves JSON, not the SPA. See ROADMAP §169.
    if ((import.meta.env as Record<string, string | undefined>)['VITE_WONDER_INSTITUTUM_URL']) {
      // env override present — respect it, don't assert the default
      return;
    }
    const { WONDER_INSTITUTUM_URL, WONDER_INSTITUTUM_API_URL } = await import('./wonderEnv.ts');
    expect(WONDER_INSTITUTUM_URL).toMatch(/:5280\/?$/);
    expect(WONDER_INSTITUTUM_API_URL).toMatch(/:5281\/?$/);
    expect(WONDER_INSTITUTUM_URL).not.toBe(WONDER_INSTITUTUM_API_URL);
  });
});

describe('wonderEnv Institutum (LabHub) reachability probes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('findReachableInstitutumUiUrl returns the Vite UI when reachable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:5280')) {
        return { ok: true, status: 200 } as Response;
      }
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { findReachableInstitutumUiUrl } = await import('./wonderEnv.ts');
    const reachable = await findReachableInstitutumUiUrl();

    expect(reachable).toBe('http://127.0.0.1:5280');
  });

  it('findReachableInstitutumUiUrl returns null when no probe is reachable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { findReachableInstitutumUiUrl, checkInstitutumUi } = await import('./wonderEnv.ts');
    const reachable = await findReachableInstitutumUiUrl();
    const uiUp = await checkInstitutumUi();

    expect(reachable).toBeNull();
    expect(uiUp).toBe(false);
  });

  it('checkInstitutumBackend probes /health on the API (5281)', async () => {
    let healthUrl = '';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      healthUrl = String(input);
      return { ok: true, status: 200 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const { checkInstitutumBackend } = await import('./wonderEnv.ts');
    const ok = await checkInstitutumBackend();

    expect(ok).toBe(true);
    expect(healthUrl).toMatch(/:5281\/health$/);
  });

  it('checkInstitutumReachability reports both backend and UI', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // Backend (/health) and UI (GET /) both respond
      if (url.includes(':5281/health') || url.startsWith('http://127.0.0.1:5280')) {
        return { ok: true, status: 200 } as Response;
      }
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchMock);

    const { checkInstitutumReachability } = await import('./wonderEnv.ts');
    const r = await checkInstitutumReachability();

    expect(r.backend).toBe(true);
    expect(r.ui).toBe(true);
  });
});
