import { describe, it, expect } from 'vitest';
import { normalizeThresholds, type GameConfig } from './gameConfig.ts';

function config(warnThreshold: number, criticalThreshold: number): GameConfig {
  return {
    fatigue: { warnThreshold, criticalThreshold, autoWarnBelow: 0.2 },
    animations: { skipAll: false },
    models: { allowed: [] },
    trust: { autoApproveChat: true },
  };
}

describe('normalizeThresholds', () => {
  // Both thresholds mean "colour changes below this", so critical must sit at
  // or below warn. Configs written before that convention stored the pair the
  // other way round and collapsed the orange band to nothing.
  it('swaps a legacy pair written with critical above warn', () => {
    const out = normalizeThresholds(config(0.3, 0.6));
    expect(out.fatigue.warnThreshold).toBe(0.6);
    expect(out.fatigue.criticalThreshold).toBe(0.3);
  });

  it('leaves a correctly ordered pair untouched', () => {
    const input = config(0.6, 0.15);
    expect(normalizeThresholds(input)).toBe(input);
  });

  it('accepts an equal pair without swapping', () => {
    const input = config(0.4, 0.4);
    expect(normalizeThresholds(input)).toBe(input);
  });

  it('preserves the rest of the config while swapping', () => {
    const out = normalizeThresholds(config(0.2, 0.8));
    expect(out.fatigue.autoWarnBelow).toBe(0.2);
    expect(out.trust.autoApproveChat).toBe(true);
  });

  it('always yields a pair the colour bands can read in one direction', () => {
    for (const [w, c] of [
      [0.3, 0.6],
      [0.6, 0.15],
      [0.9, 0.05],
      [0.1, 0.95],
    ] as const) {
      const out = normalizeThresholds(config(w, c));
      expect(out.fatigue.criticalThreshold).toBeLessThanOrEqual(out.fatigue.warnThreshold);
    }
  });
});
