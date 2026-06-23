// ─── Tests for the Hermes status helper (Fase 1 / audit 1.1) ───────────────
// Pure-function tests for the type guard and feature lists. The
// banner rendering is tested separately in
// src/ui/hermesStatusBanner.test.ts.

import { describe, expect, it } from 'vitest';

import {
  formatActivationSteps,
  listAffectedFeatures,
  normalizeHermesStatus,
  type HermesStatus,
} from './hermesStatus.ts';

const DOWN: HermesStatus = {
  available: false,
  url: 'http://localhost:8642',
  latencyMs: 18,
  error: 'network: connection refused',
  modelCount: null,
  checkedAt: 1700000000,
};

const UP: HermesStatus = {
  available: true,
  url: 'http://localhost:8642',
  latencyMs: 24,
  error: null,
  modelCount: 5,
  checkedAt: 1700000000,
};

// ─── normalizeHermesStatus ─────────────────────────────────────────────────

describe('normalizeHermesStatus', () => {
  it('parses a well-formed down object', () => {
    expect(normalizeHermesStatus(DOWN)).toEqual(DOWN);
  });

  it('parses a well-formed up object', () => {
    const result = normalizeHermesStatus(UP);
    expect(result.available).toBe(true);
    expect(result.modelCount).toBe(5);
    expect(result.error).toBeNull();
  });

  it('coerces missing fields to FALLBACK defaults', () => {
    const result = normalizeHermesStatus({});
    expect(result.available).toBe(false);
    expect(result.error).toBeNull();
    expect(result.modelCount).toBeNull();
    expect(result.checkedAt).toBe(0);
  });

  it('returns fallback for null / non-object input', () => {
    expect(normalizeHermesStatus(null).available).toBe(false);
    expect(normalizeHermesStatus('string').available).toBe(false);
    expect(normalizeHermesStatus(42).available).toBe(false);
  });

  it('does not throw on type-confused fields', () => {
    const result = normalizeHermesStatus({
      available: 'yes', // wrong type
      error: 123,
      modelCount: 'five',
    });
    expect(result.available).toBe(false);
    expect(result.error).toBeNull();
    expect(result.modelCount).toBeNull();
  });
});

// ─── listAffectedFeatures / formatActivationSteps ─────────────────────────

describe('listAffectedFeatures', () => {
  it('returns at least 3 high-signal features', () => {
    const feats = listAffectedFeatures();
    expect(feats.length).toBeGreaterThanOrEqual(3);
    for (const f of feats) {
      expect(f.id).toBeTruthy();
      expect(f.label).toBeTruthy();
      expect(f.impact).toBeTruthy();
    }
  });

  it('includes chat and model picker (the most visible degradations)', () => {
    const ids = listAffectedFeatures().map((f) => f.id);
    expect(ids).toContain('chat');
    expect(ids).toContain('model-picker');
  });
});

describe('formatActivationSteps', () => {
  it('returns 3+ actionable steps', () => {
    const steps = formatActivationSteps();
    expect(steps.length).toBeGreaterThanOrEqual(3);
  });
});
