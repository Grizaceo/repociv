import { describe, expect, it } from 'vitest';
import { parsePendingWork, renderPendingWork, type PendingWorkEntry } from './pendingWork.ts';

export function entry(overrides: Partial<PendingWorkEntry> = {}): PendingWorkEntry {
  return {
    repoPath: '/repos/demo',
    repoName: 'demo',
    worktreePath: '/repos/demo',
    branch: 'main',
    detached: false,
    head: 'abc123',
    state: 'dirty',
    stagedCount: 0,
    unstagedCount: 1,
    untrackedCount: 0,
    conflictCount: 0,
    changedCount: 1,
    files: [{ path: 'file.ts', index: ' ', worktree: 'M' }],
    firstObservedAtMs: 1000,
    lastObservedAtMs: 61000,
    ageMs: 60000,
    relatedSessions: [],
    ...overrides,
  };
}
const snapshot = (entries: PendingWorkEntry[]) => ({
  available: true,
  sampledAtMs: 61000,
  entries,
  errors: [],
});

describe('pending work presentation', () => {
  it('rejects malformed responses instead of inventing an empty/clean inventory', () => {
    expect(() => parsePendingWork({ available: true })).toThrow();
    expect(() => parsePendingWork(snapshot([entry({ changedCount: -1 })]))).toThrow();
    expect(() => parsePendingWork(snapshot([entry({ firstObservedAtMs: NaN })]))).toThrow();
    expect(parsePendingWork(snapshot([])).entries).toEqual([]);
  });
  it('prioritizes conflicts, then oldest observed dirty work, and puts clean last', () => {
    const entries = [
      entry({ state: 'clean', worktreePath: '/clean', changedCount: 0 }),
      entry({ worktreePath: '/new', firstObservedAtMs: 50000 }),
      entry({ worktreePath: '/old', firstObservedAtMs: 1000 }),
      entry({ worktreePath: '/conflict', conflictCount: 1, firstObservedAtMs: 60000 }),
    ];
    const html = renderPendingWork(snapshot(entries), '');
    expect(html.indexOf('/conflict')).toBeLessThan(html.indexOf('/old'));
    expect(html.indexOf('/old')).toBeLessThan(html.indexOf('/new'));
    expect(html.indexOf('/new')).toBeLessThan(html.indexOf('/clean'));
    expect(html).toContain('3 worktrees con cambios');
  });
  it('labels observation and related sessions without claiming authorship or abandonment', () => {
    const html = renderPendingWork(
      snapshot([
        entry({
          relatedSessions: [
            { id: 'session', name: 'DAVI', status: 'idle', lastActivityAtMs: 1000 },
          ],
        }),
      ]),
      '',
    );
    expect(html).toContain('Observado con cambios desde');
    expect(html).toContain('Sesiones relacionadas');
    expect(html).toContain('no acredita autoría');
    expect(html).not.toContain('Autor: DAVI');
    expect(html).not.toContain('abandonado');
    expect(html).toContain('DAVI');
  });
  it('escapes paths, branch names, files, session names and error messages', () => {
    const html = renderPendingWork(
      snapshot([
        entry({
          branch: '<img src=x>',
          worktreePath: '/<svg onload=x>',
          files: [{ path: '<script>x</script>', index: '?', worktree: '?' }],
          relatedSessions: [{ id: '<x>', name: '<img>', status: 'idle', lastActivityAtMs: null }],
        }),
      ]),
      '<script>network</script>',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).toContain('&lt;script&gt;');
  });
  it('retains stale data, identifies partial and persistence failures, never labels them clean', () => {
    const data = snapshot([
      entry(),
      entry({
        state: 'unavailable',
        worktreePath: '/failed',
        error: 'Git no disponible',
        firstObservedAtMs: null,
        ageMs: null,
      }),
    ]);
    const html = renderPendingWork(
      { ...data, errors: ['Fallo parcial'], persistenceError: 'No se pudo guardar' },
      'HTTP 503',
    );
    expect(html).toContain('posiblemente desactualizados');
    expect(html).toContain('Git no disponible');
    expect(html).toContain('Fallo parcial');
    expect(html).toContain('No se pudo guardar');
    expect(html).toContain('Estado Git no disponible');
    expect(renderPendingWork(null, 'HTTP 404')).not.toContain('Sin cambios sin commit');
  });
  it('labels retained unavailable age and capped file lists explicitly', () => {
    const html = renderPendingWork(
      snapshot([entry({ state: 'unavailable', error: 'Git offline', changedCount: 300 })]),
      '',
    );
    expect(html).toContain('Último episodio conocido');
    expect(html).toContain('no confirma el estado actual');
    expect(html).toContain('Archivos · 1 de 300 — lista limitada');
    expect(html).not.toContain('300 archivos con cambios');
  });
  it('shows every pending worktree and file, and labels detached heads explicitly', () => {
    const entries = Array.from({ length: 75 }, (_, i) => entry({ worktreePath: `/repo-${i}` }));
    const html = renderPendingWork(snapshot(entries), '');
    expect(html.match(/class="pending-work-card"/g)).toHaveLength(75);
    expect(renderPendingWork(snapshot([entry({ detached: true, branch: '' })]), '')).toContain(
      'HEAD separado',
    );
  });
});
