// ─── RepoCiv — Renderer map editor ───────────────────────────────────────────
//
// The map editor is a mode of the macro renderer: the terrain brush paints on
// mousedown, and the nation / erase / place tools act on the clicked hex.
// These tests drive the real event path (mousedown → mouseup → handleClick)
// against a fake canvas, with the heavy render collaborators mocked out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Axial } from './hex.ts';
import type { City, Terrain, Tile, World } from './types.ts';
import { tileKey } from './types.ts';

vi.mock('./hexRenderer.ts', () => ({
  HexRenderer: class {
    constructor(_ctx: unknown) {}
    loadAssets = vi.fn(async () => {});
    draw = vi.fn();
  },
}));

vi.mock('./unitRenderer.ts', () => ({
  UnitRenderer: class {
    constructor(_ctx: unknown, _state: unknown) {}
    draw = vi.fn();
    setCoordProjector = vi.fn();
    resetCoordProjector = vi.fn();
  },
}));

vi.mock('./minimapRenderer.ts', () => ({
  MinimapRenderer: class {
    constructor(_state: unknown) {}
    draw = vi.fn();
  },
}));

vi.mock('./ui/wonderVignette.ts', () => ({ openWonderVignette: vi.fn() }));
vi.mock('./ui/capitalPanel.ts', () => ({ openCapitalPanel: vi.fn() }));
vi.mock('./ui/spatialPreview.ts', () => ({
  hideDirectivePreview: vi.fn(),
  hideContextMenu: vi.fn(),
  showDirectivePreview: vi.fn(),
  showContextMenu: vi.fn(),
  showDragTooltip: vi.fn(),
  notifyTilePicked: vi.fn(),
}));
vi.mock('./ui/constructionPanel.ts', () => ({ refreshCityList: vi.fn() }));

type Listener = (e: Event) => void;

class FakeMouseEvent {
  type: string;
  button = 0;
  clientX = 0;
  clientY = 0;
  shiftKey = false;
  ctrlKey = false;
  altKey = false;
  metaKey = false;
  target: EventTarget | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  immediatePropagationStopped = false;
  constructor(type: string, init: Partial<MouseEventInit> = {}) {
    this.type = type;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.propagationStopped = true;
  }
  stopImmediatePropagation() {
    this.immediatePropagationStopped = true;
    this.propagationStopped = true;
  }
}

const bodyClassList = {
  _set: new Set<string>(),
  add(c: string) {
    this._set.add(c);
  },
  remove(c: string) {
    this._set.delete(c);
  },
  contains(c: string) {
    return this._set.has(c);
  },
};

const fakeFrame = {
  classList: {
    _set: new Set<string>(),
    add(c: string) {
      this._set.add(c);
    },
    remove(c: string) {
      this._set.delete(c);
    },
    contains(c: string) {
      return this._set.has(c);
    },
  },
};

const fakeStyle = { getPropertyValue: vi.fn(() => '') };

const storage: Record<string, string> = {};

function installBrowserGlobals(): void {
  vi.stubGlobal('MouseEvent', FakeMouseEvent);
  vi.stubGlobal(
    'KeyboardEvent',
    class KeyboardEvent {
      type = '';
      key = '';
      ctrlKey = false;
      shiftKey = false;
      altKey = false;
      metaKey = false;
      target: EventTarget | null = null;
      defaultPrevented = false;
      constructor(type: string, init: Partial<KeyboardEventInit> = {}) {
        this.type = type;
        Object.assign(this, init);
      }
      preventDefault() {
        this.defaultPrevented = true;
      }
    },
  );
  vi.stubGlobal(
    'HTMLInputElement',
    class HTMLInputElement {
      /* stub for instanceof in keydown */
    },
  );
  vi.stubGlobal(
    'HTMLTextAreaElement',
    class HTMLTextAreaElement {
      /* stub for instanceof in keydown */
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  vi.stubGlobal(
    'getComputedStyle',
    vi.fn(() => fakeStyle),
  );
  vi.stubGlobal('document', {
    body: { classList: bodyClassList },
    documentElement: { style: fakeStyle },
    getElementById: vi.fn((id: string) => {
      if (id === 'local-view-frame') return fakeFrame;
      return null;
    }),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createElement: vi.fn(() => ({ style: {}, classList: bodyClassList, appendChild: vi.fn() })),
  });
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    devicePixelRatio: 1,
    innerWidth: 800,
    innerHeight: 600,
    requestAnimationFrame: vi.fn(),
    localStorage: {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        for (const key of Object.keys(storage)) delete storage[key];
      },
    },
  });
}

function makeFakeCanvas() {
  const listeners: Record<string, Listener[]> = {};
  const ctxStub = new Proxy(
    {},
    {
      get: () => vi.fn(),
    },
  ) as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 800,
    height: 600,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    getContext: vi.fn(() => ctxStub),
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    addEventListener: vi.fn((type: string, listener: Listener) => {
      (listeners[type] ??= []).push(listener);
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    listeners,
    fire: (type: string, ev: Event) => {
      for (const l of listeners[type] ?? []) l(ev);
    },
  };
}

function tile(coord: Axial, terrain: Terrain = 'plains', city?: City): Tile {
  return {
    coord,
    terrain,
    resources: { gold: 0, science: 0, production: 0 },
    inFog: false,
    revealed: true,
    city,
  };
}

function makeCity(id: string, coord: Axial, repoPath: string): City {
  return {
    id,
    name: id,
    coord,
    repoPath,
    population: 5,
    territory: [],
    districts: [],
    buildings: [],
    isCapital: false,
    color: [0.3, 0.3, 0.3],
  };
}

function makeState(tiles: Tile[], cities: City[]) {
  const world = {
    tiles: new Map<string, Tile>(),
    cities,
    units: [],
    buildings: [],
  } as unknown as World;
  for (const t of tiles) world.tiles.set(tileKey(t.coord), t);
  return {
    viewMode: 'macro' as 'macro' | 'local',
    world,
    getUnitAt: vi.fn(() => undefined),
    getAllUnits: vi.fn(() => []),
    selectUnit: vi.fn(),
    moveUnit: vi.fn(() => true),
    startBuilding: vi.fn(),
    enterMacroView: vi.fn(),
    notifyUpdate: vi.fn(),
    localWorld: null,
    getLocalUnits: vi.fn(() => []),
  };
}

let Renderer: typeof import('./renderer.ts').Renderer;

beforeEach(async () => {
  installBrowserGlobals();
  vi.resetModules();
  const mod = await import('./renderer.ts');
  Renderer = mod.Renderer;
  // Fresh stores: the editor persists into localStorage.
  window.localStorage.clear();
  const { resetNationStoreCache } = await import('./nations.ts');
  const { resetMapEditsCache } = await import('./mapEdits.ts');
  resetNationStoreCache();
  resetMapEditsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Renderer map editor — terrain brush', () => {
  it('paints the terrain on the hex under the pointer', () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 1, r: 2 })], []);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 2 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('terrain');
    renderer.setMapEditorTerrain('mountain');

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);

    expect(state.world.tiles.get('1,2')?.terrain).toBe('mountain');
    expect(state.notifyUpdate).toHaveBeenCalled();
  });

  it('never paints over the capital', () => {
    const { canvas, fire } = makeFakeCanvas();
    const capital = makeCity('capital', { q: 0, r: 0 }, 'capital');
    capital.isCapital = true;
    const state = makeState([tile({ q: 0, r: 0 }, 'sacred', capital)], [capital]);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 0, r: 0 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('terrain');
    renderer.setMapEditorTerrain('desert');

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);

    expect(state.world.tiles.get('0,0')?.terrain).toBe('sacred');
  });
});

describe('Renderer map editor — nation tool', () => {
  it('aligns the clicked city to the active nation', async () => {
    const { createNation } = await import('./nations.ts');
    const nation = createNation('Imperio', '#4a70b8');

    const { canvas, fire } = makeFakeCanvas();
    const city = makeCity('repociv', { q: 2, r: 0 }, '/workspace/repociv');
    const state = makeState([tile({ q: 2, r: 0 }, 'plains', city)], [city]);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 2, r: 0 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('nation');
    renderer.setMapEditorNation(nation.id);

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);

    expect(city.nationId).toBe(nation.id);
  });

  it('acts on the hex even when a unit stands on it', async () => {
    const { createNation } = await import('./nations.ts');
    const nation = createNation('Imperio', '#4a70b8');

    const { canvas, fire } = makeFakeCanvas();
    const city = makeCity('repociv', { q: 2, r: 0 }, '/workspace/repociv');
    const state = makeState([tile({ q: 2, r: 0 }, 'plains', city)], [city]);
    // A unit on the hex used to swallow the click (unit drag won the gesture).
    state.getUnitAt = vi.fn(() => ({ id: 'MAIN' }) as never);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 2, r: 0 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('nation');
    renderer.setMapEditorNation(nation.id);

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);

    expect(city.nationId).toBe(nation.id);
  });
});

describe('Renderer map editor — erase tool', () => {
  it('erases a free hex but never a city hex', async () => {
    const { canvas, fire } = makeFakeCanvas();
    const city = makeCity('repociv', { q: 0, r: 0 }, '/workspace/repociv');
    const state = makeState([tile({ q: 0, r: 0 }, 'plains', city), tile({ q: 1, r: 0 })], [city]);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('erase');

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);

    expect(state.world.tiles.has('1,0')).toBe(false);
    expect(state.world.tiles.has('0,0')).toBe(true);
  });
});
