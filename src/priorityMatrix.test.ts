import { describe, it, expect } from 'vitest';
import {
  priorityScore,
  scoreToPriority,
  prioritizeMission,
  sortByPriority,
  peekNextMission,
} from './priorityMatrix.ts';
import type { LocalMission } from './types.ts';

function makeMission(overrides: Partial<LocalMission> = {}): LocalMission {
  return {
    id: 'test-1',
    unitId: 'davi',
    repoId: 'repociv',
    filePath: '/repos/repociv/src/foo.ts',
    fileName: 'foo.ts',
    status: 'queued',
    assignedAt: Date.now(),
    startedAt: null,
    completedAt: null,
    workbenchId: 'wb-1',
    workbench: null,
    progress: 0,
    ...overrides,
  };
}

describe('priorityScore', () => {
  it('returns a number', () => {
    const m = makeMission();
    const score = priorityScore(m, Date.now());
    expect(typeof score).toBe('number');
  });

  it('older missions get higher score (age weight)', () => {
    const now = Date.now();
    const fresh = makeMission({ assignedAt: now - 1_000 });
    const old = makeMission({ assignedAt: now - 120 * 60_000 }); // 2h ago
    expect(priorityScore(old, now)).toBeGreaterThan(priorityScore(fresh, now));
  });

  it('test files get a score boost', () => {
    const now = Date.now();
    const base = makeMission({ fileName: 'foo.ts', filePath: '/src/foo.ts' });
    const test = makeMission({ fileName: 'foo.test.ts', filePath: '/src/foo.test.ts' });
    expect(priorityScore(test, now)).toBeGreaterThan(priorityScore(base, now));
  });

  it('spec files also get boost', () => {
    const now = Date.now();
    const base = makeMission({ fileName: 'utils.ts', filePath: '/src/utils.ts' });
    const spec = makeMission({ fileName: 'utils.spec.ts', filePath: '/src/utils.spec.ts' });
    expect(priorityScore(spec, now)).toBeGreaterThan(priorityScore(base, now));
  });

  it('ts extension scores higher than yml', () => {
    const now = Date.now();
    const ts = makeMission({ fileName: 'main.ts', filePath: '/src/main.ts' });
    const yml = makeMission({ fileName: 'ci.yml', filePath: '/ci.yml' });
    expect(priorityScore(ts, now)).toBeGreaterThan(priorityScore(yml, now));
  });

  it('debt path gets higher score than normal path', () => {
    const now = Date.now();
    const normal = makeMission({ filePath: '/repos/repociv/src/utils.ts' });
    const debt = makeMission({ filePath: '/repos/repociv/legacy/old.ts' });
    expect(priorityScore(debt, now)).toBeGreaterThan(priorityScore(normal, now));
  });

  it('returns 2 decimal places max', () => {
    const score = priorityScore(makeMission(), Date.now());
    const decimals = (score.toString().split('.')[1] ?? '').length;
    expect(decimals).toBeLessThanOrEqual(2);
  });
});

describe('scoreToPriority', () => {
  it('critical for score >= 60', () => {
    expect(scoreToPriority(60)).toBe('critical');
    expect(scoreToPriority(100)).toBe('critical');
  });

  it('high for score in [35, 60)', () => {
    expect(scoreToPriority(35)).toBe('high');
    expect(scoreToPriority(59)).toBe('high');
  });

  it('normal for score in [15, 35)', () => {
    expect(scoreToPriority(15)).toBe('normal');
    expect(scoreToPriority(34)).toBe('normal');
  });

  it('low for score < 15', () => {
    expect(scoreToPriority(0)).toBe('low');
    expect(scoreToPriority(14)).toBe('low');
    expect(scoreToPriority(-5)).toBe('low');
  });
});

describe('prioritizeMission', () => {
  it('returns a PrioritizedMission with score and priority', () => {
    const m = makeMission();
    const pm = prioritizeMission(m);
    expect(typeof pm.score).toBe('number');
    expect(['critical', 'high', 'normal', 'low']).toContain(pm.priority);
  });

  it('preserves original mission fields', () => {
    const m = makeMission({ id: 'abc-99', repoId: 'myrepo' });
    const pm = prioritizeMission(m);
    expect(pm.id).toBe('abc-99');
    expect(pm.repoId).toBe('myrepo');
  });
});

describe('sortByPriority', () => {
  it('returns empty array for empty input', () => {
    expect(sortByPriority([])).toHaveLength(0);
  });

  it('sorts highest score first', () => {
    const now = Date.now();
    const missions = [
      makeMission({ id: 'fresh', assignedAt: now - 500 }),
      makeMission({
        id: 'old',
        assignedAt: now - 200 * 60_000,
        fileName: 'x.test.ts',
        filePath: '/src/x.test.ts',
      }),
      makeMission({ id: 'mid', assignedAt: now - 30 * 60_000 }),
    ];
    const sorted = sortByPriority(missions, now);
    expect(sorted[0]!.score).toBeGreaterThanOrEqual(sorted[1]!.score);
    expect(sorted[1]!.score).toBeGreaterThanOrEqual(sorted[2]!.score);
  });

  it('does not mutate original array', () => {
    const missions = [makeMission({ id: 'a' }), makeMission({ id: 'b' })];
    const copy = [...missions];
    sortByPriority(missions);
    expect(missions[0]!.id).toBe(copy[0]!.id);
  });
});

describe('peekNextMission', () => {
  it('returns null for empty queue', () => {
    expect(peekNextMission([])).toBeNull();
  });

  it('returns the highest-priority mission', () => {
    const now = Date.now();
    const missions = [
      makeMission({ id: 'low', assignedAt: now - 1_000 }),
      makeMission({
        id: 'high',
        assignedAt: now - 150 * 60_000,
        fileName: 'y.test.ts',
        filePath: '/src/y.test.ts',
      }),
    ];
    const next = peekNextMission(missions, now);
    expect(next?.id).toBe('high');
  });
});
