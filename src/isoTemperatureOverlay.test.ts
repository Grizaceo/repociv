import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { LocalRoom, RoomClimate } from './types.ts';
import { drawIsoTemperatureOverlay } from './isoTemperatureOverlay.ts';

type Operation = [string, ...unknown[]];
interface Fixture {
  name: string;
  rooms: Pick<LocalRoom, 'id' | 'x' | 'y' | 'width' | 'height'>[];
  climates?: [string, RoomClimate][];
  times: number[];
  randoms: number[];
  tokens: Record<string, string>;
  view: { x0: number; y0: number; x1: number; y1: number };
  trace: Operation[];
}

// Captured from e90c291 BEFORE extraction, not regenerated from the moved code.
// Keep property writes, clock/random reads and particle callbacks interleaved:
// device clocks are per visible device, independently of room-center clipping.
const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/isoTemperatureOverlay.canvas.json', import.meta.url), 'utf8'),
) as Fixture[];

function recordingContext(trace: Operation[]): CanvasRenderingContext2D {
  const methods = new Set([
    'save',
    'restore',
    'beginPath',
    'moveTo',
    'quadraticCurveTo',
    'stroke',
    'arc',
    'fill',
    'fillText',
  ]);
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== 'string' || !methods.has(key)) {
          throw new Error(`Unexpected Canvas access: ${String(key)}`);
        }
        return (...args: unknown[]) => trace.push([key, ...args]);
      },
      set(_target, key, value) {
        trace.push(['set', String(key), value]);
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
}

// No gradients are created by this overlay. Unexpected Canvas operations fail
// closed instead of silently returning an unrecorded mock result.
describe('isometric temperature overlay Canvas, clock and randomness characterization', () => {
  it.each(fixtures)('$name', (fixture) => {
    const trace: Operation[] = [];
    let clockReads = 0;
    let randomReads = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      if (clockReads >= fixture.times.length) throw new Error('Unexpected clock read');
      const time = fixture.times[clockReads++]!;
      trace.push(['now', time]);
      return time;
    });
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      if (randomReads >= fixture.randoms.length) throw new Error('Unexpected random read');
      const value = fixture.randoms[randomReads++]!;
      trace.push(['random', value]);
      return value;
    });
    try {
      const world = {
        rooms: fixture.rooms,
        roomClimates: fixture.climates ? new Map(fixture.climates) : undefined,
      };
      const before = structuredClone(world);
      const fixtureBefore = JSON.stringify(fixture);
      drawIsoTemperatureOverlay(
        {
          ctx: recordingContext(trace),
          tokens: fixture.tokens,
          spawnBreath: (...args) => {
            trace.push(['spawnBreath', ...args]);
          },
        },
        world,
        fixture.view,
      );
      expect(trace).toEqual(fixture.trace);
      expect(clockReads).toBe(fixture.times.length);
      expect(randomReads).toBe(fixture.randoms.length);
      expect(world).toEqual(before);
      expect(JSON.stringify(fixture)).toBe(fixtureBefore);
    } finally {
      clock.mockRestore();
      random.mockRestore();
    }
  });
});
