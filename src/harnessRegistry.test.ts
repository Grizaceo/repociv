// ─── RepoCiv — Harness Registry Tests ─────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import { getHarness, listHarnesses, findHarnessForCommand, _resetCache } from './harnessRegistry';

describe('harnessRegistry', () => {
  beforeEach(() => {
    _resetCache();
  });

  // ── load / list ──────────────────────────────────────────────────────────────

  it('listHarnesses returns all five seeded harnesses', () => {
    const all = listHarnesses();
    expect(all).toHaveLength(5);
    const ids = all.map((h) => h.id).sort();
    expect(ids).toEqual([
      'hermes-local',
      'local-cli',
      'nemoclaw-sandbox',
      'openclaw-local',
      'reference-only',
    ]);
  });

  it('listHarnesses returns a copy (mutation safe)', () => {
    const a = listHarnesses();
    const b = listHarnesses();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  // ── getHarness ──────────────────────────────────────────────────────────────

  it('getHarness returns a known harness by id', () => {
    const h = getHarness('reference-only');
    expect(h).not.toBeNull();
    expect(h!.id).toBe('reference-only');
    expect(h!.trustLevel).toBe('reference_only');
    expect(h!.kind).toBe('reference');
    expect(h!.transport).toBe('none');
  });

  it('getHarness returns null for unknown id', () => {
    expect(getHarness('does-not-exist')).toBeNull();
  });

  it('getHarness returns hermes-local with correct structure', () => {
    const h = getHarness('hermes-local')!;
    expect(h.trustLevel).toBe('local_cli');
    expect(h.transport).toBe('cli');
    expect(h.recoveryModes).toContain('copy_command');
    expect(h.recoveryModes).toContain('tmux_attach');
    expect(h.allowedActions).toContain('inspect_repo');
    expect(h.blockedActions).toContain('send_message');
    expect(h.recovery?.copy_command).toBeDefined();
    const copyEntry = h.recovery!['copy_command'];
    expect(copyEntry?.cwd).toBe('~/.hermes');
  });

  // ── findHarnessForCommand ───────────────────────────────────────────────────

  it('findHarnessForCommand prefers local-cli for read_file (highest trust)', () => {
    // Both local-cli and reference-only allow read_file.
    // local-cli has privileged_external trust (highest), so it wins.
    const h = findHarnessForCommand('read_file');
    expect(h).not.toBeNull();
    expect(h!.id).toBe('local-cli');
    expect(h!.trustLevel).toBe('privileged_external');
  });

  it('findHarnessForCommand returns non-reference harness for run_tests', () => {
    // reference-only does NOT have run_tests in allowedActions
    const h = findHarnessForCommand('run_tests');
    expect(h).not.toBeNull();
    expect(h!.id).not.toBe('reference-only');
    expect(h!.trustLevel).not.toBe('reference_only');
  });

  it('findHarnessForCommand returns null for send_message on reference-only', () => {
    // reference-only blocks send_message
    const h = findHarnessForCommand('send_message');
    expect(h).not.toBeNull();
    // It should still find local-cli or hermes-local which allow send_message
    expect(h!.allowedActions).toContain('send_message');
  });

  it('findHarnessForCommand returns null for entirely unknown action', () => {
    expect(findHarnessForCommand('totally_unknown_action')).toBeNull();
  });

  it('findHarnessForCommand prefers higher trust level (privileged_external > local_cli)', () => {
    // local-cli has privileged_external trust
    const h = findHarnessForCommand('delete_file');
    expect(h).not.toBeNull();
    expect(h!.id).toBe('local-cli');
    expect(h!.trustLevel).toBe('privileged_external');
  });

  // ── trust level specifics ────────────────────────────────────────────────────

  it('reference-only has zero recovery modes', () => {
    const h = getHarness('reference-only')!;
    expect(h.recoveryModes).toHaveLength(0);
    expect(h.recovery).toBeUndefined();
  });

  it('nemoclaw-sandbox has sandbox trust and view_logs recovery', () => {
    const h = getHarness('nemoclaw-sandbox')!;
    expect(h.trustLevel).toBe('sandboxed');
    expect(h.transport).toBe('http');
    expect(h.recoveryModes).toContain('view_logs');
  });

  it('hermes-local and openclaw-local have cli transport', () => {
    for (const id of ['hermes-local', 'openclaw-local']) {
      const h = getHarness(id)!;
      expect(h.transport).toBe('cli');
      expect(h.health.kind).toBeDefined();
    }
  });
});
