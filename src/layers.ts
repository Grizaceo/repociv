// ─── RepoCiv — Map Layer State ─────────────────────────────────────────────────
//
// Minimal layer visibility system.
// Types live in types.ts; this module provides the runtime state + helpers.
//
// Design:
// - Default: base + structure ON, everything else OFF
// - Loaded from localStorage under 'repociv_layers'

import type { MapLayerId, MapLayerState } from './types.ts';
import { DEFAULT_MAP_LAYERS } from './types.ts';

const STORAGE_KEY = 'repociv_layers';

const _state: MapLayerState = _loadState();

function _loadState(): MapLayerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const rawObj = JSON.parse(raw) as Record<string, unknown>;
      const rawLayers = (rawObj.layers ?? {}) as Record<string, boolean>;
      // Migrate old 'operational' key → 'ops'
      if ('operational' in rawLayers && !('ops' in rawLayers)) {
        rawLayers['ops'] = rawLayers['operational']!;
        delete rawLayers['operational'];
      }
      // Build clean state: inject defaults for any missing layers
      const layers: Record<MapLayerId, boolean> = {} as Record<MapLayerId, boolean>;
      for (const id of Object.keys(DEFAULT_MAP_LAYERS.layers) as MapLayerId[]) {
        layers[id] =
          typeof rawLayers[id] === 'boolean' ? rawLayers[id] : DEFAULT_MAP_LAYERS.layers[id];
      }
      const parsed: MapLayerState = { layers };
      return parsed;
    }
  } catch {
    // ignore corrupt data
  }
  return { ...DEFAULT_MAP_LAYERS, layers: { ...DEFAULT_MAP_LAYERS.layers } };
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function getLayerState(): MapLayerState {
  return _state;
}

export function isLayerVisible(id: MapLayerId): boolean {
  return _state.layers[id] ?? false;
}
