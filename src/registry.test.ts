// ─── RepoCiv — Registry unit tests ─────────────────────────────────────────
// Minimal smoke tests for the extracted MissionRegistry and
// SubagentRegistry. The full integration is covered by game.test.ts
// (if present) and the renderer/bridge integration tests; here we just
// pin down the contracts the registries guarantee.

import { describe, it, expect, vi } from 'vitest';
import { MissionRegistry } from './missionLifecycle.ts';
import { SubagentRegistry } from './subagentManager.ts';
import type { SubagentRun } from './types.ts';

function makeMissionCtx() {
  const notify = vi.fn();
  const reg = new MissionRegistry({ active: new Map() }, { notify });
  return { reg, active: reg.s.active, notify };
}

function makeSubagentCtx() {
  const active = new Map<string, SubagentRun>();
  const completed: SubagentRun[] = [];
  const progress = new Map<string, string[]>();
  const notify = vi.fn();
  const removeUnit = vi.fn(() => true);
  const removeLocalUnit = vi.fn();
  const clearHighlight = vi.fn();
  let highlighted: string | null = null;
  const reg = new SubagentRegistry(
    { active, completed, progress, highlighted: null },
    { notify, removeUnit, removeLocalUnit, clearHighlight },
  );
  // Wire the highlighted property through a setter so the registry's
  // writes are visible (it uses a value, not a ref).
  Object.defineProperty(reg.s, 'highlighted', {
    get: () => highlighted,
    set: (v) => {
      highlighted = v;
    },
  });
  return { reg, active, completed, progress, notify, removeUnit, removeLocalUnit, clearHighlight };
}

describe('MissionRegistry', () => {
  it('start inserts a running mission and notifies', () => {
    const { reg, active, notify } = makeMissionCtx();
    reg.start('m1', 'MAIN', 'Test quest');
    expect(active.size).toBe(1);
    const m = active.get('m1')!;
    expect(m.status).toBe('running');
    expect(m.unit).toBe('MAIN');
    expect(m.questName).toBe('Test quest');
    expect(m.completedAt).toBeNull();
    expect(typeof m.startedAt).toBe('number');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('complete marks a running mission as complete and notifies', () => {
    const { reg, active, notify } = makeMissionCtx();
    reg.start('m1', 'MAIN', 'Test');
    reg.complete('m1', true);
    expect(active.get('m1')!.status).toBe('complete');
    expect(typeof active.get('m1')!.completedAt).toBe('number');
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('complete marks a running mission as failed', () => {
    const { reg, active } = makeMissionCtx();
    reg.start('m1', 'MAIN', 'Test');
    reg.complete('m1', false);
    expect(active.get('m1')!.status).toBe('failed');
  });

  it('complete on a missing mission is a silent no-op', () => {
    const { notify } = makeMissionCtx();
    notify.mockClear();
    // No mission started — complete on a missing id should not throw,
    // should not notify.
    new MissionRegistry({ active: new Map() }, { notify }).complete('nope', false);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('SubagentRegistry', () => {
  function makeRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
    return {
      id: 's1',
      parentUnitId: 'MAIN',
      parentMissionId: 'm1',
      kind: 'worker',
      label: 'Test',
      status: 'running',
      risk: 'low',
      ephemeralUnitId: 'eu-1',
      targetCityId: 'city-1',
      startedAt: Date.now(),
      unitType: 'worker',
      parentHarness: 'hermes',
      harness: 'hermes',
      lastProgressAt: Date.now(),
      ...overrides,
    };
  }

  it('register inserts a run and notifies', () => {
    const { reg, active, notify } = makeSubagentCtx();
    reg.register(makeRun());
    expect(active.size).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('update merges a patch into the existing run', () => {
    const { reg, active, notify } = makeSubagentCtx();
    reg.register(makeRun());
    reg.update('s1', { status: 'complete', summary: 'done' });
    const run = active.get('s1')!;
    expect(run.status).toBe('complete');
    expect(run.summary).toBe('done');
    expect(run.parentUnitId).toBe('MAIN'); // preserved
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('update on a missing id is a silent no-op', () => {
    const { notify } = makeSubagentCtx();
    notify.mockClear();
    new SubagentRegistry(
      { active: new Map(), completed: [], progress: new Map(), highlighted: null },
      {
        notify,
        removeUnit: () => true,
        removeLocalUnit: () => {},
        clearHighlight: () => {},
      },
    ).update('nope', { status: 'complete' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('appendProgress caps the buffer at 20 and updates lastProgressAt', () => {
    const { reg, active, progress } = makeSubagentCtx();
    reg.register(makeRun());
    for (let i = 0; i < 25; i++) reg.appendProgress('s1', `step ${i}`);
    const buf = progress.get('s1')!;
    expect(buf.length).toBe(20);
    expect(buf[0]).toBe('step 5');
    expect(buf[19]).toBe('step 24');
    expect(active.get('s1')!.lastProgressAt).toBeGreaterThan(0);
  });

  it('complete moves the run to the completed list and cleans up', () => {
    const { reg, active, completed, removeUnit, removeLocalUnit, clearHighlight, notify } =
      makeSubagentCtx();
    reg.register(makeRun());
    reg.complete('s1', true, 'all good');
    expect(active.size).toBe(0);
    expect(completed.length).toBe(1);
    expect(completed[0]!.status).toBe('complete');
    expect(completed[0]!.summary).toBe('all good');
    expect(removeUnit).toHaveBeenCalledWith('eu-1');
    expect(removeLocalUnit).toHaveBeenCalledWith('eu-1');
    expect(clearHighlight).toHaveBeenCalledWith('s1');
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('cancel moves the run to completed with status cancelled', () => {
    const { reg, active, completed } = makeSubagentCtx();
    reg.register(makeRun());
    reg.cancel('s1');
    expect(active.size).toBe(0);
    expect(completed[0]!.status).toBe('cancelled');
  });

  it('complete on a missing id is a no-op (no cleanup calls, no notify)', () => {
    const { removeUnit, removeLocalUnit, clearHighlight, notify } = makeSubagentCtx();
    notify.mockClear();
    new SubagentRegistry(
      { active: new Map(), completed: [], progress: new Map(), highlighted: null },
      {
        notify,
        removeUnit,
        removeLocalUnit,
        clearHighlight,
      },
    ).complete('nope', true, 'x');
    expect(removeUnit).not.toHaveBeenCalled();
    expect(removeLocalUnit).not.toHaveBeenCalled();
    expect(clearHighlight).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('completed list is capped at 50 (oldest dropped)', () => {
    const { reg, completed } = makeSubagentCtx();
    for (let i = 0; i < 55; i++) {
      reg.register(makeRun({ id: `s${i}` }));
      reg.complete(`s${i}`, true, 'ok');
    }
    expect(completed.length).toBe(50);
    // The newest is at the head (unshift), so the oldest survivors are
    // the first 50 inserted minus the 5 dropped.
    expect(completed[0]!.id).toBe('s54');
    expect(completed[49]!.id).toBe('s5');
  });

  it('resolveId returns preferredId if it exists in active or completed', () => {
    const { reg } = makeSubagentCtx();
    reg.register(makeRun({ id: 's1' }));
    reg.complete('s1', true, 'ok');
    expect(reg.resolveId('s1')).toBe('s1');
  });

  it('resolveId falls back to active run for the unit', () => {
    const { reg } = makeSubagentCtx();
    reg.register(makeRun({ id: 's1', parentUnitId: 'MAIN' }));
    expect(reg.resolveId(undefined, 'MAIN')).toBe('s1');
  });

  it('resolveId falls back to most recent completed run for the unit', () => {
    const { reg } = makeSubagentCtx();
    reg.register(makeRun({ id: 'old', parentUnitId: 'MAIN' }));
    reg.complete('old', true, 'done');
    reg.register(makeRun({ id: 'newer', parentUnitId: 'MAIN' }));
    reg.complete('newer', true, 'done');
    expect(reg.resolveId(undefined, 'MAIN')).toBe('newer');
  });

  it('resolveId returns null when nothing matches', () => {
    const { reg } = makeSubagentCtx();
    expect(reg.resolveId()).toBeNull();
  });
});
