// ─── RepoCiv — Wonder Config Tests ──────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  WONDER_DEFAULTS,
  WONDER_MANIFESTS,
  loadWonderConfig,
  isFeatureEnabled,
} from '../wonders/wonderConfig.ts';
import { WONDER_EXAMPLES, getWonderExample } from '../wonders/exampleTemplates.ts';

describe('wonder defaults', () => {
  describe('gaceta', () => {
    it('showNews defaults to true', () => {
      expect(WONDER_DEFAULTS.gaceta.showNews).toBe(true);
    });

    it('foreignRelationsReport defaults to false', () => {
      expect(WONDER_DEFAULTS.gaceta.foreignRelationsReport).toBe(false);
    });

    it('autoSummaries defaults to false', () => {
      expect(WONDER_DEFAULTS.gaceta.autoSummaries).toBe(false);
    });
  });

  describe('bibliotheca', () => {
    it('fileNavigation defaults to true', () => {
      expect(WONDER_DEFAULTS.bibliotheca.fileNavigation).toBe(true);
    });

    it('graphSuggestions defaults to false', () => {
      expect(WONDER_DEFAULTS.bibliotheca.graphSuggestions).toBe(false);
    });

    it('aiRelationDiscovery defaults to false', () => {
      expect(WONDER_DEFAULTS.bibliotheca.aiRelationDiscovery).toBe(false);
    });
  });

  describe('labhub', () => {
    it('showActiveExperiments defaults to true', () => {
      expect(WONDER_DEFAULTS.labhub.showActiveExperiments).toBe(true);
    });

    it('warnBeforeCityEdit defaults to true', () => {
      expect(WONDER_DEFAULTS.labhub.warnBeforeCityEdit).toBe(true);
    });

    it('softLocks defaults to true', () => {
      expect(WONDER_DEFAULTS.labhub.softLocks).toBe(true);
    });

    it('hardLocks defaults to false', () => {
      expect(WONDER_DEFAULTS.labhub.hardLocks).toBe(false);
    });
  });
});

describe('WONDER_MANIFESTS (static) + example templates', () => {
  // bibliotheca/institutum are no longer hardcoded built-ins; they ship as
  // connectable examples. Assertions about them now read the example manifests.
  const biblio = getWonderExample('bibliotheca')!.manifest;
  const inst = getWonderExample('institutum')!.manifest;

  it('static registry ships only the native gaceta', () => {
    expect(Object.keys(WONDER_MANIFESTS)).toEqual(['gaceta']);
  });

  it('gaceta manifest automationLevel is passive', () => {
    expect(WONDER_MANIFESTS.gaceta.automationLevel).toBe('passive');
  });

  it('bibliotheca example automationLevel is passive', () => {
    expect(biblio.automationLevel).toBe('passive');
  });

  it('institutum example automationLevel is assist', () => {
    expect(inst.automationLevel).toBe('assist');
  });

  it('manifest capability flags match optionality model', () => {
    expect(WONDER_MANIFESTS.gaceta.passiveMode).toBe(true);
    expect(WONDER_MANIFESTS.gaceta.agenticMode).toBe(false);
    expect(WONDER_MANIFESTS.gaceta.canAct).toBe(false);

    expect(biblio.canSuggest).toBe(true);
    expect(biblio.canAct).toBe(false);
    expect(biblio.requiresConfirmation).toBe(true);

    expect(inst.agenticMode).toBe(true);
    expect(inst.canSuggest).toBe(true);
    expect(inst.canAct).toBe(false);
    expect(inst.requiresConfirmation).toBe(true);
  });

  it('all optionalFeatures require opt-in (static + examples)', () => {
    const manifests = [
      ...Object.values(WONDER_MANIFESTS),
      ...WONDER_EXAMPLES.map((e) => e.manifest),
    ];
    for (const manifest of manifests) {
      for (const feature of manifest.optionalFeatures) {
        expect(feature.requiresUserOptIn).toBe(true);
        expect(feature.defaultEnabled).toBe(false);
      }
    }
  });

  it('gaceta foreign_relations_report action requires opt-in', () => {
    const action = WONDER_MANIFESTS.gaceta.actions.find((a) => a.id === 'foreign_relations_report');
    expect(action).toBeDefined();
    expect(action!.requiresUserOptIn).toBe(true);
  });

  it('gaceta open action does not require opt-in', () => {
    const action = WONDER_MANIFESTS.gaceta.actions.find((a) => a.id === 'open');
    expect(action).toBeDefined();
    expect(action!.requiresUserOptIn).toBe(false);
  });

  it('institutum kill_experiment action requires opt-in', () => {
    const action = inst.actions.find((a) => a.id === 'kill_experiment');
    expect(action).toBeDefined();
    expect(action!.requiresUserOptIn).toBe(true);
  });

  it('institutum hardLocks optional feature requires opt-in', () => {
    const feature = inst.optionalFeatures.find((f) => f.id === 'hardLocks');
    expect(feature).toBeDefined();
    expect(feature!.requiresUserOptIn).toBe(true);
    expect(feature!.defaultEnabled).toBe(false);
  });
});

describe('isFeatureEnabled', () => {
  it('returns true for enabled defaults', () => {
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'gaceta', 'showNews')).toBe(true);
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'bibliotheca', 'fileNavigation')).toBe(true);
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'labhub', 'showActiveExperiments')).toBe(true);
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'labhub', 'warnBeforeCityEdit')).toBe(true);
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'labhub', 'softLocks')).toBe(true);
  });

  it('returns false for opt-in features with defaults', () => {
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'gaceta', 'foreignRelationsReport')).toBe(false);
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'gaceta', 'autoSummaries')).toBe(false);
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'bibliotheca', 'graphSuggestions')).toBe(false);
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'bibliotheca', 'aiRelationDiscovery')).toBe(false);
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'labhub', 'hardLocks')).toBe(false);
  });

  it('supports institutum and legacy labhub ids for feature lookups', () => {
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'institutum', 'showActiveExperiments')).toBe(true);
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'labhub', 'hardLocks')).toBe(false);
  });

  it('reflects user overrides', () => {
    const custom = {
      ...WONDER_DEFAULTS,
      gaceta: {
        ...WONDER_DEFAULTS.gaceta,
        foreignRelationsReport: true,
      },
    };
    expect(isFeatureEnabled(custom, 'gaceta', 'foreignRelationsReport')).toBe(true);
  });

  it('returns false for unknown wonder id', () => {
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'unknown', 'anything')).toBe(false);
  });

  it('returns false for unknown feature id', () => {
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'gaceta', 'nonexistent')).toBe(false);
  });
});

describe('loadWonderConfig', () => {
  it('returns defaults when localStorage is empty', () => {
    const config = loadWonderConfig();
    expect(config.gaceta.showNews).toBe(true);
    expect(config.gaceta.foreignRelationsReport).toBe(false);
    expect(config.bibliotheca.fileNavigation).toBe(true);
    expect(config.labhub.softLocks).toBe(true);
    expect(config.labhub.hardLocks).toBe(false);
  });
});
