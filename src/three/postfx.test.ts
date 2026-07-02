import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveInitialPostFx, persistPostFx } from './renderMode.ts';
import { GradeVignetteShader } from './PostFX3D.ts';

// ─── Post-FX toggle state machine (non-GPU) ──────────────────────────────────
// Mirrors renderMode.test.ts: the composer itself needs a GL context, but the
// on/off resolution (URL > localStorage > default-on) is pure logic and is
// what QA and the capture scripts rely on to pin the effect per navigation.

const POSTFX_KEY = 'repociv:postfx';

function makeStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string): string | null => m.get(k) ?? null,
    setItem: (k: string, v: string): void => {
      m.set(k, v);
    },
    removeItem: (k: string): void => {
      m.delete(k);
    },
    clear: (): void => m.clear(),
    get: (k: string): string | undefined => m.get(k),
  };
}

function setup(search: string, storage: Record<string, string> = {}) {
  const store = makeStorage(storage);
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('window', { location: { search } });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveInitialPostFx', () => {
  it('defaults ON with no URL and nothing persisted', () => {
    setup('');
    expect(resolveInitialPostFx()).toBe(true);
  });

  it('?postfx=0 forces off even when persisted on', () => {
    setup('?postfx=0', { [POSTFX_KEY]: '1' });
    expect(resolveInitialPostFx()).toBe(false);
  });

  it('?postfx=off forces off', () => {
    setup('?postfx=off');
    expect(resolveInitialPostFx()).toBe(false);
  });

  it('?postfx=1 forces on even when persisted off', () => {
    setup('?postfx=1', { [POSTFX_KEY]: '0' });
    expect(resolveInitialPostFx()).toBe(true);
  });

  it('persisted "0" turns it off without a URL param', () => {
    setup('', { [POSTFX_KEY]: '0' });
    expect(resolveInitialPostFx()).toBe(false);
  });

  it('unknown URL values fall through to the persisted choice', () => {
    setup('?postfx=banana', { [POSTFX_KEY]: '0' });
    expect(resolveInitialPostFx()).toBe(false);
  });

  it('persistPostFx round-trips through the resolver', () => {
    const store = setup('');
    persistPostFx(false);
    expect(store.get(POSTFX_KEY)).toBe('0');
    expect(resolveInitialPostFx()).toBe(false);
    persistPostFx(true);
    expect(resolveInitialPostFx()).toBe(true);
  });
});

describe('GradeVignetteShader', () => {
  it('declares the uniforms the pass drives', () => {
    expect(GradeVignetteShader.uniforms.tDiffuse).toBeDefined();
    expect(GradeVignetteShader.uniforms.uVignette.value).toBeGreaterThan(0);
    expect(GradeVignetteShader.uniforms.uVignette.value).toBeLessThan(1);
    expect(GradeVignetteShader.uniforms.uGoldMix.value).toBeLessThan(0.2);
  });

  it('grades warm: red gain above 1, blue below 1', () => {
    const [r, g, b] = GradeVignetteShader.uniforms.uWarmBalance.value;
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
    expect(g).toBeGreaterThan(b);
    expect(g).toBeLessThan(r);
  });

  it('fragment shader wires every declared uniform', () => {
    for (const name of Object.keys(GradeVignetteShader.uniforms)) {
      expect(GradeVignetteShader.fragmentShader).toContain(name);
    }
  });
});
