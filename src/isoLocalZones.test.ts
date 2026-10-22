import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LocalWorld, ZoneType } from './types.ts';
import { drawIsoZones, drawIsoZonePaintPreview } from './isoLocalZones.ts';
import { monoFont } from './isoRenderStyle.ts';

type CanvasOperation = [string, ...unknown[]];
interface Fixture {
  name: string;
  kind: 'zones' | 'preview';
  zones?: LocalWorld['zones'];
  state: {
    tokens: Record<string, string>;
    zonePaintMode: ZoneType | null;
    zonePaintStart: { x: number; y: number } | null;
    zonePaintCurrent: { x: number; y: number } | null;
  };
  view: { x0: number; y0: number; x1: number; y1: number };
  trace: CanvasOperation[];
}

// Golden command traces captured from 47fd6db BEFORE moving these functions.
// Unknown zone names deliberately exercise the pre-existing fallback at runtime.
const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/isoLocalZones.canvas.json', import.meta.url), 'utf8'),
) as Fixture[];

function recordingContext(trace: CanvasOperation[]): CanvasRenderingContext2D {
  const methods = new Set([
    'save',
    'restore',
    'beginPath',
    'moveTo',
    'lineTo',
    'closePath',
    'fill',
    'stroke',
    'setLineDash',
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

describe('isometric zones Canvas characterization', () => {
  it.each(fixtures)('$name: preserves every operation, property write and order', (fixture) => {
    const trace: CanvasOperation[] = [];
    const state = { ...fixture.state, ctx: recordingContext(trace) };
    const before = JSON.stringify(fixture);
    if (fixture.kind === 'zones') {
      drawIsoZones(state, { zones: fixture.zones }, fixture.view);
    } else {
      drawIsoZonePaintPreview(state, fixture.view);
    }
    expect(trace).toEqual(fixture.trace);
    expect(JSON.stringify(fixture)).toBe(before);
  });
});

describe('shared isometric font fallback', () => {
  it('uses the existing fallback when the token is absent', () => {
    expect(monoFont({ tokens: {} })).toBe("'JetBrains Mono', monospace");
  });
  it('uses a custom token', () => {
    expect(monoFont({ tokens: { fontMono: 'Custom Mono' } })).toBe('Custom Mono');
  });
  it('preserves an explicit empty string rather than using the fallback', () => {
    expect(monoFont({ tokens: { fontMono: '' } })).toBe('');
  });
});
