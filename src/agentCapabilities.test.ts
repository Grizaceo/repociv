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
  it('strips suffix from MAIN-2', () => expect(agentBase('MAIN-2')).toBe('MAIN'));
  it('lowercases then uppercases', () => expect(agentBase('worker')).toBe('WORKER'));
  it('falls back to MAIN for unknown agent', () => expect(agentBase('HERMES')).toBe('MAIN'));
});

describe('agentCanDo', () => {
  it('every shipped non-MAIN agent can do its declared capabilities', () => {
    for (const [agent, caps] of Object.entries(AGENT_CAPABILITIES)) {
      if (agent === 'MAIN') continue; // MAIN is harness-driven, tested separately
      for (const cap of caps) {
        expect(agentCanDo(agent, cap as never)).toBe(true);
      }
    }
  });

  it('MAIN has no fixed capabilities (resolved at runtime from harness)', () => {
    // AGENT_CAPABILITIES.MAIN is intentionally an empty list — the live
    // capabilities are surfaced by server/capabilities.py:capabilities_snapshot
    // after the user picks a harness during onboarding.
    expect(AGENT_CAPABILITIES.MAIN).toEqual([]);
  });

  it('SCOUT can only inspect_repo and read_file', () => {
    expect(agentCanDo('SCOUT', 'inspect_repo')).toBe(true);
    expect(agentCanDo('SCOUT', 'read_file')).toBe(true);
    expect(agentCanDo('SCOUT', 'run_tests')).toBe(false);
    expect(agentCanDo('SCOUT', 'edit_file')).toBe(false);
    expect(agentCanDo('SCOUT', 'git_commit')).toBe(false);
  });

  it('WORKER cannot commit, message, or orchestrate', () => {
    expect(agentCanDo('WORKER', 'git_commit')).toBe(false);
    expect(agentCanDo('WORKER', 'execute_agent')).toBe(false);
    expect(agentCanDo('WORKER', 'send_message')).toBe(false);
    expect(agentCanDo('WORKER', 'unit_command')).toBe(false);
  });

  it('WORKER can edit and run tests/builds', () => {
    expect(agentCanDo('WORKER', 'edit_file')).toBe(true);
    expect(agentCanDo('WORKER', 'create_branch')).toBe(true);
    expect(agentCanDo('WORKER', 'run_tests')).toBe(true);
    expect(agentCanDo('WORKER', 'run_build')).toBe(true);
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

  it('MAIN on legal repo: edit blocked by repo restriction', () => {
    // MAIN has no fixed capabilities locally — they are served by the bridge
    // from the user's chosen harness. canExecute('MAIN', ...) returns false
    // until the harness is selected. The repo restriction is enforced either
    // way.
    expect(canExecute('MAIN', 'inspect_repo', 'legal-docs')).toBe(false);
    expect(canExecute('MAIN', 'edit_file', 'legal-docs')).toBe(false);
  });

  it('SCOUT on legal repo: inspect ok, edit blocked by repo restriction', () => {
    // SCOUT is a built-in with fixed capabilities — it can inspect.
    expect(canExecute('SCOUT', 'inspect_repo', 'legal-docs')).toBe(true);
    expect(canExecute('SCOUT', 'edit_file', 'legal-docs')).toBe(false);
  });

  it('WORKER on vault: even run_tests blocked', () => {
    expect(canExecute('WORKER', 'run_tests', 'vault-keys')).toBe(false);
  });
});

describe('getSkillBadges', () => {
  it('returns no badges for MAIN (resolved at runtime)', () => {
    // AGENT_SKILLS.MAIN is empty until the user picks a harness. The live
    // skill set is served by /api/agents/capabilities.
    expect(getSkillBadges('MAIN')).toEqual([]);
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
    expect(getSkillBadges('MAIN-2')).toEqual(getSkillBadges('MAIN'));
  });
});
