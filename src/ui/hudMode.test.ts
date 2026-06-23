import { afterEach, describe, expect, it, vi } from 'vitest';

// hudMode touches localStorage + document.body; stub both for the node env.
function setup(initial?: string) {
  const store: Record<string, string> = {};
  if (initial !== undefined) store['repociv:hud-mode'] = initial;
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
  const classes = new Set<string>();
  vi.stubGlobal('document', {
    body: {
      classList: {
        toggle: (c: string, on?: boolean) => {
          const want = on ?? !classes.has(c);
          if (want) classes.add(c);
          else classes.delete(c);
          return want;
        },
        contains: (c: string) => classes.has(c),
      },
    },
    getElementById: () => null,
  });
  return { store, classes };
}

afterEach(() => vi.unstubAllGlobals());

describe('hudMode', () => {
  it('defaults to quick when nothing persisted', async () => {
    setup();
    const m = await import('./hudMode.ts');
    expect(m.getHudMode()).toBe('quick');
  });

  it('reads a persisted advanced mode', async () => {
    setup('advanced');
    const m = await import('./hudMode.ts');
    expect(m.getHudMode()).toBe('advanced');
  });

  it('setHudMode persists and reflects the body class', async () => {
    const { store, classes } = setup();
    const m = await import('./hudMode.ts');
    m.setHudMode('advanced');
    expect(store['repociv:hud-mode']).toBe('advanced');
    expect(classes.has('hud-advanced')).toBe(true);
    m.setHudMode('quick');
    expect(store['repociv:hud-mode']).toBe('quick');
    expect(classes.has('hud-advanced')).toBe(false);
  });

  it('toggleHudMode flips quick↔advanced and returns the new mode', async () => {
    setup();
    const m = await import('./hudMode.ts');
    expect(m.toggleHudMode()).toBe('advanced');
    expect(m.getHudMode()).toBe('advanced');
    expect(m.toggleHudMode()).toBe('quick');
    expect(m.getHudMode()).toBe('quick');
  });

  it('falls back to quick when localStorage throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    vi.stubGlobal('document', {
      body: { classList: { toggle: () => false } },
      getElementById: () => null,
    });
    const m = await import('./hudMode.ts');
    expect(m.getHudMode()).toBe('quick');
    // setHudMode must not throw even when persistence fails.
    expect(() => m.setHudMode('advanced')).not.toThrow();
  });
});
