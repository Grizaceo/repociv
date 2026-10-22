import { describe, expect, it, vi } from 'vitest';
import { drawIsoDebugOverlay } from './isoDebugOverlay.ts';
import golden from './fixtures/isoDebugOverlay.canvas.json';

type Trace = (string | number)[][];
interface CanvasState {
  properties: Record<string, string | number>;
  transform: number[];
}

// Model assignment/save/restore effects only, not browser validation of styles.
function recordCanvas(initial: CanvasState) {
  const trace: Trace = [];
  let state = structuredClone(initial);
  const stack: CanvasState[] = [];
  const methods = new Set([
    'save',
    'restore',
    'setTransform',
    'beginPath',
    'moveTo',
    'lineTo',
    'stroke',
    'arc',
    'fill',
    'roundRect',
    'fillRect',
    'strokeRect',
    'fillText',
  ]);
  const ctx = new Proxy(
    {},
    {
      get(_, key: string) {
        if (!methods.has(key)) throw new Error(`Unexpected Canvas access: ${key}`);
        return (...args: (string | number)[]) => {
          trace.push([key, ...args]);
          if (key === 'save') stack.push(structuredClone(state));
          if (key === 'restore') {
            const saved = stack.pop();
            if (!saved) throw new Error('restore without save');
            state = saved;
          }
          if (key === 'setTransform') state.transform = args as number[];
        };
      },
      set(_, key: string, value: string | number) {
        trace.push(['set', key, value]);
        state.properties[key] = value;
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
  return { ctx, trace, finalState: () => state, stackDepth: () => stack.length };
}

/**
 * Historical characterization captured BEFORE extraction from commit
 * 51ba9d7d540c4e3c96d4269562b7215772066442: 39 fixtures / 1,429 Canvas operations.
 * The original function, geometry and font helper came from the fixed commit.
 * Never regenerate this golden from the extracted implementation.
 * Deliberately preserves path-index slice quirks, two-pass draw order, residual
 * card/path styles and the screen panel's local transform save/restore.
 */
describe('drawIsoDebugOverlay original Canvas characterization', () => {
  for (const fixture of golden) {
    it(fixture.name, () => {
      const { ctx, trace, finalState, stackDepth } = recordCanvas(fixture.initialState);
      const tokens = { ...fixture.tokens } as Record<string, string>;
      const world = {
        rooms: fixture.roomCounts.map((n) => ({
          workbenches: Array.from({ length: n }, () => ({})),
        })),
      };
      // JSON imports widen string unions; the immutable fixture describes LocalUnit states.
      const units = structuredClone(fixture.units) as Parameters<typeof drawIsoDebugOverlay>[2];
      const before = structuredClone({ world, units, tokens });
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
        throw new Error('Unexpected clock read');
      });
      const random = vi.spyOn(Math, 'random').mockImplementation(() => {
        throw new Error('Unexpected random read');
      });
      try {
        drawIsoDebugOverlay({ ctx, tokens, fpsValue: fixture.fps }, world, units);
        expect(trace).toEqual(fixture.trace);
        expect(finalState()).toEqual(fixture.finalState);
        expect(stackDepth()).toBe(0);
        expect({ world, units, tokens }).toEqual(before);
        expect(clock).not.toHaveBeenCalled();
        expect(random).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
        random.mockRestore();
      }
    });
  }
});
