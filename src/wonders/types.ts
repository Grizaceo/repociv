// ─── RepoCiv — Wonder Manifest Types ─────────────────────────────────────────
// Canonical types for the WonderManifest contract and per-wonder user config.
//
// Design principle:
// - Basic navigation/display defaults ON
// - Suggestion / analysis / automation defaults OFF unless explicitly intended

// ─── Core Wonder Contract ────────────────────────────────────────────────────

type WonderKind = 'native' | 'iframe';
type WonderCategory = 'knowledge' | 'operations' | 'news' | 'lab';
type AutomationLevel = 'passive' | 'assist' | 'auto';
type WonderActionRisk = 'safe' | 'approval' | 'manual';

interface FeatureFlag {
  id: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiresUserOptIn: boolean;
}

interface WonderAction {
  id: string;
  label: string;
  risk: WonderActionRisk;
  requiresUserOptIn: boolean;
}

interface WonderEvent {
  emits: string[];
  accepts: string[];
}

interface WonderUiConfig {
  url?: string;
  preferredWidth?: string;
  preferredHeight?: string;
  sandbox?: string[];
}

interface WonderHealthConfig {
  url: string;
  timeoutMs: number;
  degradedAllowed: boolean;
}

interface WonderPermissions {
  readRepos: boolean;
  writeRepos: boolean;
  network: 'loopback-only' | 'none';
  requiresApprovalForMutations: boolean;
}

interface WonderMcpConfig {
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

// (WonderOptionalFeature back-compat alias removed — unused)

// ─── postMessage Bridge Contract ─────────────────────────────────────────────

export type RepoCivToWonderMessage =
  | { type: 'repociv.context'; cityId?: string; selectedRepo?: string; theme: string }
  | { type: 'repociv.focus'; cityId: string; mode: 'macro' | 'local' }
  | { type: 'repociv.layer'; layer: string; enabled: boolean }
  | { type: 'repociv.open_local_view'; repoPath: string };

export type WonderToRepoCivMessage =
  | { type: 'wonder.ready'; id: string }
  | { type: 'wonder.focus_city'; cityId: string; open?: 'macro' | 'local' }
  | { type: 'wonder.report'; id: string; title: string; markdown: string; relatedCities: string[] }
  | { type: 'wonder.notification'; level: 'info' | 'warn' | 'critical'; text: string }
  | {
      type: 'wonder.selection';
      nodeId: string;
      nodePath: string;
      nodeType: 'repo' | 'file' | 'folder';
    };

// ─── Per-Wonder User Configuration ──────────────────────────────────────────
// These are the user-facing settings. They override manifest defaults.

export interface GacetaConfig {
  showNews: boolean;
  foreignRelationsReport: boolean;
  autoSummaries: boolean;
}

export interface WondersConfig {
  gaceta: GacetaConfig;
}
