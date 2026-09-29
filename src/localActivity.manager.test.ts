// ─── Local view: agent activity wiring ─────────────────────────────────────
// The LocalWorldManager owns the transient activity pulse: it accepts a
// `unit_tool_call` and decays it in tick(), so the renderer stays dumb and
// reads a plain field off the unit.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalWorldManager } from './localWorldManager.ts';
import { ACTIVITY_TTL_MS } from './localActivity.ts';
import type { Unit } from './types.ts';

function makeUnit(id = 'MAIN'): Unit {
  return {
    id,
    name: id,
    type: 'hero',
    civ: 'capital',
    coord: { q: 0, r: 0 },
    hex: [0, 0],
    state: 'idle',
    mission: null,
    fatigue: 100,
    maxFatigue: 100,
    isResting: false,
    effectiveSpeed: 1,
  } as unknown as Unit;
}

function managerWithHero(id = 'MAIN'): LocalWorldManager {
  const mgr = new LocalWorldManager(
    () => {},
    () => makeUnit(id),
  );
  mgr.enterLocalViewMock('repociv');
  return mgr;
}

describe('LocalWorldManager — unit activity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a tool call on the matching local unit', () => {
    const mgr = managerWithHero('MAIN');
    mgr.noteUnitActivity('MAIN', 'read_file');
    const unit = mgr.getLocalUnit('MAIN')!;
    expect(unit.activity).toEqual({ toolName: 'read_file', at: Date.now() });
  });

  it('ignores a tool call for an unknown unit', () => {
    const mgr = managerWithHero('MAIN');
    mgr.noteUnitActivity('NOBODY', 'read_file');
    expect(mgr.getLocalUnits().every((u) => u.activity === undefined)).toBe(true);
  });

  it('ignores a tool call with a blank tool name', () => {
    const mgr = managerWithHero('MAIN');
    mgr.noteUnitActivity('MAIN', '   ');
    expect(mgr.getLocalUnit('MAIN')!.activity).toBeUndefined();
  });

  it('is a no-op outside local view', () => {
    const mgr = new LocalWorldManager(
      () => {},
      () => makeUnit('MAIN'),
    );
    expect(() => mgr.noteUnitActivity('MAIN', 'bash')).not.toThrow();
    expect(mgr.getLocalUnits()).toHaveLength(0);
  });

  it('keeps the activity lit inside the TTL window', () => {
    const mgr = managerWithHero('MAIN');
    mgr.noteUnitActivity('MAIN', 'bash');
    vi.advanceTimersByTime(ACTIVITY_TTL_MS - 100);
    mgr.tick(16);
    expect(mgr.getLocalUnit('MAIN')!.activity).toBeDefined();
  });

  it('clears the activity once the TTL elapses', () => {
    const mgr = managerWithHero('MAIN');
    mgr.noteUnitActivity('MAIN', 'bash');
    vi.advanceTimersByTime(ACTIVITY_TTL_MS + 50);
    mgr.tick(16);
    expect(mgr.getLocalUnit('MAIN')!.activity).toBeUndefined();
  });

  it('refreshes the window on a chained burst of calls', () => {
    const mgr = managerWithHero('MAIN');
    mgr.noteUnitActivity('MAIN', 'read_file');
    vi.advanceTimersByTime(ACTIVITY_TTL_MS - 100);
    // A second call inside the window restarts the countdown...
    mgr.noteUnitActivity('MAIN', 'edit_file');
    vi.advanceTimersByTime(ACTIVITY_TTL_MS - 100);
    mgr.tick(16);
    expect(mgr.getLocalUnit('MAIN')!.activity).toBeDefined();
    // ...and only the latest tool name is kept.
    expect(mgr.getLocalUnit('MAIN')!.activity!.toolName).toBe('edit_file');
    // ...which then expires normally.
    vi.advanceTimersByTime(ACTIVITY_TTL_MS);
    mgr.tick(16);
    expect(mgr.getLocalUnit('MAIN')!.activity).toBeUndefined();
  });

  it('does not resurrect an activity cleared earlier in the same burst', () => {
    const mgr = managerWithHero('MAIN');
    mgr.noteUnitActivity('MAIN', 'bash');
    vi.advanceTimersByTime(ACTIVITY_TTL_MS + 50);
    mgr.tick(16);
    expect(mgr.getLocalUnit('MAIN')!.activity).toBeUndefined();
  });
});

// ─── Delegation: the policy at the store level ─────────────────────────────
// The bridge attributes a subagent's tool calls to the parent. The office must
// light the parent, not the delegate — and must light nobody rather than guess.

describe('LocalWorldManager — activity attribution with subagents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function withSubagent(): LocalWorldManager {
    const mgr = managerWithHero('MAIN');
    mgr.syncSubagentSpawn({
      ephemeralUnitId: 'SCOUT-sub-1',
      parentUnitId: 'MAIN',
      kind: 'explore',
      label: 'escanear',
      repoId: 'repociv',
    });
    return mgr;
  }

  it('lights the parent when a delegation makes a tool call', () => {
    const mgr = withSubagent();
    mgr.noteUnitActivity('MAIN', 'read_file');
    expect(mgr.getLocalUnit('MAIN')!.activity).toBeDefined();
    expect(mgr.getLocalUnit('SCOUT-sub-1')!.activity).toBeUndefined();
  });

  it('does not light the delegate on the parent’s behalf', () => {
    const mgr = withSubagent();
    mgr.noteUnitActivity('MAIN', 'bash');
    expect(mgr.getLocalUnit('SCOUT-sub-1')!.activity).toBeUndefined();
  });
});
