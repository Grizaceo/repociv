// ─── RepoCiv — Game Configuration (Phase 10.2) ─────────────────────────────────
// Centralized, persisted configuration. Replaces hardcoded magic numbers.

export interface GameConfig {
  // Fatigue thresholds (as fractions 0–1)
  fatigue: {
    warnThreshold: number;   // Below this → orange bar (default 0.3 = 30%)
    criticalThreshold: number; // Below this → red bar (default 0.6 = 60% matches panel.ts hardcode)
    autoWarnBelow: number;    // Console.warn when fatigue drops below this (default 0.2 = 20%)
  };
  // Animation
  animations: {
    skipAll: boolean;         // Skip all UI animations
  };
  // Model allowlist (empty = all allowed)
  models: {
    allowed: string[];        // Model names; empty array = all permitted
  };
}

const DEFAULT_CONFIG: GameConfig = {
  fatigue: {
    warnThreshold: 0.3,       // was hardcoded in panel.ts:71
    criticalThreshold: 0.6,   // was hardcoded in panel.ts:71
    autoWarnBelow: 0.2,       // was hardcoded in game.ts:217
  },
  animations: {
    skipAll: false,
  },
  models: {
    allowed: [],              // empty = all models allowed by default
  },
};

const STORAGE_KEY = 'repociv:config';

let _cached: GameConfig | null = null;

/** Load config from localStorage (falls back to defaults) */
export function loadConfig(): GameConfig {
  if (_cached) return _cached;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GameConfig>;
      // Deep-merge with defaults so new fields get defaults
      _cached = deepMerge(DEFAULT_CONFIG, parsed);
    }
  } catch {
    _cached = { ...DEFAULT_CONFIG };
  }
  if (!_cached) _cached = { ...DEFAULT_CONFIG };
  return _cached;
}

/** Persist config to localStorage */
export function saveConfig(cfg: GameConfig): void {
  _cached = cfg;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    console.warn('[config] Failed to persist to localStorage');
  }
}

/** Reset to defaults */
export function resetConfig(): GameConfig {
  const cfg = { ...DEFAULT_CONFIG };
  saveConfig(cfg);
  return cfg;
}

/** Convenience getters (read from current config) */
export const cfg = {
  get fatigue() { return loadConfig().fatigue; },
  get animations() { return loadConfig().animations; },
  get models() { return loadConfig().models; },
};

// ─── Deep merge utility ────────────────────────────────────────────────────────
function deepMerge<T extends object>(base: T, patch: Partial<T>): T {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const pv = patch[key];
    const bv = base[key];
    if (pv !== undefined) {
      if (
        pv !== null &&
        bv !== null &&
        typeof pv === 'object' &&
        !Array.isArray(pv) &&
        !Array.isArray(bv)
      ) {
        out[key] = deepMerge(bv as object, pv as object);
      } else {
        out[key] = pv;
      }
    }
  }
  return out as T;
}
