// ─── RepoCiv — Wonder Manifest Registry ──────────────────────────────────────
// Runtime registry + canonical static manifests.
//
// Design:
// - Static manifests are the source of truth in the frontend
// - Invalid manifests are skipped, never crash the app
// - Future: merge with user-provided ~/.repociv/wonders/*.json via backend

import { bridgeHeaders, bridgeUrl } from '../bridgeEnv.ts';
import type { WonderManifest } from './types.ts';
import type { WonderType } from '../types.ts';

// Native fallback only. The iframe wonders (Bibliotheca, LabHub, and any
// user-connected service) are NOT hardcoded here anymore — they live in the
// backend registry (~/.repociv/wonders/*.json, served by GET /api/wonders)
// and are hydrated at runtime via loadWonders(). Out-of-the-box only La Gaceta
// (native) is active; examples to connect live in ./exampleTemplates.ts.
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
} as const satisfies Record<string, WonderManifest>;

const _registry: Map<string, WonderManifest> = new Map();
let _initialized = false;
let _loaded = false;

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

/** Hydrate the registry from the backend (GET /api/wonders), which merges the
 *  user's connected wonders (~/.repociv/wonders/*.json) with any built-ins.
 *  Idempotent: only refetches when ``force`` or after invalidation. On any
 *  failure (bridge down) the static gaceta fallback stays in place so the UI
 *  never crashes. Returns the current manifest list. */
export async function loadWonders(force = false): Promise<WonderManifest[]> {
  _ensureInit();
  if (_loaded && !force) return listWonders();
  try {
    const res = await fetch(bridgeUrl('/api/wonders'), { headers: bridgeHeaders() });
    if (res.ok) {
      const data = (await res.json()) as unknown;
      if (Array.isArray(data)) {
        _registry.clear();
        for (const raw of data) {
          const m = raw as WonderManifest;
          if (_validateManifest(m)) _registry.set(m.id, m);
        }
        // gaceta is native (no backend health/launch); guarantee it survives
        // even if the backend registry omits it.
        if (!_registry.has('gaceta')) _registry.set('gaceta', WONDER_MANIFESTS.gaceta);
        _initialized = true;
      }
    }
  } catch {
    // bridge unreachable — keep the static fallback already seeded above.
  }
  _loaded = true;
  return listWonders();
}

/** Bootstrap helper: hydrate once before building the capital panel / map. */
export function ensureWondersLoaded(): Promise<WonderManifest[]> {
  return loadWonders(false);
}

/** Force a refetch on the next ensureWondersLoaded()/loadWonders() call —
 *  used after connect/disconnect mutations so the UI reflects disk state. */
export function invalidateWondersCache(): void {
  _loaded = false;
}

export function listWonders(): WonderManifest[] {
  _ensureInit();
  return Array.from(_registry.values());
}

/** iframe wonders currently registered (connected) — drives map placement
 *  and auto-launch. Excludes native wonders (gaceta) which have no server. */
export function listIframeWonders(): WonderManifest[] {
  return listWonders().filter((m) => m.kind === 'iframe');
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

export const KNOWN_WONDER_TYPES: readonly WonderType[] = [
  'gaceta',
  'bibliotheca',
  'institutum',
] as const;
