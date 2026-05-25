// ─── RepoCiv — Wonder Manifest Registry ──────────────────────────────────────
// Runtime registry + canonical static manifests.
//
// Design:
// - Static manifests are the source of truth in the frontend
// - Invalid manifests are skipped, never crash the app
// - Future: merge with user-provided ~/.repociv/wonders/*.json via backend

import {
  LGB_BACKEND_URL,
  WONDER_BIBLIOTHECA_URL,
  WONDER_INSTITUTUM_API_URL,
  WONDER_INSTITUTUM_URL,
} from '../wonderEnv.ts';
import type { WonderManifest } from './types.ts';
import type { WonderType } from '../types.ts';

export const WONDER_MANIFESTS = {
  gaceta: {
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
        description: 'Analiza cómo una noticia afecta una ciudad/repo usando agente',
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
      { id: 'open', label: 'Abrir Gaceta', risk: 'safe', requiresUserOptIn: false },
      {
        id: 'foreign_relations_report',
        label: 'Informe de Relaciones Exteriores',
        risk: 'safe',
        requiresUserOptIn: true,
      },
    ],
    mcp: { enabled: false, server: null },
  },
  bibliotheca: {
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
      url: WONDER_BIBLIOTHECA_URL,
      preferredWidth: '70vw',
      preferredHeight: '75vh',
      sandbox: ['allow-scripts', 'allow-same-origin', 'allow-forms'],
    },
    health: {
      url: `${LGB_BACKEND_URL}/api/health`,
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
        description: 'Usa grafo offline para encontrar vínculos no obvios entre repos',
        defaultEnabled: false,
        requiresUserOptIn: true,
      },
    ],
    events: {
      emits: ['wonder.ready', 'wonder.selection', 'wonder.report.created'],
      accepts: ['repociv.focus', 'repociv.open_local_view', 'repociv.graph_suggestions'],
    },
    actions: [
      { id: 'open', label: 'Entrar', risk: 'safe', requiresUserOptIn: false },
      { id: 'ask_agent', label: 'Preguntar a agente', risk: 'safe', requiresUserOptIn: true },
    ],
    mcp: { enabled: false, server: null },
  },
  institutum: {
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
      url: WONDER_INSTITUTUM_URL,
      preferredWidth: '70vw',
      preferredHeight: '75vh',
      sandbox: ['allow-scripts', 'allow-same-origin', 'allow-forms'],
    },
    health: {
      url: `${WONDER_INSTITUTUM_API_URL}/health`,
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
        description: 'Impide completamente la edición de ciudades con experimentos críticos',
        defaultEnabled: false,
        requiresUserOptIn: true,
      },
    ],
    events: {
      emits: ['wonder.ready', 'labhub.experiment.started', 'labhub.experiment.finished'],
      accepts: ['repociv.focus_city'],
    },
    actions: [
      { id: 'open', label: 'Abrir Institutum', risk: 'safe', requiresUserOptIn: false },
      {
        id: 'kill_experiment',
        label: 'Detener experimento',
        risk: 'manual',
        requiresUserOptIn: true,
      },
    ],
    mcp: { enabled: false, server: null },
  },
} as const satisfies Record<string, WonderManifest>;

const _registry: Map<string, WonderManifest> = new Map();
let _initialized = false;

function _validateManifest(m: WonderManifest): boolean {
  if (!m.id || !m.title || !m.kind || !m.category || !m.version) return false;
  if (m.kind !== 'native' && m.kind !== 'iframe') return false;
  return true;
}

function _ensureInit(): void {
  if (_initialized) return;
  for (const [id, manifest] of Object.entries(WONDER_MANIFESTS)) {
    if (_validateManifest(manifest)) {
      _registry.set(id, manifest);
    }
  }
  _initialized = true;
}

export function listWonders(): WonderManifest[] {
  _ensureInit();
  return Array.from(_registry.values());
}

export function getWonder(id: string): WonderManifest | undefined {
  _ensureInit();
  return _registry.get(id);
}

export function getWonderByCategory(category: string): WonderManifest[] {
  _ensureInit();
  return Array.from(_registry.values()).filter((m) => m.category === category);
}

export function isWonderEnabled(id: string): boolean {
  _ensureInit();
  return _registry.get(id)?.defaultEnabled ?? false;
}

export function getWonderActions(id: string): WonderManifest['actions'] {
  _ensureInit();
  return _registry.get(id)?.actions ?? [];
}

export function getWonderOptionalFeatures(id: string): WonderManifest['optionalFeatures'] {
  _ensureInit();
  return _registry.get(id)?.optionalFeatures ?? [];
}

export function isActionOptIn(id: string, actionId: string): boolean {
  _ensureInit();
  const action = _registry.get(id)?.actions.find((a) => a.id === actionId);
  return action?.requiresUserOptIn ?? false;
}

export function resolveWonderUrl(type: WonderType): string {
  return getWonder(type)?.ui.url ?? '';
}

export const KNOWN_WONDER_TYPES: readonly WonderType[] = ['gaceta', 'bibliotheca', 'institutum'] as const;
