// ─── RepoCiv — Game Configuration (Phase 10.2) ─────────────────────────────────
// Centralized, persisted configuration. Replaces hardcoded magic numbers.

import { logger } from './logger.ts';
import * as v from 'valibot';

export interface GameConfig {
  // Remaining-context thresholds, as fractions 0–1 of a unit's context budget.
  // The scale runs one way: 1 = fresh, 0 = exhausted, and each threshold is the
  // point BELOW which the bar changes colour. So critical <= warn, always.
  // (Kept under the `fatigue` key for localStorage compatibility; the values are
  // remaining context, which is what the UI has always labelled them.)
  fatigue: {
    warnThreshold: number; // Below this → orange bar (default 0.6 = 60%)
    criticalThreshold: number; // Below this → red bar (default 0.15 = 15%)
    autoWarnBelow: number; // Console.warn when context drops below this (default 0.2 = 20%)
  };
  // Animation
  animations: {
    skipAll: boolean; // Skip all UI animations
  };
  // Model allowlist (empty = all allowed)
  models: {
    allowed: string[]; // Model names; empty array = all permitted
  };
  // Trust / approval shortcuts
  trust: {
    autoApproveChat: boolean; // Auto-approve execute_agent commands without showing card
  };
}

// ─── Valibot schema (lenient: all nested fields optional to allow partial updates) ──
const GameConfigSchema = v.object({
  fatigue: v.optional(
    v.object({
      warnThreshold: v.optional(v.number()),
      criticalThreshold: v.optional(v.number()),
      autoWarnBelow: v.optional(v.number()),
    }),
  ),
  animations: v.optional(
    v.object({
      skipAll: v.optional(v.boolean()),
    }),
  ),
  models: v.optional(
    v.object({
      allowed: v.optional(v.array(v.string())),
    }),
  ),
  trust: v.optional(
    v.object({
      autoApproveChat: v.optional(v.boolean()),
    }),
  ),
});

const DEFAULT_CONFIG: GameConfig = {
  fatigue: {
    warnThreshold: 0.6, // below 60% context → orange
    criticalThreshold: 0.15, // below 15% context → red
    autoWarnBelow: 0.2, // was hardcoded in game.ts:217
  },
  animations: {
    skipAll: false,
  },
  models: {
    allowed: [], // empty = all models allowed by default
  },
  trust: {
    autoApproveChat: true, // auto-approve chat commands (execute_agent) by default
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
      const parsed = JSON.parse(raw);
      const result = v.safeParse(GameConfigSchema, parsed);
      // On schema validation failure silently fall back to defaults (corrupt localStorage).
      // On success deep-merge so new fields added in future releases get their defaults.
      _cached = deepMerge(
        DEFAULT_CONFIG,
        (result.success ? result.output : {}) as Partial<GameConfig>,
      );
    }
  } catch {
    _cached = { ...DEFAULT_CONFIG };
  }
  if (!_cached) _cached = { ...DEFAULT_CONFIG };
  _cached = normalizeThresholds(_cached);
  return _cached;
}

/** Both thresholds are "colour changes below this", so critical must sit at or
 *  below warn. Configs written before that convention stored them the other way
 *  round (warn 0.3 / critical 0.6); swapping restores the user's intent instead
 *  of silently collapsing the orange band to nothing. */
export function normalizeThresholds(config: GameConfig): GameConfig {
  const { warnThreshold, criticalThreshold } = config.fatigue;
  if (criticalThreshold <= warnThreshold) return config;
  return {
    ...config,
    fatigue: {
      ...config.fatigue,
      warnThreshold: criticalThreshold,
      criticalThreshold: warnThreshold,
    },
  };
}

/** Read current config (alias used by gameplay systems). */
export function getConfig(): GameConfig {
  return loadConfig();
}

/** Persist config to localStorage */
export function saveConfig(cfg: GameConfig): void {
  _cached = normalizeThresholds(cfg);
  cfg = _cached;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    logger.warn('[config] Failed to persist to localStorage');
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
  get fatigue() {
    return loadConfig().fatigue;
  },
  get animations() {
    return loadConfig().animations;
  },
  get models() {
    return loadConfig().models;
  },
  get trust() {
    return loadConfig().trust;
  },
};

// ─── Deep merge utility ────────────────────────────────────────────────────────
function deepMerge<T extends object>(base: T, patch: Partial<T>): T {
  const out = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const pv = patch[key] as unknown;
    const bv = (base as Record<string, unknown>)[key as string];
    if (pv !== undefined) {
      if (
        pv !== null &&
        bv !== null &&
        typeof pv === 'object' &&
        !Array.isArray(pv) &&
        !Array.isArray(bv)
      ) {
        out[key as string] = deepMerge(bv as object, pv as object);
      } else {
        out[key as string] = pv;
      }
    }
  }
  return out as T;
}
