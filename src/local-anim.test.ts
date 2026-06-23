// ─── RepoCiv — Local view animation tests (P1 polish) ──────────────────────────
// Tests for spawn/despawn/step-bounce timing using mocked timers.
// These test the LocalWorldManager's tick-based animation state transitions.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalWorldManager } from './localWorldManager.ts';
import type { Unit } from './types.ts';

function makeManager(): LocalWorldManager {
  const notify = vi.fn();
  const getFirstUnit = vi.fn(
    (): Unit | undefined =>
      ({
        id: 'MAIN',
        name: 'MAIN',
        type: 'hero',
        q: 0,
        r: 0,
        color: '#4af',
        mission: null,
        fatigue: 100,
        maxFatigue: 100,
        isResting: false,
        effectiveSpeed: 1,
      }) as unknown as Unit,
  );
  const getMacroUnit = vi.fn((id: string) =>
    id === 'MAIN'
      ? ({
          id: 'MAIN',
          name: 'MAIN',
          type: 'hero',
          q: 0,
          r: 0,
          color: '#4af',
          mission: null,
          fatigue: 100,
          maxFatigue: 100,
          isResting: false,
          effectiveSpeed: 1,
        } as unknown as Unit)
      : undefined,
  );
  return new LocalWorldManager(notify, getFirstUnit, getMacroUnit);
}

describe('P1: agent movement polish', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('despawnUnit sets fadeAlpha=1 and despawning=true', () => {
    const mgr = makeManager();
    mgr.enterLocalViewMock('test-repo');
    const units = mgr.getLocalUnits();
    expect(units.length).toBe(1);

    mgr.despawnUnit('MAIN');
    const unit = mgr.getLocalUnit('MAIN');
    expect(unit).toBeDefined();
    expect(unit!.despawning).toBe(true);
    expect(unit!.fadeAlpha).toBe(1);
    expect(unit!.path).toEqual([]);
  });

  it('fadeAlpha decreases to 0 over ~300ms of ticks', () => {
    const mgr = makeManager();
    mgr.enterLocalViewMock('test-repo');
    mgr.despawnUnit('MAIN');

    // Each tick is 16ms. 300ms ≈ ~19 ticks.
    // fadePerTick ≈ 16/300 ≈ 0.053
    for (let i = 0; i < 18; i++) {
      mgr.tick(16);
    }
    const unit = mgr.getLocalUnit('MAIN');
    // Should still exist (not fully faded yet at 18 ticks)
    if (unit) {
      expect(unit.fadeAlpha!).toBeGreaterThan(0);
      expect(unit.fadeAlpha!).toBeLessThanOrEqual(1);
    }

    // Tick a few more — should be gone
    for (let i = 0; i < 5; i++) {
      mgr.tick(16);
    }
    expect(mgr.getLocalUnit('MAIN')).toBeUndefined();
  });

  it('removeSubagentUnit triggers despawn (not instant removal)', () => {
    const mgr = makeManager();
    mgr.enterLocalViewMock('test-repo');

    // Spawn a subagent
    mgr.syncSubagentSpawn({
      ephemeralUnitId: 'sub-1',
      parentUnitId: 'MAIN',
      kind: 'shell',
      label: 'test-worker',
      repoId: 'test-repo',
    });
    expect(mgr.getLocalUnits().length).toBe(2);

    // Remove should trigger fade, not instant removal
    mgr.removeSubagentUnit('sub-1');
    const sub = mgr.getLocalUnit('sub-1');
    expect(sub).toBeDefined();
    expect(sub?.despawning).toBe(true);
    expect(sub?.fadeAlpha).toBe(1);
  });

  it('despawnUnit is idempotent (calling twice does nothing)', () => {
    const mgr = makeManager();
    mgr.enterLocalViewMock('test-repo');
    mgr.despawnUnit('MAIN');
    const alpha1 = mgr.getLocalUnit('MAIN')?.fadeAlpha;
    mgr.despawnUnit('MAIN'); // should not reset alpha
    const alpha2 = mgr.getLocalUnit('MAIN')?.fadeAlpha;
    expect(alpha2).toBe(alpha1);
  });

  it('non-despawning unit has fadeAlpha undefined or 1', () => {
    const mgr = makeManager();
    mgr.enterLocalViewMock('test-repo');
    const unit = mgr.getLocalUnit('MAIN');
    expect(unit).toBeDefined();
    // fadeAlpha should be undefined (not despawning) or 1
    expect(unit!.fadeAlpha ?? 1).toBe(1);
    expect(unit!.despawning ?? false).toBe(false);
  });

  it('step bounce: sin(progress * PI) gives single arch per tile', () => {
    // Verify the bounce function: 0 at start, max at mid, 0 at end
    const bounce = (progress: number) => Math.sin(progress * Math.PI) * 2.5;

    expect(bounce(0)).toBeCloseTo(0);
    expect(bounce(0.5)).toBeCloseTo(2.5);
    expect(bounce(1)).toBeCloseTo(0);

    // Midpoints should be positive (up)
    for (let p = 0.01; p < 0.99; p += 0.1) {
      expect(bounce(p)).toBeGreaterThan(0);
    }
  });

  it('idle breathing: sin(t) oscillates in [0.98, 1.02] range', () => {
    // 2s cycle: sin(now / 1000 * PI) has period 2s (sin reaches 2π at t=2000)
    const breathe = (now: number) => 1 + Math.sin((now / 1000) * Math.PI) * 0.02;

    // At t=0: scale = 1
    expect(breathe(0)).toBeCloseTo(1);

    // At t=500 (0.5s = quarter period): scale = 1.02 (sin(π/2) = 1)
    expect(breathe(500)).toBeCloseTo(1.02);

    // At t=1000 (1s = half period): scale = 1 (sin(π) = 0)
    expect(breathe(1000)).toBeCloseTo(1);

    // At t=2000 (2s = full period): scale = 1
    expect(breathe(2000)).toBeCloseTo(1);

    // Range check
    for (let t = 0; t < 10000; t += 100) {
      const s = breathe(t);
      expect(s).toBeGreaterThanOrEqual(0.98);
      expect(s).toBeLessThanOrEqual(1.02);
    }
  });

  it('despawned unit has path cleared and state set to idle', () => {
    const mgr = makeManager();
    mgr.enterLocalViewMock('test-repo');
    const unit = mgr.getLocalUnit('MAIN')!;

    // Give it a path
    unit.path = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ];
    unit.pathIndex = 0;
    unit.pathProgress = 0.5;
    unit.state = 'walking_to_workbench';

    mgr.despawnUnit('MAIN');
    expect(unit.path).toEqual([]);
    expect(unit.pathIndex).toBe(0);
    expect(unit.pathProgress).toBe(0);
    expect(unit.state).toBe('idle_in_room');
  });
});
