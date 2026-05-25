// ─── RepoCiv — Wonder Manifest Types ─────────────────────────────────────────
// Canonical types for the WonderManifest contract and per-wonder user config.
//
// Design principle:
// - Basic navigation/display defaults ON
// - Suggestion / analysis / automation defaults OFF unless explicitly intended

// ─── Core Wonder Contract ────────────────────────────────────────────────────

export type WonderKind = 'native' | 'iframe';
export type WonderCategory = 'knowledge' | 'operations' | 'news' | 'lab';
export type AutomationLevel = 'passive' | 'assist' | 'auto';
export type WonderActionRisk = 'safe' | 'approval' | 'manual';

export interface FeatureFlag {
  id: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiresUserOptIn: boolean;
}

export interface WonderAction {
  id: string;
  label: string;
  risk: WonderActionRisk;
  requiresUserOptIn: boolean;
}

export interface WonderEvent {
  emits: string[];
  accepts: string[];
}

export interface WonderUiConfig {
  url?: string;
  preferredWidth?: string;
  preferredHeight?: string;
  sandbox?: string[];
}

export interface WonderHealthConfig {
  url: string;
  timeoutMs: number;
  degradedAllowed: boolean;
}

export interface WonderPermissions {
  readRepos: boolean;
  writeRepos: boolean;
  network: 'loopback-only' | 'none';
  requiresApprovalForMutations: boolean;
}

export interface WonderMcpConfig {
  enabled: boolean;
  server: string | null;
}

export interface WonderManifest {
  id: string;
  title: string;
  kind: WonderKind;
  category: WonderCategory;
  version: string;
  defaultEnabled: boolean;
  automationLevel: AutomationLevel;
  passiveMode: boolean;
  agenticMode: boolean;
  canSuggest: boolean;
  canAct: boolean;
  requiresConfirmation: boolean;
  ui: WonderUiConfig;
  health?: WonderHealthConfig;
  permissions: WonderPermissions;
  optionalFeatures: FeatureFlag[];
  events: WonderEvent;
  actions: WonderAction[];
  mcp: WonderMcpConfig;
}

// Back-compat alias used by existing code/tests
export type WonderOptionalFeature = FeatureFlag;

// ─── postMessage Bridge Contract ─────────────────────────────────────────────

export interface SuggestionRelation {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  relationType: 'shared_dependency' | 'shared_entity' | 'temporal_coactivity' | 'conceptual_overlap' | 'imports_or_links' | 'same_lab_family' | 'security_relevance' | 'unknown_but_interesting';
  score: number;
  evidence: string[];
  suggestedActions: ('linkear' | 'ignorar' | 'abrir_ambos' | 'crear_nota')[];
  accepted?: boolean;
  rejected?: boolean;
  fromCityName?: string;
  toCityName?: string;
  fromRepoPath?: string;
  toRepoPath?: string;
}

export type RepoCivToWonderMessage =
  | { type: 'repociv.context'; cityId?: string; selectedRepo?: string; theme: string }
  | { type: 'repociv.focus'; cityId: string; mode: 'macro' | 'local' }
  | { type: 'repociv.layer'; layer: string; enabled: boolean }
  | { type: 'repociv.open_local_view'; repoPath: string }
  | { type: 'repociv.graph_suggestions'; relations: SuggestionRelation[]; enabled: boolean };

export type WonderToRepoCivMessage =
  | { type: 'wonder.ready'; id: string }
  | { type: 'wonder.focus_city'; cityId: string; open?: 'macro' | 'local' }
  | { type: 'wonder.report'; id: string; title: string; markdown: string; relatedCities: string[] }
  | { type: 'wonder.notification'; level: 'info' | 'warn' | 'critical'; text: string }
  | { type: 'wonder.selection'; nodeId: string; nodePath: string; nodeType: 'repo' | 'file' | 'folder' };

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

export interface WondersConfig {
  gaceta: GacetaConfig;
  bibliotheca: BibliothecaConfig;
  labhub: LabHubConfig;
}
