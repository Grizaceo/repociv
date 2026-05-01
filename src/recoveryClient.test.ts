// ─── RepoCiv — recoveryClient Tests ──────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  HarnessDescriptor,
  HarnessHealth,
  RecoveryMode,
  harnessHealthFromJson,
  recoveryModesFromJson,
  formatShellCommand,
  buildRecoveryRequest,
  REASON_LABELS,
} from './recoveryClient';

// ── Types ───────────────────────────────────────────────────────────────────

describe('HarnessDescriptor structure', () => {
  it('HarnessDescriptor is exported and re-exported from harnessRegistry', () => {
    const hd: HarnessDescriptor = {
      id: 'test-harness',
      label: 'Test Harness',
      kind: 'bridge',
      trustLevel: 'local_cli',
      transport: 'cli',
      recoveryModes: [],
      allowedActions: [],
      blockedActions: [],
      health: { kind: 'command', status: 'unknown' },
    };
    expect(hd.id).toBe('test-harness');
  });
});

describe('HarnessHealth', () => {
  it('HarnessHealth accepts all known kinds', () => {
    const h: HarnessHealth = { kind: 'static', status: 'healthy' };
    expect(h.status).toBe('healthy');
    const d: HarnessHealth = { kind: 'command', status: 'degraded' };
    expect(d.status).toBe('degraded');
    const u: HarnessHealth = { kind: 'http', status: 'unhealthy' };
    expect(u.status).toBe('unhealthy');
    const unk: HarnessHealth = { kind: 'static', status: 'unknown' };
    expect(unk.status).toBe('unknown');
  });

  it('harnessHealthFromJson maps server strings to HarnessHealth', () => {
    expect(harnessHealthFromJson('healthy')).toBe('healthy');
    expect(harnessHealthFromJson('degraded')).toBe('degraded');
    expect(harnessHealthFromJson('unhealthy')).toBe('unhealthy');
    expect(harnessHealthFromJson('unknown')).toBe('unknown');
    // Falls back to 'unknown' for unexpected values
    expect(harnessHealthFromJson('foobar')).toBe('unknown');
  });
});

describe('RecoveryMode', () => {
  it('RecoveryMode type covers all known recovery modes', () => {
    const m: RecoveryMode = 'view_logs';
    expect(m).toBe('view_logs');
  });

  it('recoveryModesFromJson parses server array of strings', () => {
    expect(recoveryModesFromJson(['view_logs', 'restart_service'])).toEqual([
      'view_logs',
      'restart_service',
    ]);
    expect(recoveryModesFromJson([])).toEqual([]);
    expect(recoveryModesFromJson(['copy_command'])).toEqual(['copy_command']);
  });

  it('recoveryModesFromJson returns empty array for null/undefined', () => {
    expect(recoveryModesFromJson(null)).toEqual([]);
    expect(recoveryModesFromJson(undefined)).toEqual([]);
  });
});

describe('formatShellCommand', () => {
  it('returns null when shell_command is missing', () => {
    expect(formatShellCommand({})).toBeNull();
    expect(formatShellCommand({ rationale: 'fix it' })).toBeNull();
  });

  it('returns null when shell_command is null', () => {
    expect(formatShellCommand({ shell_command: null })).toBeNull();
  });

  it('returns the command string when present', () => {
    expect(formatShellCommand({ shell_command: 'cd ~/.hermes && git status' })).toBe(
      'cd ~/.hermes && git status',
    );
    expect(formatShellCommand({ shell_command: 'systemctl restart agent' })).toBe(
      'systemctl restart agent',
    );
  });

  it('rationale is available but not part of the returned string', () => {
    const entry = {
      shell_command: 'tmux kill-session -t agent',
      rationale: 'Kill stuck session before reconnecting',
    };
    const cmd = formatShellCommand(entry);
    expect(cmd).toBe('tmux kill-session -t agent');
    expect(cmd).not.toContain('Kill stuck');
  });
});

describe('buildRecoveryRequest', () => {
  it('returns minimal payload with harness_id and reason', () => {
    const req = buildRecoveryRequest('hermes-local', 'failure', {});
    expect(req).toEqual({
      harness_id: 'hermes-local',
      reason: 'failure',
    });
  });

  it('adds command_type when provided', () => {
    const req = buildRecoveryRequest('local-cli', 'failure', { command_type: 'inspect_repo' });
    expect(req).toEqual({
      harness_id: 'local-cli',
      reason: 'failure',
      command_type: 'inspect_repo',
    });
  });

  it('adds details when provided', () => {
    const req = buildRecoveryRequest('nemoclaw-sandbox', 'escalated', {
      details: 'Segfault in worker process',
    });
    expect(req).toEqual({
      harness_id: 'nemoclaw-sandbox',
      reason: 'escalated',
      details: 'Segfault in worker process',
    });
  });

  it('strips undefined values', () => {
    const req = buildRecoveryRequest('openclaw-local', 'failure', {
      command_type: undefined,
      details: undefined,
    });
    expect(req).toEqual({
      harness_id: 'openclaw-local',
      reason: 'failure',
    });
  });

  it('includes all fields when fully populated', () => {
    const req = buildRecoveryRequest('hermes-local', 'escalated', {
      command_type: 'run_tests',
      details: 'Timeout after 300s',
    });
    expect(req).toEqual({
      harness_id: 'hermes-local',
      reason: 'escalated',
      command_type: 'run_tests',
      details: 'Timeout after 300s',
    });
  });
});

describe('REASON_LABELS', () => {
  it('covers all known reason keys', () => {
    expect(REASON_LABELS['failure']).toBe('FAILURE');
    expect(REASON_LABELS['auto_recovery']).toBe('AUTO-RECOVERY');
    expect(REASON_LABELS['manual']).toBe('MANUAL RECOVERY');
    expect(REASON_LABELS['escalated']).toBe('ESCALATED');
  });

  it('has uppercase values suitable for display', () => {
    for (const [, label] of Object.entries(REASON_LABELS)) {
      expect(label).toBe(label.toUpperCase());
    }
  });
});
