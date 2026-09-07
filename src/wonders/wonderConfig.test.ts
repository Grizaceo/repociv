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
});

describe('WONDER_MANIFESTS (static)', () => {
  it('static registry ships only the native gaceta', () => {
    expect(Object.keys(WONDER_MANIFESTS)).toEqual(['gaceta']);
  });

  it('gaceta manifest automationLevel is passive', () => {
    expect(WONDER_MANIFESTS.gaceta.automationLevel).toBe('passive');
  });

  it('manifest capability flags match optionality model', () => {
    expect(WONDER_MANIFESTS.gaceta.passiveMode).toBe(true);
    expect(WONDER_MANIFESTS.gaceta.agenticMode).toBe(false);
    expect(WONDER_MANIFESTS.gaceta.canAct).toBe(false);
  });

  it('all optionalFeatures require opt-in', () => {
    const manifests = Object.values(WONDER_MANIFESTS);
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
});

describe('isFeatureEnabled', () => {
  it('returns true for enabled defaults', () => {
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'gaceta', 'showNews')).toBe(true);
  });

  it('returns false for opt-in features with defaults', () => {
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'gaceta', 'foreignRelationsReport')).toBe(false);
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'gaceta', 'autoSummaries')).toBe(false);
  });

  it('retired wonder ids resolve to false', () => {
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'bibliotheca', 'graphSuggestions')).toBe(false);
    expect(isFeatureEnabled(WONDER_DEFAULTS, 'institutum', 'showActiveExperiments')).toBe(false);
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
  });
});
