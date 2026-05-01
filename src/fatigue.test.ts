import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameState } from './game.ts';
import type { RestArea, World } from './types.ts';
import type { Axial } from './hex.ts';

function makeAxial(q = 0, r = 0): Axial {
  return { q, r };
}

function makeWorld(): World {
  return {
    tiles: new Map(),
    cities: [],
    units: [],
    buildings: [], // ← required by World interface
    resources: { gold: 0, science: 0, production: 0 },
    generatedAt: Date.now(),
    restAreas: [], // Phase 9
  };
}

describe('Phase 9: XCOM Context Fatigue', () => {
  let gs: GameState;

  beforeEach(() => {
    gs = new GameState(makeWorld());
    gs.spawnUnit('davi', 'DAVI', 'hero', 'gris', makeAxial(5, 5));
  });

  // ─── Core fatigue state ──────────────────────────────────────────────────────

  it('spawns unit with full fatigue (100) and effectiveSpeed 1.0', () => {
    const unit = gs.getUnit('davi')!;
    expect(unit.fatigue).toBe(100);
    expect(unit.maxFatigue).toBe(100);
    expect(unit.effectiveSpeed).toBe(1.0);
    expect(unit.isResting).toBe(false);
  });

  it('updateUnitFatigue applies ratio to effectiveSpeed', () => {
    gs.updateUnitFatigue('davi', 50, 100, false, null);
    const unit = gs.getUnit('davi')!;
    expect(unit.fatigue).toBe(50);
    expect(unit.maxFatigue).toBe(100);
    expect(unit.effectiveSpeed).toBe(0.5);
    expect(unit.isResting).toBe(false);
  });

  it('updateUnitFatigue sets isResting and restingRoomId', () => {
    gs.updateUnitFatigue('davi', 80, 100, true, 'room_rest_1');
    const unit = gs.getUnit('davi')!;
    expect(unit.isResting).toBe(true);
    expect(unit.restingRoomId).toBe('room_rest_1');
  });

  it('updateUnitFatigue recovers effectiveSpeed to 1.0 at full rest (fatigue=100)', () => {
    gs.updateUnitFatigue('davi', 100, 100, true, 'room_rest_1');
    const unit = gs.getUnit('davi')!;
    expect(unit.effectiveSpeed).toBe(1.0);
  });

  it('updateUnitFatigue handles zero maxFatigue gracefully (fallback to 1)', () => {
    gs.updateUnitFatigue('davi', 0, 0, false, null);
    const unit = gs.getUnit('davi')!;
    expect(unit.effectiveSpeed).toBe(1); // fallback when maxFatigue=0
  });

  // ─── Speed penalties at high fatigue ───────────────────────────────────────

  it('effectiveSpeed is 0.0 at 0 fatigue (exhausted)', () => {
    gs.updateUnitFatigue('davi', 0, 100, false, null);
    expect(gs.getUnit('davi')!.effectiveSpeed).toBe(0);
  });

  it('effectiveSpeed is 0.25 at 25 fatigue', () => {
    gs.updateUnitFatigue('davi', 25, 100, false, null);
    expect(gs.getUnit('davi')!.effectiveSpeed).toBe(0.25);
  });

  it('effectiveSpeed is 0.8 at 80 fatigue (>80% = slow)', () => {
    gs.updateUnitFatigue('davi', 80, 100, false, null);
    expect(gs.getUnit('davi')!.effectiveSpeed).toBe(0.8);
  });

  // ─── Rest areas ─────────────────────────────────────────────────────────────

  it('addRestArea adds a rest area to the world', () => {
    const ra: RestArea = {
      id: 'ra1',
      roomId: 'room_0',
      coord: { q: 1, r: 1 },
      recoveryRate: 8,
      capacity: 4,
      unitsInside: [],
    };
    gs.addRestArea(ra);
    const near = gs.getRestAreaNear({ q: 1, r: 1 }, 5);
    expect(near?.id).toBe('ra1');
  });

  it('removeRestArea removes a rest area', () => {
    const ra: RestArea = {
      id: 'ra1',
      roomId: 'room_0',
      coord: { q: 1, r: 1 },
      recoveryRate: 8,
      capacity: 4,
      unitsInside: [],
    };
    gs.addRestArea(ra);
    gs.removeRestArea('ra1');
    const near = gs.getRestAreaNear({ q: 1, r: 1 }, 5);
    expect(near).toBeUndefined();
  });

  it('getRestAreaNear returns undefined when no rest areas exist', () => {
    expect(gs.getRestAreaNear(makeAxial(1, 1), 5)).toBeUndefined();
  });

  // ─── getUnitFatigue ──────────────────────────────────────────────────────────

  it('getUnitFatigue returns current fatigue snapshot', () => {
    gs.updateUnitFatigue('davi', 60, 100, false, null);
    const snap = gs.getUnitFatigue('davi');
    expect(snap).toEqual({
      unit: 'davi',
      fatigue: 60,
      maxFatigue: 100,
      effectiveSpeed: 0.6,
      isResting: false,
      restingRoomId: undefined,
    });
  });

  it('getUnitFatigue returns null for unknown unit', () => {
    expect(gs.getUnitFatigue('unknown')).toBeNull();
  });

  // ─── setUnitState ─────────────────────────────────────────────────────────

  it('setUnitState changes unit state', () => {
    gs.setUnitState('davi', 'moving');
    expect(gs.getUnit('davi')!.state).toBe('moving');
  });

  it('setUnitState notifies observers', () => {
    const spy = vi.fn();
    gs.subscribe(spy);
    gs.setUnitState('davi', 'working');
    expect(spy).toHaveBeenCalled();
  });

  it('setUnitState is no-op for unknown unit (does not throw)', () => {
    expect(() => gs.setUnitState('unknown', 'idle')).not.toThrow();
  });

  // ─── Resting behavior ───────────────────────────────────────────────────────

  it('setUnitResting marks unit as resting', () => {
    gs.setUnitResting('davi', true, 'room_0');
    const unit = gs.getUnit('davi')!;
    expect(unit.isResting).toBe(true);
    expect(unit.restingRoomId).toBe('room_0');
  });

  it('setUnitResting clears resting when set to false', () => {
    gs.setUnitResting('davi', true, 'room_0');
    gs.setUnitResting('davi', false);
    const unit = gs.getUnit('davi')!;
    expect(unit.isResting).toBe(false);
    expect(unit.restingRoomId).toBeUndefined();
  });
});
