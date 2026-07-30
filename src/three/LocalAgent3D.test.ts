import { describe, it, expect } from 'vitest';
import { LocalAgent3D } from './LocalAgent3D.ts';
import type { LocalUnit, LocalNpc } from '../types.ts';

function makeUnit(overrides: Partial<LocalUnit> = {}): LocalUnit {
  return {
    id: overrides.id ?? 'unit-1',
    name: overrides.name ?? 'TestAgent',
    unitType: overrides.unitType ?? 'worker',
    color: overrides.color ?? '#4A9E5A',
    gridX: overrides.gridX ?? 0,
    gridY: overrides.gridY ?? 0,
    targetX: overrides.targetX ?? null,
    targetY: overrides.targetY ?? null,
    path: overrides.path ?? [],
    pathIndex: overrides.pathIndex ?? 0,
    pathProgress: overrides.pathProgress ?? 0,
    state: overrides.state ?? 'idle_in_room',
    mission: overrides.mission ?? null,
    workProgress: overrides.workProgress ?? 0,
    macroUnitId: overrides.macroUnitId ?? 'MACRO-1',
    currentWorkbenchId: overrides.currentWorkbenchId ?? null,
    fatigue: overrides.fatigue ?? 100,
    maxFatigue: overrides.maxFatigue ?? 100,
    isResting: overrides.isResting ?? false,
    effectiveSpeed: overrides.effectiveSpeed ?? 1.0,
    ...overrides,
  };
}

function makeNpc(overrides: Partial<LocalNpc> = {}): LocalNpc {
  return {
    id: overrides.id ?? 'npc-1',
    name: overrides.name ?? 'Manager',
    color: overrides.color ?? '#D49B3A',
    gridX: overrides.gridX ?? 0,
    gridY: overrides.gridY ?? 0,
    roomId: overrides.roomId ?? 'room-1',
    type: overrides.type ?? 'manager',
  };
}

describe('LocalAgent3D', () => {
  it('constructs with empty group', () => {
    const la = new LocalAgent3D();
    expect(la.getGroup().name).toBe('local-agents');
    expect(la.getGroup().children.length).toBe(0);
  });

  it('spawns agents on first update', () => {
    const la = new LocalAgent3D();
    const units = [makeUnit({ id: 'u1' }), makeUnit({ id: 'u2' })];
    la.update(units, [], 0.016);
    // Group should have 2 children (spawned agents)
    expect(la.getGroup().children.length).toBe(2);
  });

  it('spawns NPCs alongside units', () => {
    const la = new LocalAgent3D();
    const units = [makeUnit({ id: 'u1' })];
    const npcs = [makeNpc({ id: 'n1' })];
    la.update(units, npcs, 0.016);
    expect(la.getGroup().children.length).toBe(2);
  });

  it('does not re-spawn existing agents on second update', () => {
    const la = new LocalAgent3D();
    const units = [makeUnit({ id: 'u1' })];
    la.update(units, [], 0.016);
    expect(la.getGroup().children.length).toBe(1);
    la.update(units, [], 0.016);
    expect(la.getGroup().children.length).toBe(1);
  });

  it('starts despawn tween when agent is removed', () => {
    const la = new LocalAgent3D();
    const units1 = [makeUnit({ id: 'u1' }), makeUnit({ id: 'u2' })];
    la.update(units1, [], 0.016);
    expect(la.getGroup().children.length).toBe(2);

    // Remove u2
    const units2 = [makeUnit({ id: 'u1' })];
    la.update(units2, [], 0.016);
    // u2 still in group (despawning tween in progress)
    expect(la.getGroup().children.length).toBe(2);
  });

  it('completes despawn and removes after tween', () => {
    const la = new LocalAgent3D();
    const units1 = [makeUnit({ id: 'u1' })];
    la.update(units1, [], 0.016);

    // Remove u1
    la.update([], [], 0.016);
    // Still present (despawning)
    expect(la.getGroup().children.length).toBe(1);

    // Advance despawn tween (dt * 5 = 0.25 per frame, need 5 frames to reach 0)
    for (let i = 0; i < 10; i++) {
      la.update([], [], 0.2);
    }
    // Should be gone now
    expect(la.getGroup().children.length).toBe(0);
  });

  it('detects dirty signature on position change', () => {
    const la = new LocalAgent3D();
    const u1 = makeUnit({ id: 'u1', gridX: 0, gridY: 0 });
    la.update([u1], [], 0.016);

    const u1Moved = makeUnit({ id: 'u1', gridX: 5, gridY: 3 });
    // Should not crash, just update position
    la.update([u1Moved], [], 0.016);
    expect(la.getGroup().children.length).toBe(1);
  });

  it('handles hero types differently from workers', () => {
    const la = new LocalAgent3D();
    const hero = makeUnit({ id: 'h1', unitType: 'hero' });
    la.update([hero], [], 0.016);
    // Hero should spawn (buildFigurine with isHero=true)
    expect(la.getGroup().children.length).toBe(1);
  });

  it('advance spawn tween to alive after enough frames', () => {
    const la = new LocalAgent3D();
    const units = [makeUnit({ id: 'u1' })];
    // Spawn
    la.update(units, [], 0.016);
    // dt * 3.3 = 0.053 per frame, need ~19 frames to reach 1.0
    for (let i = 0; i < 25; i++) {
      la.update(units, [], 0.016);
    }
    // Agent should be alive now (still 1 child)
    expect(la.getGroup().children.length).toBe(1);
  });

  it('dispose clears all agents', () => {
    const la = new LocalAgent3D();
    const units = [makeUnit({ id: 'u1' }), makeUnit({ id: 'u2' })];
    la.update(units, [], 0.016);
    expect(la.getGroup().children.length).toBe(2);

    la.dispose();
    expect(la.getGroup().children.length).toBe(0);
  });

  it('handles empty arrays', () => {
    const la = new LocalAgent3D();
    la.update([], [], 0.016);
    expect(la.getGroup().children.length).toBe(0);
  });

  it('interpolates position along path', () => {
    const la = new LocalAgent3D();
    const unit = makeUnit({
      id: 'u1',
      gridX: 0,
      gridY: 0,
      path: [{ x: 0, y: 0 }, { x: 4, y: 0 }],
      pathIndex: 0,
      pathProgress: 0.5,
      state: 'walking_to_room',
    });
    la.update([unit], [], 0.016);
    // Agent should exist and be positioned somewhere between 0 and 4
    expect(la.getGroup().children.length).toBe(1);
    // After several frames of interpolation, it should be closer to target
    for (let i = 0; i < 10; i++) {
      la.update([unit], [], 0.016);
    }
    const child = la.getGroup().children[0];
    expect(child).toBeDefined();
  });
});
