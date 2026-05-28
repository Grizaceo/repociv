// ─── RepoCiv — Wonder Config Tests ──────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  WONDER_DEFAULTS,
  WONDER_MANIFESTS,
  loadWonderConfig,
  isFeatureEnabled,
} from '../wonders/wonderConfig.ts';

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

describe('WONDER_MANIFESTS', () => {
  it('gaceta manifest automationLevel is passive', () => {
    expect(WONDER_MANIFESTS.gaceta.automationLevel).toBe('passive');
  });

  it('bibliotheca manifest automationLevel is passive', () => {
    expect(WONDER_MANIFESTS.bibliotheca.automationLevel).toBe('passive');
  });

  it('institutum manifest automationLevel is assist', () => {
    expect(WONDER_MANIFESTS.institutum.automationLevel).toBe('assist');
  });

  it('manifest capability flags match optionality model', () => {
    expect(WONDER_MANIFESTS.gaceta.passiveMode).toBe(true);
    expect(WONDER_MANIFESTS.gaceta.agenticMode).toBe(false);
    expect(WONDER_MANIFESTS.gaceta.canAct).toBe(false);

    expect(WONDER_MANIFESTS.bibliotheca.canSuggest).toBe(true);
    expect(WONDER_MANIFESTS.bibliotheca.canAct).toBe(false);
    expect(WONDER_MANIFESTS.bibliotheca.requiresConfirmation).toBe(true);

    expect(WONDER_MANIFESTS.institutum.agenticMode).toBe(true);
    expect(WONDER_MANIFESTS.institutum.canSuggest).toBe(true);
    expect(WONDER_MANIFESTS.institutum.canAct).toBe(false);
    expect(WONDER_MANIFESTS.institutum.requiresConfirmation).toBe(true);
  });

  it('all optionalFeatures require opt-in', () => {
    for (const manifest of Object.values(WONDER_MANIFESTS)) {
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
    const action = WONDER_MANIFESTS.institutum.actions.find((a) => a.id === 'kill_experiment');
    expect(action).toBeDefined();
    expect(action!.requiresUserOptIn).toBe(true);
  });

  it('institutum hardLocks optional feature requires opt-in', () => {
    const feature = WONDER_MANIFESTS.institutum.optionalFeatures.find((f) => f.id === 'hardLocks');
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
