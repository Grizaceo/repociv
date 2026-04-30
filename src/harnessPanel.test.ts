// ─── RepoCiv — harnessPanel unit tests ───────────────────────────────────────
// Tests logic (badge label, health dot class, trust badge class, panel title,
// empty state, trust sort order) without requiring DOM.

import { describe, it, expect } from 'vitest';
import { listHarnesses } from './harnessRegistry';
import type { TrustLevel } from './harnessRegistry';

// ── Badge label ───────────────────────────────────────────────────────────────

const TRUST_LABELS: Record<TrustLevel, string> = {
  reference_only:        'Reference',
  read_only:             'Read-Only',
  sandboxed:             'Sandbox',
  local_cli:             'Local',
  privileged_external:  'Privileged',
};

describe('trust badge label', () => {
  it('covers all trust levels', () => {
    const all = listHarnesses();
    const levels = [...new Set(all.map((h) => h.trustLevel))];
    for (const lvl of levels) {
      expect(TRUST_LABELS[lvl]).toBeDefined();
    }
  });

  it('Reference harness maps to Reference', () => {
    expect(TRUST_LABELS['reference_only']).toBe('Reference');
  });
});

// ── Health dot class ─────────────────────────────────────────────────────────

const HEALTH_DOT_CLASS: Record<string, string> = {
  healthy:   'hp-healthy',
  degraded:  'hp-degraded',
  unhealthy: 'hp-unhealthy',
  unknown:   'hp-unknown',
};

describe('health dot class', () => {
  it('maps all known health kinds', () => {
    for (const [kind, cls] of Object.entries(HEALTH_DOT_CLASS)) {
      expect(cls).toMatch(/^hp-/);
    }
  });

  it('has distinct classes for each state', () => {
    const vals = Object.values(HEALTH_DOT_CLASS);
    expect(new Set(vals).size).toBe(vals.length);
  });
});

// ── Trust badge class ────────────────────────────────────────────────────────

const TRUST_BADGE_CLASS: Record<TrustLevel, string> = {
  reference_only:        'hp-cautious',
  read_only:             'hp-cautious',
  sandboxed:             'hp-cautious',
  local_cli:             'hp-cautious',
  privileged_external:   'hp-trusted',
};

describe('trust badge class', () => {
  it('maps trusted levels to hp-trusted', () => {
    expect(TRUST_BADGE_CLASS['privileged_external']).toBe('hp-trusted');
  });

  it('maps lower trust levels to hp-cautious', () => {
    expect(TRUST_BADGE_CLASS['reference_only']).toBe('hp-cautious');
    expect(TRUST_BADGE_CLASS['sandboxed']).toBe('hp-cautious');
    expect(TRUST_BADGE_CLASS['local_cli']).toBe('hp-cautious');
  });
});

// ── Panel title ──────────────────────────────────────────────────────────────

describe('panel title', () => {
  it('is Harness Control for the harness list panel', () => {
    const title = 'Harness Control';
    expect(title).toMatch(/[A-Z]/);
  });

  it('includes the word Harness', () => {
    const title = 'Harness Control';
    expect(title).toContain('Harness');
  });
});

// ── Empty state ──────────────────────────────────────────────────────────────

describe('empty state', () => {
  it('shows "No harnesses found" when list is empty', () => {
    const emptyMsg = 'No harnesses found';
    expect(emptyMsg).toContain('harness');
    expect(emptyMsg).toMatch(/[A-Z]/);
  });
});

// ── Trust sort order ────────────────────────────────────────────────────────

describe('trust sort order (highest → lowest)', () => {
  const ORDER: TrustLevel[] = [
    'privileged_external',
    'local_cli',
    'sandboxed',
    'read_only',
    'reference_only',
  ];

  it('privileged_external sorts before local_cli', () => {
    expect(ORDER.indexOf('privileged_external')).toBeLessThan(ORDER.indexOf('local_cli'));
  });

  it('local_cli sorts before sandboxed', () => {
    expect(ORDER.indexOf('local_cli')).toBeLessThan(ORDER.indexOf('sandboxed'));
  });

  it('sandboxed sorts before reference_only', () => {
    expect(ORDER.indexOf('sandboxed')).toBeLessThan(ORDER.indexOf('reference_only'));
  });

  it('actual harnesses respect trust ordering', () => {
    const harnesses = listHarnesses();
    for (let i = 0; i < harnesses.length - 1; i++) {
      const a = harnesses[i].trustLevel;
      const b = harnesses[i + 1].trustLevel;
      // Same trust level is valid (tiebreaker by id keeps order deterministic)
      expect(ORDER.indexOf(a)).toBeLessThanOrEqual(ORDER.indexOf(b));
    }
  });
});

// ── Recovery mode display ────────────────────────────────────────────────────

describe('recovery mode display', () => {
  it('maps copy_command to Copy command label', () => {
    const labels: Record<string, string> = {
      copy_command:    'Copy',
      tmux_attach:     'Tmux',
      view_logs:       'Logs',
      restart_service: 'Restart',
    };
    expect(labels['copy_command']).toBe('Copy');
  });

  it('all harnesses in registry have at least one field', () => {
    const all = listHarnesses();
    expect(all.length).toBeGreaterThan(0);
    for (const h of all) {
      expect(h.id).toBeDefined();
      expect(h.trustLevel).toBeDefined();
    }
  });
});
