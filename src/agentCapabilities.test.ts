import { describe, it, expect } from 'vitest';
import {
  agentCanDo,
  repoAllows,
  canExecute,
  getSkillBadges,
  AGENT_CAPABILITIES,
  agentBase,
} from './agentCapabilities.ts';

describe('agentBase', () => {
  it('strips suffix from DAVI-2', () => expect(agentBase('DAVI-2')).toBe('DAVI'));
  it('lowercases then uppercases', () => expect(agentBase('worker')).toBe('WORKER'));
  it('falls back to DAVI for unknown agent', () => expect(agentBase('HERMES')).toBe('DAVI'));
});

describe('agentCanDo', () => {
  it('DAVI can do everything', () => {
    for (const cap of AGENT_CAPABILITIES.DAVI) {
      expect(agentCanDo('DAVI', cap as never)).toBe(true);
    }
  });

  it('SCOUT can only inspect_repo and read_file', () => {
    expect(agentCanDo('SCOUT', 'inspect_repo')).toBe(true);
    expect(agentCanDo('SCOUT', 'read_file')).toBe(true);
    expect(agentCanDo('SCOUT', 'run_tests')).toBe(false);
    expect(agentCanDo('SCOUT', 'edit_file')).toBe(false);
    expect(agentCanDo('SCOUT', 'git_commit')).toBe(false);
  });

  it('LEXO cannot orchestrate or message', () => {
    expect(agentCanDo('LEXO', 'execute_agent')).toBe(false);
    expect(agentCanDo('LEXO', 'send_message')).toBe(false);
    expect(agentCanDo('LEXO', 'unit_command')).toBe(false);
  });

  it('LEXO can edit and commit', () => {
    expect(agentCanDo('LEXO', 'edit_file')).toBe(true);
    expect(agentCanDo('LEXO', 'git_commit')).toBe(true);
  });

  it('WORKER cannot commit', () => {
    expect(agentCanDo('WORKER', 'git_commit')).toBe(false);
    expect(agentCanDo('WORKER', 'edit_file')).toBe(true);
  });

  it('OPENCLAW cannot edit but can execute_agent', () => {
    expect(agentCanDo('OPENCLAW', 'edit_file')).toBe(false);
    expect(agentCanDo('OPENCLAW', 'execute_agent')).toBe(true);
  });

  it('CURSOR mirrors coding-agent capabilities', () => {
    expect(agentCanDo('CURSOR', 'edit_file')).toBe(true);
    expect(agentCanDo('CURSOR', 'git_commit')).toBe(true);
    expect(agentCanDo('CURSOR', 'execute_agent')).toBe(true);
  });

  it('handles suffixed agent IDs', () => {
    expect(agentCanDo('SCOUT-2', 'edit_file')).toBe(false);
    expect(agentCanDo('WORKER-3', 'run_tests')).toBe(true);
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
  it('SCOUT on normal repo: inspect ok, edit blocked', () => {
    expect(canExecute('SCOUT', 'inspect_repo', 'my-repo')).toBe(true);
    expect(canExecute('SCOUT', 'edit_file', 'my-repo')).toBe(false);
  });

  it('DAVI on legal repo: inspect ok, edit blocked by repo', () => {
    expect(canExecute('DAVI', 'inspect_repo', 'legal-docs')).toBe(true);
    expect(canExecute('DAVI', 'edit_file', 'legal-docs')).toBe(false);
  });

  it('WORKER on vault: even run_tests blocked', () => {
    expect(canExecute('WORKER', 'run_tests', 'vault-keys')).toBe(false);
  });
});

describe('getSkillBadges', () => {
  it('returns badges for DAVI', () => {
    const badges = getSkillBadges('DAVI');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.every((b) => b.key && b.label && b.icon)).toBe(true);
  });

  it('SCOUT only has inspection badge', () => {
    const badges = getSkillBadges('SCOUT');
    expect(badges).toHaveLength(1);
    expect(badges[0]!.key).toBe('inspection');
  });

  it('CURSOR has coding + orchestration badges', () => {
    const badges = getSkillBadges('CURSOR');
    expect(badges.map((b) => b.key)).toEqual([
      'git_workflow',
      'test_runner',
      'code_editor',
      'orchestration',
    ]);
  });

  it('handles suffixed ID', () => {
    expect(getSkillBadges('LEXO-2')).toEqual(getSkillBadges('LEXO'));
  });
});
