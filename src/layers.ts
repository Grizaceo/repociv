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
      const parsed = JSON.parse(raw) as MapLayerState;
      // Validate shape: ensure all layer ids exist
      for (const id of Object.keys(DEFAULT_MAP_LAYERS.layers) as MapLayerId[]) {
        if (typeof parsed.layers[id] !== 'boolean') {
          parsed.layers[id] = DEFAULT_MAP_LAYERS.layers[id];
        }
      }
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
