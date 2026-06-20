import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveInitialRenderMode, persistRenderMode } from './renderMode.ts';

// ─── 2D ↔ 3D render-mode parity (non-GPU) ─────────────────────────────────────
// The owner's official invariant is "switch between 2D (flat) and 3D (webgl)
// without problems." The headless e2e in e2e/render-mode-parity.spec.ts can't
// run here (no GPU → WebGL boot fails, job is continue-on-error in CI). But the
// part that actually governs switching — URL/localStorage resolution, the
// iso25d migration, and the session-only webgl rewrite — is pure logic. This
// suite locks that state machine so a regression is caught WITHOUT a GPU.

const STORAGE_KEY = 'repociv:renderer';

function makeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string): string | null => m.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      m.set(k, v);
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
    clear: (): void => m.clear(),
    /** test-only peek at the backing map */
    get: (k: string): string | undefined => m.get(k),
  };
}

function setup(search: string, storage: Record<string, string> = {}) {
  const store = makeStorage(storage);
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('window', { location: { search } });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveInitialRenderMode', () => {
  it('?renderer=webgl forces webgl (URL wins)', () => {
    setup('?renderer=webgl', { [STORAGE_KEY]: 'flat' });
    expect(resolveInitialRenderMode()).toBe('webgl');
  });

  it('?renderer=flat forces flat (URL overrides a persisted webgl)', () => {
    const store = setup('?renderer=flat', { [STORAGE_KEY]: 'webgl' });
    expect(resolveInitialRenderMode()).toBe('flat');
    // URL-path returns early, so storage is left untouched by the resolver.
    expect(store.get(STORAGE_KEY)).toBe('webgl');
  });

  it('persisted flat resolves to flat', () => {
    setup('', { [STORAGE_KEY]: 'flat' });
    expect(resolveInitialRenderMode()).toBe('flat');
  });

  it('persisted webgl is sticky: returns webgl and leaves storage untouched (B5)', () => {
    const store = setup('', { [STORAGE_KEY]: 'webgl' });
    expect(resolveInitialRenderMode()).toBe('webgl');
    expect(store.get(STORAGE_KEY)).toBe('webgl');
  });

  it('legacy iso25d migrates to webgl and is rewritten in storage', () => {
    const store = setup('', { [STORAGE_KEY]: 'iso25d' });
    expect(resolveInitialRenderMode()).toBe('webgl');
    expect(store.get(STORAGE_KEY)).toBe('webgl');
  });

  it('no URL and no storage defaults to webgl (3D first impression — B5)', () => {
    setup('');
    expect(resolveInitialRenderMode()).toBe('webgl');
  });

  it('unknown persisted value falls back to the webgl default (defensive)', () => {
    setup('', { [STORAGE_KEY]: 'totally-bogus' });
    expect(resolveInitialRenderMode()).toBe('webgl');
  });

  it('rejects an unknown ?renderer value and falls through to a persisted flat', () => {
    setup('?renderer=hologram', { [STORAGE_KEY]: 'flat' });
    expect(resolveInitialRenderMode()).toBe('flat');
  });
});

describe('persistRenderMode', () => {
  it('writes the chosen mode to the storage key', () => {
    const store = setup('');
    persistRenderMode('webgl');
    expect(store.get(STORAGE_KEY)).toBe('webgl');
    persistRenderMode('flat');
    expect(store.get(STORAGE_KEY)).toBe('flat');
  });
});
