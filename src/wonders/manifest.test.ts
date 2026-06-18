// ─── RepoCiv — Wonder Manifest Registry Tests ─────────────────────────────────
//
// Tests for src/wonders/manifest.ts — the runtime registry layer.
//
// New model (2026-06-17): only the native gaceta is hardcoded. iframe wonders
// (bibliotheca, institutum, and user-connected services) are hydrated from the
// backend via loadWonders() (GET /api/wonders). So the synchronous registry is
// gaceta-only by default; loadWonders() merges whatever the bridge returns.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getWonderExample } from './exampleTemplates.ts';

// Reset module-level registry state between tests.
function resetRegistryImport() {
  vi.resetModules();
}

/** A fake /api/wonders payload: gaceta + the two examples + one custom. */
function fakeBackendManifests() {
  const biblio = getWonderExample('bibliotheca')!.manifest;
  const inst = getWonderExample('institutum')!.manifest;
  return [
    { ...biblio },
    { ...inst },
    {
      id: 'mi-servicio',
      title: 'Mi Servicio',
      kind: 'iframe',
      category: 'knowledge',
      version: '0.1.0',
      defaultEnabled: true,
      automationLevel: 'passive',
      passiveMode: true,
      agenticMode: false,
      canSuggest: false,
      canAct: false,
      requiresConfirmation: true,
      ui: { url: 'http://127.0.0.1:9998' },
      permissions: {
        readRepos: false,
        writeRepos: false,
        network: 'loopback-only',
        requiresApprovalForMutations: true,
      },
      optionalFeatures: [],
      actions: [{ id: 'open', label: 'Abrir', risk: 'safe', requiresUserOptIn: false }],
      events: { emits: ['wonder.ready'], accepts: [] },
      mcp: { enabled: false, server: null },
    },
  ];
}

describe('wonder manifest registry', () => {
  beforeEach(() => {
    resetRegistryImport();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('static (un-hydrated) registry', () => {
    it('lists only the native gaceta out of the box', async () => {
      const { listWonders } = await import('./manifest.ts');
      const ids = listWonders().map((w) => w.id);
      expect(ids).toEqual(['gaceta']);
    });

    it('getWonder returns the native gaceta', async () => {
      const { getWonder } = await import('./manifest.ts');
      const gaceta = getWonder('gaceta');
      expect(gaceta).toBeDefined();
      expect(gaceta!.kind).toBe('native');
      expect(gaceta!.category).toBe('news');
    });

    it('iframe wonders are absent until hydrated', async () => {
      const { getWonder } = await import('./manifest.ts');
      expect(getWonder('bibliotheca')).toBeUndefined();
      expect(getWonder('institutum')).toBeUndefined();
    });

    it('listIframeWonders is empty until hydrated', async () => {
      const { listIframeWonders } = await import('./manifest.ts');
      expect(listIframeWonders()).toEqual([]);
    });
  });

  describe('loadWonders (hydration from /api/wonders)', () => {
    it('merges the backend manifests into the registry', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => fakeBackendManifests() })),
      );
      const { loadWonders, getWonder, listIframeWonders } = await import('./manifest.ts');
      await loadWonders();
      expect(getWonder('bibliotheca')).toBeDefined();
      expect(getWonder('institutum')).toBeDefined();
      expect(getWonder('mi-servicio')).toBeDefined();
      const iframeIds = listIframeWonders().map((w) => w.id).sort();
      expect(iframeIds).toEqual(['bibliotheca', 'institutum', 'mi-servicio']);
    });

    it('always keeps native gaceta even if backend omits it', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => fakeBackendManifests() })),
      );
      const { loadWonders, getWonder } = await import('./manifest.ts');
      await loadWonders();
      expect(getWonder('gaceta')).toBeDefined();
    });

    it('falls back to the static gaceta when the bridge is unreachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('network down');
        }),
      );
      const { loadWonders, listWonders } = await import('./manifest.ts');
      await loadWonders();
      expect(listWonders().map((w) => w.id)).toEqual(['gaceta']);
    });

    it('invalidateWondersCache forces a refetch', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => fakeBackendManifests() }));
      vi.stubGlobal('fetch', fetchMock);
      const { loadWonders, invalidateWondersCache } = await import('./manifest.ts');
      await loadWonders();
      await loadWonders(); // cached → no second fetch
      expect(fetchMock).toHaveBeenCalledTimes(1);
      invalidateWondersCache();
      await loadWonders();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getWonder', () => {
    it('returns undefined for unknown id', async () => {
      const { getWonder } = await import('./manifest.ts');
      expect(getWonder('nonexistent')).toBeUndefined();
    });
  });

  describe('isWonderEnabled', () => {
    it('returns true for the native gaceta', async () => {
      const { isWonderEnabled } = await import('./manifest.ts');
      expect(isWonderEnabled('gaceta')).toBe(true);
    });

    it('returns false for unknown wonders', async () => {
      const { isWonderEnabled } = await import('./manifest.ts');
      expect(isWonderEnabled('nonexistent')).toBe(false);
    });
  });

  describe('getWonderActions', () => {
    it('returns actions for gaceta', async () => {
      const { getWonderActions } = await import('./manifest.ts');
      const actions = getWonderActions('gaceta');
      const ids = actions.map((a) => a.id);
      expect(ids).toContain('open');
      expect(ids).toContain('foreign_relations_report');
    });

    it('returns empty array for unknown wonder', async () => {
      const { getWonderActions } = await import('./manifest.ts');
      expect(getWonderActions('nonexistent')).toEqual([]);
    });
  });

  describe('getWonderOptionalFeatures', () => {
    it('returns optional features for gaceta', async () => {
      const { getWonderOptionalFeatures } = await import('./manifest.ts');
      const ids = getWonderOptionalFeatures('gaceta').map((f) => f.id);
      expect(ids).toContain('foreignRelationsReport');
      expect(ids).toContain('autoSummaries');
    });

    it('all optional features require opt-in by default', async () => {
      const { getWonderOptionalFeatures } = await import('./manifest.ts');
      for (const f of getWonderOptionalFeatures('gaceta')) {
        expect(f.requiresUserOptIn).toBe(true);
        expect(f.defaultEnabled).toBe(false);
      }
    });

    it('returns empty array for unknown wonder', async () => {
      const { getWonderOptionalFeatures } = await import('./manifest.ts');
      expect(getWonderOptionalFeatures('nonexistent')).toEqual([]);
    });
  });

  describe('isActionOptIn', () => {
    it('returns true for opt-in actions', async () => {
      const { isActionOptIn } = await import('./manifest.ts');
      expect(isActionOptIn('gaceta', 'foreign_relations_report')).toBe(true);
    });

    it('returns false for safe default-on actions', async () => {
      const { isActionOptIn } = await import('./manifest.ts');
      expect(isActionOptIn('gaceta', 'open')).toBe(false);
    });

    it('returns false for unknown action', async () => {
      const { isActionOptIn } = await import('./manifest.ts');
      expect(isActionOptIn('gaceta', 'nonexistent')).toBe(false);
    });

    it('returns false for unknown wonder', async () => {
      const { isActionOptIn } = await import('./manifest.ts');
      expect(isActionOptIn('nonexistent', 'open')).toBe(false);
    });
  });

  describe('capability flags (gaceta)', () => {
    it('gaceta starts fully passive — no agentic, no suggestions', async () => {
      const { getWonder } = await import('./manifest.ts');
      const gaceta = getWonder('gaceta')!;
      expect(gaceta.passiveMode).toBe(true);
      expect(gaceta.agenticMode).toBe(false);
      expect(gaceta.canSuggest).toBe(false);
      expect(gaceta.canAct).toBe(false);
      expect(gaceta.requiresConfirmation).toBe(false);
    });
  });

  describe('validation', () => {
    it('registry never crashes on access', async () => {
      const { listWonders, getWonder } = await import('./manifest.ts');
      expect(() => listWonders()).not.toThrow();
      expect(() => getWonder('gaceta')).not.toThrow();
    });
  });
});
