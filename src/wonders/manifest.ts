// ─── RepoCiv — Wonder Manifest Registry ──────────────────────────────────────
//
// Runtime registry: loads static manifests and resolves them by id.
// This is the single source of truth for "what Wonders exist" at runtime.
//
// Design:
// - Start with static manifests (gaceta, bibliotheca, institutum)
// - Future: merge with user-provided ~/.repociv/wonders/*.json
// - Manifest invalidation never crashes the app

import { WONDER_MANIFESTS } from './wonderConfig.ts';
import type { WonderManifest } from './types.ts';

// ─── Registry State ──────────────────────────────────────────────────────────

const _registry: Map<string, WonderManifest> = new Map();
let _initialized = false;

// ─── Init ────────────────────────────────────────────────────────────────────

function _ensureInit(): void {
  if (_initialized) return;
  for (const [id, manifest] of Object.entries(WONDER_MANIFESTS)) {
    if (_validateManifest(manifest)) {
      _registry.set(id, manifest);
    }
  }
  _initialized = true;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function _validateManifest(m: WonderManifest): boolean {
  if (!m.id || !m.title || !m.kind || !m.category || !m.version) {
    // Invalid manifest skipped silently at runtime
    return false;
  }
  if (m.kind !== 'native' && m.kind !== 'iframe') {
    // Invalid kind skipped silently at runtime
    return false;
  }
  return true;
}

// ─── Public API ──────────────────────────────────────────────────────────────

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
  const m = _registry.get(id);
  return m ? m.defaultEnabled : false;
}

export function getWonderActions(id: string): WonderManifest['actions'] {
  _ensureInit();
  const m = _registry.get(id);
  return m ? m.actions : [];
}

export function getWonderOptionalFeatures(id: string): WonderManifest['optionalFeatures'] {
  _ensureInit();
  const m = _registry.get(id);
  return m ? m.optionalFeatures : [];
}

export function isActionOptIn(id: string, actionId: string): boolean {
  _ensureInit();
  const m = _registry.get(id);
  if (!m) return false;
  const action = m.actions.find((a) => a.id === actionId);
  return action ? action.requiresUserOptIn : false;
}

// ─── Compatibility re-exports ────────────────────────────────────────────────
// These keep existing code (wonderVignette, capitalPanel) importing from here.

import { wonderUiUrl } from '../wonderEnv.ts';
import type { WonderType } from '../types.ts';

/** Back-compat: resolve iframe URL from WonderType. */
export function resolveWonderUrl(type: WonderType): string {
  return wonderUiUrl(type);
}

/** Back-compat: all wonder types. */
export const KNOWN_WONDER_TYPES: readonly WonderType[] = [
  'bibliotheca',
  'institutum',
] as const;
