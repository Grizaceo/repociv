import { describe, expect, it } from 'vitest';
import { axialToPixel } from './hex.ts';
import type { Unit } from './types.ts';
import { pickOnHex, stackOffsets, STACK_RING } from './unitStack.ts';

const SIZE = 50;

function unit(id: string, q: number, r: number, extra: Partial<Unit> = {}): Unit {
  return { id, coord: { q, r }, state: 'working', ...extra } as Unit;
}

const CITY = '2,1';
const hasCity = (key: string) => key === CITY;

describe('stackOffsets', () => {
  it('leaves a lone unit off any city at the hex centre', () => {
    expect(stackOffsets([unit('a', 0, 0)], hasCity, SIZE).size).toBe(0);
  });

  it('moves even a lone unit off the centre of a city hex (the city model stands there)', () => {
    const off = stackOffsets([unit('a', 2, 1)], hasCity, SIZE).get('a')!;
    expect(Math.hypot(off.x, off.y)).toBeCloseTo(STACK_RING * SIZE);
  });

  it('gives every unit sharing a hex its own slot; moving and hidden units keep none', () => {
    const units = [
      unit('a', 2, 1),
      unit('b', 2, 1),
      unit('c', 2, 1),
      unit('walker', 2, 1, { state: 'moving' }),
      unit('ghost', 2, 1, { hidden: true }),
      unit('x', 5, 5),
      unit('y', 5, 5),
    ];
    const offsets = stackOffsets(units, hasCity, SIZE);
    expect([...offsets.keys()].sort()).toEqual(['a', 'b', 'c', 'x', 'y']);
    const slots = ['a', 'b', 'c'].map((id) => {
      const o = offsets.get(id)!;
      return `${o.x.toFixed(1)},${o.y.toFixed(1)}`;
    });
    expect(new Set(slots).size).toBe(3);
  });
});

describe('pickOnHex', () => {
  const here = [unit('a', 2, 1), unit('b', 2, 1)];
  const offsets = stackOffsets(here, hasCity, SIZE);
  const centre = axialToPixel({ q: 2, r: 1 }, SIZE);
  const at = (id: string) => {
    const o = offsets.get(id)!;
    return { x: centre.x + o.x, y: centre.y + o.y };
  };

  it('a click near a unit picks that unit', () => {
    expect(pickOnHex(at('a'), { q: 2, r: 1 }, here, offsets, true, SIZE)?.id).toBe('a');
    const nearB = { x: at('b').x + 3, y: at('b').y - 2 };
    expect(pickOnHex(nearB, { q: 2, r: 1 }, here, offsets, true, SIZE)?.id).toBe('b');
  });

  it('a click at the centre of a city hex is the city (null)', () => {
    expect(pickOnHex(centre, { q: 2, r: 1 }, here, offsets, true, SIZE)).toBeNull();
  });

  it('with no city on the hex a unit always wins', () => {
    const lone = [unit('z', 0, 0)];
    const z = axialToPixel({ q: 0, r: 0 }, SIZE);
    expect(pickOnHex(z, { q: 0, r: 0 }, lone, new Map(), false, SIZE)?.id).toBe('z');
  });
});
