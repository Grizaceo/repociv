// ─── RepoCiv — Wonder Configuration Defaults ─────────────────────────────────
// Default user-facing configuration for all Wonders.
//
// Rule: everything that suggests, analyzes, or automates starts OFF.
// Only basic display/interaction defaults to ON.
//
// Users can override these via localStorage key: repociv_wonder_config
// Format: JSON matching WondersConfig shape (partial OK — merged with defaults).

import type { WondersConfig, GacetaConfig, BibliothecaConfig, LabHubConfig } from './types.ts';
export { WONDER_MANIFESTS } from './manifest.ts';

const DEFAULT_GACETA: GacetaConfig = {
  showNews: true,
  foreignRelationsReport: false,
  autoSummaries: false,
};

const DEFAULT_BIBLIOTHECA: BibliothecaConfig = {
  fileNavigation: true,
  graphSuggestions: false,
  aiRelationDiscovery: false,
};

const DEFAULT_LABHUB: LabHubConfig = {
  showActiveExperiments: true,
  warnBeforeCityEdit: true,
  softLocks: true,
  hardLocks: false,
};

export const WONDER_DEFAULTS: WondersConfig = {
  gaceta: DEFAULT_GACETA,
  bibliotheca: DEFAULT_BIBLIOTHECA,
  labhub: DEFAULT_LABHUB,
};

const STORAGE_KEY = 'repociv_wonder_config';

function parsePartial<T extends Record<string, unknown>>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return { ...fallback, ...parsed } as T;
    }
  } catch {
    // ignore malformed JSON
  }
  return fallback;
}

export function loadWonderConfig(): WondersConfig {
  if (typeof window === 'undefined') return WONDER_DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return WONDER_DEFAULTS;
    const parsed = parsePartial<Partial<WondersConfig>>(raw, {});
    return {
      gaceta: { ...DEFAULT_GACETA, ...(parsed.gaceta ?? {}) },
      bibliotheca: { ...DEFAULT_BIBLIOTHECA, ...(parsed.bibliotheca ?? {}) },
      labhub: { ...DEFAULT_LABHUB, ...(parsed.labhub ?? {}) },
    };
  } catch {
    return WONDER_DEFAULTS;
  }
}

export function saveWonderConfig(config: WondersConfig): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // localStorage full or unavailable — silent
  }
}

export function isFeatureEnabled(
  config: WondersConfig,
  wonderId: string,
  featureId: string,
): boolean {
  switch (wonderId) {
    case 'gaceta': {
      const gaceta = config.gaceta;
      switch (featureId) {
        case 'showNews':
          return gaceta.showNews;
        case 'foreignRelationsReport':
          return gaceta.foreignRelationsReport;
        case 'autoSummaries':
          return gaceta.autoSummaries;
        default:
          return false;
      }
    }
    case 'bibliotheca': {
      const bib = config.bibliotheca;
      switch (featureId) {
        case 'fileNavigation':
          return bib.fileNavigation;
        case 'graphSuggestions':
          return bib.graphSuggestions;
        case 'aiRelationDiscovery':
          return bib.aiRelationDiscovery;
        default:
          return false;
      }
    }
    case 'institutum':
    case 'labhub': {
      const lab = config.labhub;
      switch (featureId) {
        case 'showActiveExperiments':
          return lab.showActiveExperiments;
        case 'warnBeforeCityEdit':
          return lab.warnBeforeCityEdit;
        case 'softLocks':
          return lab.softLocks;
        case 'hardLocks':
          return lab.hardLocks;
        default:
          return false;
      }
    }
    default:
      return false;
  }
}
