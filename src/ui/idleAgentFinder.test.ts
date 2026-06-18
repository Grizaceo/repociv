import { describe, it, expect } from 'vitest';
import { IdleAgentFinder } from './idleAgentFinder.ts';
import type { Unit } from '../types.ts';

function makeUnit(id: string, state: Unit['state'] = 'idle'): Unit {
  return {
    id,
    name: id,
    type: 'worker',
    civ: 'gris',
    coord: { q: 0, r: 0 },
    path: [],
    pathIndex: 0,
    pathProgress: 0,
    state,
    speed: 1,
    color: '#fff',
    movesLeft: 4,
    maxMoves: 4,
    fatigue: 100,
    maxFatigue: 100,
    isResting: false,
    effectiveSpeed: 1,
  };
}

describe('IdleAgentFinder', () => {
  it('returns null when no idle units exist', () => {
    const finder = new IdleAgentFinder();
    const units = [makeUnit('a', 'working'), makeUnit('b', 'moving')];
    expect(finder.nextIdle(units)).toBeNull();
  });

  it('returns the first idle unit on first call', () => {
    const finder = new IdleAgentFinder();
    const units = [makeUnit('a', 'idle'), makeUnit('b', 'idle')];
    const result = finder.nextIdle(units);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('a');
  });

  it('cycles to the next idle unit on subsequent calls', () => {
    const finder = new IdleAgentFinder();
    const units = [makeUnit('a', 'idle'), makeUnit('b', 'idle'), makeUnit('c', 'idle')];
    expect(finder.nextIdle(units)!.id).toBe('a');
    expect(finder.nextIdle(units)!.id).toBe('b');
    expect(finder.nextIdle(units)!.id).toBe('c');
  });

  it('wraps around after the last idle unit', () => {
    const finder = new IdleAgentFinder();
    const units = [makeUnit('a', 'idle'), makeUnit('b', 'idle')];
    expect(finder.nextIdle(units)!.id).toBe('a');
    expect(finder.nextIdle(units)!.id).toBe('b');
    expect(finder.nextIdle(units)!.id).toBe('a');
  });

  it('resets index when the idle set changes', () => {
    const finder = new IdleAgentFinder();
    let units = [makeUnit('a', 'idle'), makeUnit('b', 'idle')];
    expect(finder.nextIdle(units)!.id).toBe('a');
    expect(finder.nextIdle(units)!.id).toBe('b');
    // Now 'a' becomes working, 'c' becomes idle — set changed
    units = [makeUnit('a', 'working'), makeUnit('b', 'idle'), makeUnit('c', 'idle')];
    const result = finder.nextIdle(units);
    expect(result!.id).toBe('b'); // resets to index 0 of new set
  });

  it('idleCount returns correct count', () => {
    const finder = new IdleAgentFinder();
    const units = [makeUnit('a', 'idle'), makeUnit('b', 'working'), makeUnit('c', 'idle')];
    expect(finder.idleCount(units)).toBe(2);
  });

  it('reset clears the index and idle set memory', () => {
    const finder = new IdleAgentFinder();
    const units = [makeUnit('a', 'idle'), makeUnit('b', 'idle')];
    finder.nextIdle(units);
    finder.nextIdle(units);
    finder.reset();
    // After reset, next call should return index 0 again
    expect(finder.nextIdle(units)!.id).toBe('a');
  });
});
