import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PowerGrid } from './types.ts';
import { drawIsoPowerOverlay } from './isoPowerOverlay.ts';

type Operation = [string, ...unknown[]];
interface Fixture {
  name: string;
  grid?: Omit<PowerGrid, 'conduits'> & { conduits: string[] };
  times: number[];
  tokens: Record<string, string>;
  view: { x0: number; y0: number; x1: number; y1: number };
  trace: Operation[];
}

// Captured from f155846 BEFORE extraction; preserve the existing clock-call
// positions, numeric parsing quirks, thresholds, gradients and drawing order.
const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/isoPowerOverlay.canvas.json', import.meta.url), 'utf8'),
) as Fixture[];

function recordingContext(trace: Operation[]): CanvasRenderingContext2D {
  const gradients = new WeakMap<object, number>();
  let nextGradient = 0;
  const methods = new Set([
    'save',
    'restore',
    'beginPath',
    'moveTo',
    'lineTo',
    'stroke',
    'arc',
    'fill',
    'fillRect',
    'strokeRect',
    'fillText',
  ]);
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'createRadialGradient') {
          return (...args: unknown[]) => {
            const id = nextGradient++;
            trace.push(['createRadialGradient', id, ...args]);
            const gradient = {
              addColorStop: (...args: unknown[]) => trace.push(['addColorStop', id, ...args]),
            };
            gradients.set(gradient, id);
            return gradient;
          };
        }
        if (typeof key !== 'string' || !methods.has(key)) {
          throw new Error(`Unexpected Canvas access: ${String(key)}`);
        }
        return (...args: unknown[]) => trace.push([key, ...args]);
      },
      set(_target, key, value) {
        const normalized =
          value && typeof value === 'object' && gradients.has(value)
            ? { gradient: gradients.get(value) }
            : value;
        trace.push(['set', String(key), normalized]);
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
}

describe('isometric power overlay Canvas and clock characterization', () => {
  it.each(fixtures)('$name', (fixture) => {
    const trace: Operation[] = [];
    let reads = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      if (reads >= fixture.times.length) throw new Error('Unexpected clock read');
      const time = fixture.times[reads++]!;
      trace.push(['now', time]);
      return time;
    });
    try {
      const powerGrid = fixture.grid
        ? { ...fixture.grid, conduits: new Set(fixture.grid.conduits) }
        : undefined;
      const before = JSON.stringify(fixture);
      const gridBefore = structuredClone(powerGrid);
      drawIsoPowerOverlay(
        { ctx: recordingContext(trace), tokens: fixture.tokens },
        { powerGrid },
        fixture.view,
      );
      expect(trace).toEqual(fixture.trace);
      expect(reads).toBe(fixture.times.length);
      expect(JSON.stringify(fixture)).toBe(before);
      expect(powerGrid).toEqual(gridBefore);
    } finally {
      clock.mockRestore();
    }
  });
});
