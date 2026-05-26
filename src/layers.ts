// ─── RepoCiv — Map Layer State ─────────────────────────────────────────────────
//
// Minimal layer visibility system.
// Types live in types.ts; this module provides the runtime state + helpers.
//
// Design:
// - Default: base + structure ON, everything else OFF
// - Toggle per-layer via exported functions
// - Subscribers notified on change (for future renderer integration)
// - Persisted to localStorage under 'repociv_layers'

import type { MapLayerId, MapLayerState } from './types.ts';
import { DEFAULT_MAP_LAYERS } from './types.ts';

const STORAGE_KEY = 'repociv_layers';

type Listener = (state: MapLayerState) => void;

let _state: MapLayerState = _loadState();
const _listeners: Set<Listener> = new Set();

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
        layers[id] = typeof rawLayers[id] === 'boolean' ? rawLayers[id] : DEFAULT_MAP_LAYERS.layers[id];
      }
      const parsed: MapLayerState = { layers };
      return parsed;
    }
  } catch {
    // ignore corrupt data
  }
  return { ...DEFAULT_MAP_LAYERS, layers: { ...DEFAULT_MAP_LAYERS.layers } };
}

function _persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_state));
  } catch {
    // ignore quota errors
  }
}

function _notify(): void {
  for (const fn of _listeners) {
    fn(_state);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function getLayerState(): MapLayerState {
  return _state;
}

export function isLayerVisible(id: MapLayerId): boolean {
  return _state.layers[id] ?? false;
}

export function toggleLayer(id: MapLayerId): void {
  _state.layers[id] = !_state.layers[id];
  _persist();
  _notify();
  _trackLayerToggle(id, _state.layers[id]);
}

function _trackLayerToggle(id: MapLayerId, visible: boolean): void {
  try {
    const key = 'repociv_layer_analytics';
    const raw = localStorage.getItem(key);
    const data: Record<string, { opens: number; closes: number; lastAt: number }> =
      raw ? (JSON.parse(raw) as Record<string, { opens: number; closes: number; lastAt: number }>) : {};
    if (!data[id]) data[id] = { opens: 0, closes: 0, lastAt: 0 };
    if (visible) data[id].opens += 1;
    else data[id].closes += 1;
    data[id].lastAt = Date.now();
    localStorage.setItem(key, JSON.stringify(data));
  } catch {
    // ignore quota / parse errors
  }
}

export function setLayer(id: MapLayerId, visible: boolean): void {
  if (_state.layers[id] !== visible) {
    _state.layers[id] = visible;
    _persist();
    _notify();
  }
}

export function resetLayers(): void {
  _state = { ...DEFAULT_MAP_LAYERS, layers: { ...DEFAULT_MAP_LAYERS.layers } };
  _persist();
  _notify();
}

export function subscribe(fn: Listener): () => void {
  _listeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}
