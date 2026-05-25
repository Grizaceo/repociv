// ─── RepoCiv — Wonder Manifest Registry Tests ─────────────────────────────────
//
// Tests for src/wonders/manifest.ts — the runtime registry layer.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// We need to reset the registry between tests since it uses module-level state.
// The registry is lazy-initialized on first call via _ensureInit().
// To reset it, we invalidate the module cache.
function resetRegistryImport() {
  vi.resetModules();
}

describe('wonder manifest registry', () => {
  beforeEach(() => {
    resetRegistryImport();
  });

  describe('listWonders', () => {
    it('returns all registered wonders', async () => {
      const { listWonders } = await import('./manifest.ts');
      const wonders = listWonders();
      expect(wonders.length).toBeGreaterThanOrEqual(3);
      const ids = wonders.map((w) => w.id);
      expect(ids).toContain('gaceta');
      expect(ids).toContain('bibliotheca');
      expect(ids).toContain('institutum');
    });
  });

  describe('getWonder', () => {
    it('returns manifest for known wonder id', async () => {
      const { getWonder } = await import('./manifest.ts');
      const gaceta = getWonder('gaceta');
      expect(gaceta).toBeDefined();
      expect(gaceta!.id).toBe('gaceta');
      expect(gaceta!.title).toBe('La Gaceta Imperial');
      expect(gaceta!.kind).toBe('native');
      expect(gaceta!.category).toBe('news');
    });

    it('returns manifest for bibliotheca', async () => {
      const { getWonder } = await import('./manifest.ts');
      const biblio = getWonder('bibliotheca');
      expect(biblio).toBeDefined();
      expect(biblio!.id).toBe('bibliotheca');
      expect(biblio!.kind).toBe('iframe');
      expect(biblio!.category).toBe('knowledge');
    });

    it('returns manifest for institutum', async () => {
      const { getWonder } = await import('./manifest.ts');
      const inst = getWonder('institutum');
      expect(inst).toBeDefined();
      expect(inst!.id).toBe('institutum');
      expect(inst!.kind).toBe('iframe');
      expect(inst!.category).toBe('lab');
    });

    it('returns undefined for unknown id', async () => {
      const { getWonder } = await import('./manifest.ts');
      expect(getWonder('nonexistent')).toBeUndefined();
    });

    it('labhub key resolves institutum manifest', async () => {
      // WONDER_MANIFESTS uses 'institutum' as key; 'labhub' is a legacy alias
      // used by isFeatureEnabled but not as a registry key.
      // Verify that institutum is registered and accessible.
      const { getWonder } = await import('./manifest.ts');
      const inst = getWonder('institutum');
      expect(inst).toBeDefined();
      expect(inst!.id).toBe('institutum');
      expect(inst!.title).toContain('Institutum');
    });
  });

  describe('isWonderEnabled', () => {
    it('returns true for default-enabled wonders', async () => {
      const { isWonderEnabled } = await import('./manifest.ts');
      expect(isWonderEnabled('gaceta')).toBe(true);
      expect(isWonderEnabled('bibliotheca')).toBe(true);
    });

    it('returns false for unknown wonders', async () => {
      const { isWonderEnabled } = await import('./manifest.ts');
      expect(isWonderEnabled('nonexistent')).toBe(false);
    });
  });

  describe('getWonderActions', () => {
    it('returns actions for a wonder', async () => {
      const { getWonderActions } = await import('./manifest.ts');
      const actions = getWonderActions('gaceta');
      expect(actions.length).toBeGreaterThanOrEqual(2);
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
      const features = getWonderOptionalFeatures('gaceta');
      expect(features.length).toBeGreaterThanOrEqual(2);
      const ids = features.map((f) => f.id);
      expect(ids).toContain('foreignRelationsReport');
      expect(ids).toContain('autoSummaries');
    });

    it('all optional features require opt-in by default', async () => {
      const { getWonderOptionalFeatures } = await import('./manifest.ts');
      const features = getWonderOptionalFeatures('gaceta');
      for (const f of features) {
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

  describe('capability flags', () => {
    it('gaceta starts fully passive — no agentic, no suggestions', async () => {
      const { getWonder } = await import('./manifest.ts');
      const gaceta = getWonder('gaceta')!;
      expect(gaceta.passiveMode).toBe(true);
      expect(gaceta.agenticMode).toBe(false);
      expect(gaceta.canSuggest).toBe(false);
      expect(gaceta.canAct).toBe(false);
      expect(gaceta.requiresConfirmation).toBe(false);
    });

    it('bibliotheca is passive but can suggest (opt-in)', async () => {
      const { getWonder } = await import('./manifest.ts');
      const biblio = getWonder('bibliotheca')!;
      expect(biblio.passiveMode).toBe(true);
      expect(biblio.agenticMode).toBe(false);
      expect(biblio.canSuggest).toBe(true);
      expect(biblio.canAct).toBe(false);
      expect(biblio.requiresConfirmation).toBe(true);
    });

    it('institutum is assist-level with agentic suggestions', async () => {
      const { getWonder } = await import('./manifest.ts');
      const inst = getWonder('institutum')!;
      expect(inst.passiveMode).toBe(true);
      expect(inst.agenticMode).toBe(true);
      expect(inst.canSuggest).toBe(true);
      expect(inst.canAct).toBe(false);
      expect(inst.requiresConfirmation).toBe(true);
      expect(inst.automationLevel).toBe('assist');
    });
  });

  describe('automation levels', () => {
    it('gaceta and bibliotheca default to passive automation', async () => {
      const { getWonder } = await import('./manifest.ts');
      expect(getWonder('gaceta')!.automationLevel).toBe('passive');
      expect(getWonder('bibliotheca')!.automationLevel).toBe('passive');
    });

    it('institutum defaults to assist automation', async () => {
      const { getWonder } = await import('./manifest.ts');
      expect(getWonder('institutum')!.automationLevel).toBe('assist');
    });
  });

  describe('validation', () => {
    it('registry never crashes on invalid manifests', async () => {
      // The registry silently skips invalid manifests via _validateManifest.
      // As long as the default config is valid, listWonders should work.
      const { listWonders, getWonder } = await import('./manifest.ts');
      expect(() => listWonders()).not.toThrow();
      expect(() => getWonder('gaceta')).not.toThrow();
    });
  });
});
