// ─── RepoCiv — Wonder Manifest Types ─────────────────────────────────────────
// Types for the WonderManifest contract and per-wonder user configuration.
//
// Design principle: everything agentic/opt-in defaults to OFF.
// Basic navigation and display defaults to ON.

// ─── Automation Levels ───────────────────────────────────────────────────────

export type AutomationLevel = 'passive' | 'assist' | 'auto';

// ─── Optional Feature Declaration ───────────────────────────────────────────

export interface WonderOptionalFeature {
  id: string;
  label: string;
  description: string;
  defaultEnabled: false;
  requiresUserOptIn: true;
}

// ─── Action Declaration ─────────────────────────────────────────────────────

export interface WonderAction {
  id: string;
  label: string;
  risk: 'safe' | 'approval' | 'manual';
  requiresUserOptIn: boolean;
}

// ─── Wonder Manifest ────────────────────────────────────────────────────────

export interface WonderManifest {
  id: string;
  title: string;
  kind: 'native' | 'iframe';
  category: 'knowledge' | 'operations' | 'news' | 'lab';
  version: string;
  defaultEnabled: boolean;
  automationLevel: AutomationLevel;
  passiveMode: boolean;
  agenticMode: boolean;
  canSuggest: boolean;
  canAct: boolean;
  requiresConfirmation: boolean;
  ui: {
    url?: string;
    preferredWidth?: string;
    preferredHeight?: string;
    sandbox?: string[];
  };
  health?: {
    url: string;
    timeoutMs: number;
    degradedAllowed: boolean;
  };
  permissions: {
    readRepos: boolean;
    writeRepos: boolean;
    network: 'loopback-only' | 'none';
    requiresApprovalForMutations: boolean;
  };
  optionalFeatures: WonderOptionalFeature[];
  events: {
    emits: string[];
    accepts: string[];
  };
  actions: WonderAction[];
  mcp: {
    enabled: boolean;
    server: string | null;
  };
}

// ─── Per-Wonder User Configuration ──────────────────────────────────────────
// These are the user-facing settings. They override manifest defaults.

export interface GacetaConfig {
  showNews: boolean;
  foreignRelationsReport: boolean;
  autoSummaries: boolean;
}

export interface BibliothecaConfig {
  fileNavigation: boolean;
  graphSuggestions: boolean;
  aiRelationDiscovery: boolean;
}

export interface LabHubConfig {
  showActiveExperiments: boolean;
  warnBeforeCityEdit: boolean;
  softLocks: boolean;
  hardLocks: boolean;
}

// ─── Unified Wonders Config ─────────────────────────────────────────────────

export interface WondersConfig {
  gaceta: GacetaConfig;
  bibliotheca: BibliothecaConfig;
  labhub: LabHubConfig;
}
