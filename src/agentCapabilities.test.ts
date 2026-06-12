// ─── Tests for agentCapabilities — source of truth is the bridge snapshot ───
// We mock the snapshot directly. The 6 contract assertions below cover the
// shape: stripping suffix, harness-keyed capability lookup, repo restrictions,
// skill badge construction. Everything else is exercised by integration
// tests that hit the real bridge.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  agentCanDo,
  repoAllows,
  canExecute,
  getSkillBadges,
  agentBase,
} from './agentCapabilities.ts';
import {
  setCapabilitiesSnapshotForTesting,
  resetCapabilitiesSnapshotForTesting,
  type CapabilitiesSnapshot,
} from './capabilitiesClient.ts';

const SNAPSHOT: CapabilitiesSnapshot = {
  agents: {
    hermes: {
      capabilities: [
        'inspect_repo', 'read_file', 'run_tests', 'run_build',
        'edit_file', 'create_branch', 'git_commit',
        'execute_agent', 'quest_add', 'unit_command', 'e2e_probe',
        'send_message',
      ],
      skills: ['orchestration', 'git_workflow', 'test_runner', 'code_editor', 'messaging'],
      skillLabels: {
        orchestration: 'Orquestación',
        git_workflow: 'Git completo',
        test_runner: 'Tests',
        code_editor: 'Edición',
        messaging: 'Mensajería',
      },
    },
    codex: {
      capabilities: ['inspect_repo', 'read_file', 'run_tests', 'run_build', 'edit_file', 'create_branch'],
      skills: ['git_workflow', 'test_runner', 'code_editor'],
      skillLabels: {
        git_workflow: 'Git completo',
        test_runner: 'Tests',
        code_editor: 'Edición',
      },
    },
    scout: {
      capabilities: ['inspect_repo', 'read_file'],
      skills: ['inspection'],
      skillLabels: { inspection: 'Inspección' },
    },
    openclaw: {
      capabilities: ['inspect_repo', 'read_file', 'run_tests', 'run_build', 'execute_agent'],
      skills: ['transport', 'orchestration', 'test_runner'],
      skillLabels: {
        transport: 'Transporte',
        orchestration: 'Orquestación',
        test_runner: 'Tests',
      },
    },
  },
  repoRestrictions: {
    legal: ['inspect_repo', 'read_file'],
    vault: ['inspect_repo', 'read_file'],
    secrets: ['inspect_repo', 'read_file'],
  },
  skillRequirements: {},
};

beforeEach(() => {
  resetCapabilitiesSnapshotForTesting();
  setCapabilitiesSnapshotForTesting(SNAPSHOT);
});

describe('agentBase', () => {
  it('strips suffix from suffixed id', () => expect(agentBase('hermes-2')).toBe('hermes'));
  it('lowercases then matches uppercased keys', () => expect(agentBase('HERMES')).toBe('HERMES'));
  it('returns base when there is no suffix', () => expect(agentBase('codex')).toBe('codex'));
  it('handles multi-digit suffix', () => expect(agentBase('hermes-42')).toBe('hermes'));
});

describe('agentCanDo', () => {
  it('hermes (full set) can do everything in its capability list', () => {
    const hermesCaps = SNAPSHOT.agents.hermes!.capabilities;
    for (const cap of hermesCaps) {
      expect(agentCanDo('hermes', cap as never)).toBe(true);
    }
  });

  it('scout can only inspect and read', () => {
    expect(agentCanDo('scout', 'inspect_repo')).toBe(true);
    expect(agentCanDo('scout', 'read_file')).toBe(true);
    expect(agentCanDo('scout', 'run_tests')).toBe(false);
    expect(agentCanDo('scout', 'edit_file')).toBe(false);
    expect(agentCanDo('scout', 'git_commit')).toBe(false);
  });

  it('codex (no messaging, no orchestration) reflects that', () => {
    expect(agentCanDo('codex', 'edit_file')).toBe(true);
    expect(agentCanDo('codex', 'git_commit')).toBe(false);
    expect(agentCanDo('codex', 'execute_agent')).toBe(false);
    expect(agentCanDo('codex', 'send_message')).toBe(false);
  });

  it('openclaw cannot edit but can execute_agent', () => {
    expect(agentCanDo('openclaw', 'edit_file')).toBe(false);
    expect(agentCanDo('openclaw', 'execute_agent')).toBe(true);
  });

  it('unknown agent returns false (fail-closed)', () => {
    expect(agentCanDo('unknown-agent', 'edit_file')).toBe(false);
  });

  it('handles suffixed agent IDs', () => {
    expect(agentCanDo('scout-2', 'edit_file')).toBe(false);
    expect(agentCanDo('hermes-3', 'run_tests')).toBe(true);
  });

  it('case-insensitive lookup (HERMES-1 → hermes entry)', () => {
    expect(agentCanDo('HERMES-1', 'git_commit')).toBe(true);
  });
});

describe('repoAllows', () => {
  it('allows all ops on a normal repo', () => {
    expect(repoAllows('my-app', 'edit_file')).toBe(true);
    expect(repoAllows('my-app', 'git_commit')).toBe(true);
  });

  it('restricts legal repo to reads only', () => {
    expect(repoAllows('legal-contracts', 'inspect_repo')).toBe(true);
    expect(repoAllows('legal-contracts', 'read_file')).toBe(true);
    expect(repoAllows('legal-contracts', 'edit_file')).toBe(false);
    expect(repoAllows('legal-contracts', 'git_commit')).toBe(false);
  });

  it('restricts vault repo', () => {
    expect(repoAllows('org-vault', 'run_tests')).toBe(false);
    expect(repoAllows('org-vault', 'read_file')).toBe(true);
  });

  it('restricts secrets repo', () => {
    expect(repoAllows('secrets-store', 'edit_file')).toBe(false);
  });
});

describe('canExecute', () => {
  it('scout on normal repo: inspect ok, edit blocked by capability', () => {
    expect(canExecute('scout', 'inspect_repo', 'my-repo')).toBe(true);
    expect(canExecute('scout', 'edit_file', 'my-repo')).toBe(false);
  });

  it('hermes on legal repo: inspect ok, edit blocked by repo restriction', () => {
    expect(canExecute('hermes', 'inspect_repo', 'legal-docs')).toBe(true);
    expect(canExecute('hermes', 'edit_file', 'legal-docs')).toBe(false);
  });

  it('codex on vault: even run_tests blocked', () => {
    expect(canExecute('codex', 'run_tests', 'vault-keys')).toBe(false);
  });
});

describe('getSkillBadges', () => {
  it('returns badges for hermes with all 5 skill keys', () => {
    const badges = getSkillBadges('hermes');
    expect(badges.length).toBe(5);
    expect(badges.every((b) => b.key && b.label && b.icon)).toBe(true);
    expect(badges.map((b) => b.key).sort()).toEqual(
      ['code_editor', 'git_workflow', 'messaging', 'orchestration', 'test_runner'].sort(),
    );
  });

  it('scout only has inspection badge', () => {
    const badges = getSkillBadges('scout');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.key).toBe('inspection');
    expect(badges[0]!.icon).toBe('🔍');
  });

  it('openclaw has transport, orchestration, test_runner', () => {
    const badges = getSkillBadges('openclaw');
    expect(badges.map((b) => b.key)).toEqual(
      ['transport', 'orchestration', 'test_runner'],
    );
  });

  it('handles suffixed id (hermes-2 → hermes badges)', () => {
    expect(getSkillBadges('hermes-2')).toEqual(getSkillBadges('hermes'));
  });

  it('returns empty array for unknown agent (no silent fallback)', () => {
    expect(getSkillBadges('mystery-agent')).toEqual([]);
  });
});
