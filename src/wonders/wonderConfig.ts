// ─── RepoCiv — Wonder Configuration Defaults ─────────────────────────────────
//
// Default configuration for all Wonders.
//
// Rule: everything that suggests, analyzes, or automates starts OFF.
// Only basic display/interaction defaults to ON.
//
// Users can override these via localStorage key: repociv_wonder_config
// Format: JSON matching WondersConfig shape (partial OK — merged with defaults).

import type {
  WondersConfig,
  GacetaConfig,
  BibliothecaConfig,
  LabHubConfig,
  WonderManifest,
} from './types.ts';

// ─── Per-Wonder Defaults ────────────────────────────────────────────────────

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

// ─── Unified Defaults ───────────────────────────────────────────────────────

export const WONDER_DEFAULTS: WondersConfig = {
  gaceta: DEFAULT_GACETA,
  bibliotheca: DEFAULT_BIBLIOTHECA,
  labhub: DEFAULT_LABHUB,
};

// ─── Manifest Defaults ──────────────────────────────────────────────────────

const GACETA_MANIFEST: WonderManifest = {
  id: 'gaceta',
  title: 'La Gaceta Imperial',
  kind: 'native',
  category: 'news',
  version: '0.1.0',
  defaultEnabled: true,
  automationLevel: 'passive',
  passiveMode: true,
  agenticMode: false,
  canSuggest: false,
  canAct: false,
  requiresConfirmation: false,
  ui: {},
  permissions: {
    readRepos: false,
    writeRepos: false,
    network: 'none',
    requiresApprovalForMutations: false,
  },
  optionalFeatures: [
    {
      id: 'foreignRelationsReport',
      label: 'Informe de Relaciones Exteriores',
      description:
        'Analiza cómo una noticia afecta una ciudad/repo usando agente',
      defaultEnabled: false,
      requiresUserOptIn: true,
    },
    {
      id: 'autoSummaries',
      label: 'Resúmenes automáticos',
      description: 'Resume noticias relevantes sin pedirlo explícitamente',
      defaultEnabled: false,
      requiresUserOptIn: true,
    },
  ],
  events: {
    emits: ['wonder.ready', 'wonder.report.created'],
    accepts: ['repociv.focus_city'],
  },
  actions: [
    {
      id: 'open',
      label: 'Abrir Gaceta',
      risk: 'safe',
      requiresUserOptIn: false,
    },
    {
      id: 'foreign_relations_report',
      label: 'Informe de Relaciones Exteriores',
      risk: 'safe',
      requiresUserOptIn: true,
    },
  ],
  mcp: {
    enabled: false,
    server: null,
  },
};

const BIBLIOTHECA_MANIFEST: WonderManifest = {
  id: 'bibliotheca',
  title: 'Bibliotheca Alexandrina',
  kind: 'iframe',
  category: 'knowledge',
  version: '0.1.0',
  defaultEnabled: true,
  automationLevel: 'passive',
  passiveMode: true,
  agenticMode: false,
  canSuggest: true,
  canAct: false,
  requiresConfirmation: true,
  ui: {
    url: '__VITE_WONDER_BIBLIOTHECA_URL__',
    preferredWidth: '70vw',
    preferredHeight: '75vh',
    sandbox: ['allow-scripts', 'allow-same-origin', 'allow-forms'],
  },
  health: {
    url: '__VITE_LGB_BACKEND_URL__/api/health',
    timeoutMs: 4000,
    degradedAllowed: true,
  },
  permissions: {
    readRepos: true,
    writeRepos: false,
    network: 'loopback-only',
    requiresApprovalForMutations: true,
  },
  optionalFeatures: [
    {
      id: 'graphSuggestions',
      label: 'Sugerencias de relaciones',
      description: 'El agente Astrónomo sugiere conexiones entre nodos',
      defaultEnabled: false,
      requiresUserOptIn: true,
    },
    {
      id: 'aiRelationDiscovery',
      label: 'Descubrimiento AI de relaciones',
      description:
        'Usa grafo offline para encontrar vínculos no obvios entre repos',
      defaultEnabled: false,
      requiresUserOptIn: true,
    },
  ],
  events: {
    emits: ['wonder.ready', 'wonder.selection', 'wonder.report.created'],
    accepts: ['repociv.focus_city', 'repociv.open_local_view'],
  },
  actions: [
    {
      id: 'open',
      label: 'Entrar',
      risk: 'safe',
      requiresUserOptIn: false,
    },
    {
      id: 'ask_agent',
      label: 'Preguntar a agente',
      risk: 'safe',
      requiresUserOptIn: true,
    },
  ],
  mcp: {
    enabled: false,
    server: null,
  },
};

const LABHUB_MANIFEST: WonderManifest = {
  id: 'institutum',
  title: 'Institutum Laboratorium / LabHub',
  kind: 'iframe',
  category: 'lab',
  version: '0.1.0',
  defaultEnabled: true,
  automationLevel: 'assist',
  passiveMode: true,
  agenticMode: true,
  canSuggest: true,
  canAct: false,
  requiresConfirmation: true,
  ui: {
    url: '__VITE_WONDER_INSTITUTUM_URL__',
    preferredWidth: '70vw',
    preferredHeight: '75vh',
    sandbox: ['allow-scripts', 'allow-same-origin', 'allow-forms'],
  },
  health: {
    url: '__VITE_WONDER_INSTITUTUM_API_URL__/health',
    timeoutMs: 4000,
    degradedAllowed: true,
  },
  permissions: {
    readRepos: false,
    writeRepos: false,
    network: 'loopback-only',
    requiresApprovalForMutations: true,
  },
  optionalFeatures: [
    {
      id: 'hardLocks',
      label: 'Bloqueos duros',
      description:
        'Impide completamente la edición de ciudades con experimentos críticos',
      defaultEnabled: false,
      requiresUserOptIn: true,
    },
  ],
  events: {
    emits: [
      'wonder.ready',
      'labhub.experiment.started',
      'labhub.experiment.finished',
    ],
    accepts: ['repociv.focus_city'],
  },
  actions: [
    {
      id: 'open',
      label: 'Abrir Institutum',
      risk: 'safe',
      requiresUserOptIn: false,
    },
    {
      id: 'kill_experiment',
      label: 'Detener experimento',
      risk: 'manual',
      requiresUserOptIn: true,
    },
  ],
  mcp: {
    enabled: false,
    server: null,
  },
};

// ─── All Manifests ──────────────────────────────────────────────────────────

export const WONDER_MANIFESTS = {
  gaceta: GACETA_MANIFEST,
  bibliotheca: BIBLIOTHECA_MANIFEST,
  institutum: LABHUB_MANIFEST,
} as const satisfies Record<string, WonderManifest>;

// ─── User Config Helpers ────────────────────────────────────────────────────

const STORAGE_KEY = 'repociv_wonder_config';

function parsePartial<T extends Record<string, unknown>>(
  raw: string,
  fallback: T,
): T {
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
