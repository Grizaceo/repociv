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

/**
 * Minimal DOM for the map editor toolbar (no jsdom in this repo): enough of
 * createElement / append / replaceChildren / classList / querySelector to drive
 * `src/ui/mapEditor.ts` and inspect the bar it builds.
 */
class FakeClassList {
  private set = new Set<string>();
  constructor(initial?: string) {
    for (const c of (initial ?? '').split(/\s+/)) if (c) this.set.add(c);
  }
  add(...classes: string[]) {
    for (const c of classes) this.set.add(c);
  }
  remove(...classes: string[]) {
    for (const c of classes) this.set.delete(c);
  }
  contains(c: string) {
    return this.set.has(c);
  }
}

class FakeElement {
  tagName: string;
  id = '';
  title = '';
  type = '';
  value = '';
  textContent = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  classList = new FakeClassList();
  private _className = '';
  private listeners: Record<string, Array<(e: unknown) => void>> = {};

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get className(): string {
    return this._className;
  }
  set className(value: string) {
    this._className = value;
    this.classList = new FakeClassList(value);
  }

  append(...nodes: Array<FakeElement | string>) {
    for (const node of nodes) {
      const el =
        typeof node === 'string'
          ? Object.assign(new FakeElement('#text'), { textContent: node })
          : node;
      el.parent = this;
      this.children.push(el);
    }
  }
  appendChild(node: FakeElement) {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener() {}
  dispatch(type: string) {
    for (const fn of this.listeners[type] ?? [])
      fn({ type, target: this, preventDefault: vi.fn() });
  }
  click() {
    this.dispatch('click');
  }
  private matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const [tag, cls] = selector.split('.');
    if (tag && this.tagName !== tag) return false;
    return !cls || this.classList.contains(cls);
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeOption extends FakeElement {
  constructor(text?: string, value?: string) {
    super('option');
    this.textContent = text ?? '';
    this.value = value ?? '';
  }
}

function makeFakeDocument() {
  const body = new FakeElement('body');
  const doc = {
    body,
    documentElement: { style: {} },
    createElement: vi.fn((tag: string) => new FakeElement(tag)),
    createTextNode: vi.fn((text: string) =>
      Object.assign(new FakeElement('#text'), { textContent: text }),
    ),
    getElementById: vi.fn(() => null),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { doc, body };
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

function makeWorld(tiles: Tile[], cities: City[]): World {
  const world = {
    tiles: new Map<string, Tile>(),
    cities,
    units: [],
    buildings: [],
    resources: { gold: 0, science: 0, production: 0 },
    generatedAt: Date.now(),
    restAreas: [],
  } as unknown as World;
  for (const t of tiles) world.tiles.set(tileKey(t.coord), t);
  return world;
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

  it('stops painting when the button is released outside the canvas', () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 1, r: 2 }), tile({ q: 2, r: 2 })], []);
    const renderer = new Renderer(canvas, state as never);
    let hex: Axial = { q: 1, r: 2 };
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => hex;

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('terrain');
    renderer.setMapEditorTerrain('mountain');

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    // The pointer left the canvas: the mouseup lands on the page, not on it.
    const windowCalls = (
      window.addEventListener as unknown as { mock: { calls: Array<[string, Listener]> } }
    ).mock.calls;
    for (const [type, listener] of windowCalls) {
      if (type === 'mouseup') {
        listener(new FakeMouseEvent('mouseup', { button: 0 }) as never);
      }
    }

    hex = { q: 2, r: 2 };
    fire('mousemove', new FakeMouseEvent('mousemove', { clientX: 30, clientY: 10 }) as never);

    expect(state.world.tiles.get('2,2')?.terrain).toBe('plains');
  });

  it('does not save or redraw while dragging inside one hex', () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 1, r: 2 })], []);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 2 });
    const setItem = vi.spyOn(window.localStorage, 'setItem');
    const mapWrites = () => setItem.mock.calls.filter(([key]) => key === 'repociv:map-edits:v1');

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('terrain');
    renderer.setMapEditorTerrain('mountain');

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mousemove', new FakeMouseEvent('mousemove', { clientX: 12, clientY: 10 }) as never);
    fire('mousemove', new FakeMouseEvent('mousemove', { clientX: 14, clientY: 10 }) as never);

    expect(state.notifyUpdate).toHaveBeenCalledTimes(1);
    expect(mapWrites()).toHaveLength(1);
    setItem.mockRestore();
  });

  it('saves the edit even when the hex already has that terrain', async () => {
    const { terrainOverrideFor } = await import('./mapEdits.ts');
    const { canvas, fire } = makeFakeCanvas();
    // The fill terrain is randomized per load: a hex can already be forest by
    // chance and still needs the edit, or the painted area gets holes.
    const state = makeState([tile({ q: 1, r: 2 }, 'forest')], []);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 2 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('terrain');
    renderer.setMapEditorTerrain('forest');

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);

    expect(terrainOverrideFor({ q: 1, r: 2 })).toBe('forest');
  });

  it('invalidates the cached unit paths when it paints', async () => {
    const { aStarPath } = await import('./pathfinding.ts');
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 0, r: 0 }), tile({ q: 1, r: 0 }), tile({ q: 2, r: 0 })], []);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    const before = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, state.world, 'hero');
    expect(before.some((c) => c.q === 1 && c.r === 0)).toBe(true);

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('terrain');
    renderer.setMapEditorTerrain('ocean');
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);

    const after = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, state.world, 'hero');
    expect(after.some((c) => c.q === 1 && c.r === 0)).toBe(false);
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
    // A unit standing on the hex used to swallow the click (unit drag won the
    // gesture). Put a real one in world.units — mocking getUnitAt alone never
    // exercised the unit-drag branch.
    const unit = { id: 'MAIN', coord: { q: 2, r: 0 }, cityId: 'repociv' } as never;
    state.world.units.push(unit);
    state.getUnitAt = vi.fn(() => unit);
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

  it('invalidates the cached unit paths when it erases a hex', async () => {
    const { aStarPath } = await import('./pathfinding.ts');
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 0, r: 0 }), tile({ q: 1, r: 0 }), tile({ q: 2, r: 0 })], []);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    const before = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, state.world, 'hero');
    expect(before.some((c) => c.q === 1 && c.r === 0)).toBe(true);

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('erase');
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);

    const after = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, state.world, 'hero');
    expect(after.some((c) => c.q === 1 && c.r === 0)).toBe(false);
  });

  it('takes the city units out through GameState so they can spawn again', async () => {
    const { GameState } = await import('./game.ts');
    const { canvas, fire } = makeFakeCanvas();
    const city = makeCity('repociv', { q: 0, r: 0 }, '/workspace/repociv');
    const state = new GameState(makeWorld([tile({ q: 0, r: 0 }, 'plains', city)], [city]));
    const unit = state.spawnUnit(
      'MAIN',
      'MAIN',
      'hero',
      'gris',
      { q: 0, r: 0 },
      undefined,
      city.id,
    );
    state.selectedUnit = unit;
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 0, r: 0 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('erase');

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);

    expect(state.world.cities).toHaveLength(0);
    // Erasing straight out of world.units left unitMap and the selection
    // pointing at a ghost, so addUnit handed the stale object back forever.
    expect(state.getUnit('MAIN')).toBeUndefined();
    expect(state.selectedUnit).toBeNull();

    const revived = state.spawnUnit('MAIN', 'MAIN', 'hero', 'gris', { q: 2, r: 0 });
    expect(state.world.units).toContain(revived);
    expect(state.getUnit('MAIN')).toBe(revived);
    expect(state.selectedUnit).toBeNull();
  });
});

describe('Renderer map editor — erase a hand-placed city', () => {
  it('does not bring the city back on the next reload', async () => {
    const { getMapEdits } = await import('./mapEdits.ts');
    const { applyMapEdits } = await import('./map.ts');
    const { canvas, fire } = makeFakeCanvas();
    const repo = {
      name: 'extra',
      path: 'extra',
      repoPath: '/workspace/extra',
      population: 12,
      extensions: {},
      gold: 40,
      lastCommitDays: 1,
      isLegacy: false,
      hasGit: true,
    };
    const state = makeState([tile({ q: 1, r: 0 })], []);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('place');
    renderer.setMapEditorRepo(repo);
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    expect(state.world.cities).toHaveLength(1);
    expect(getMapEdits().placedCities).toHaveLength(1);

    renderer.setMapEditorTool('erase');
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    expect(state.world.cities).toHaveLength(0);
    expect(getMapEdits().placedCities).toHaveLength(0);

    // Reload: step 2 of applyMapEdits must not place it again.
    const reloaded = makeWorld([tile({ q: 1, r: 0 })], []);
    applyMapEdits(reloaded, [repo]);
    expect(reloaded.cities).toHaveLength(0);
  });
});

const extraRepo = {
  name: 'extra',
  path: 'extra',
  repoPath: '/workspace/extra',
  population: 12,
  extensions: {},
  gold: 40,
  lastCommitDays: 1,
  isLegacy: false,
  hasGit: true,
};

describe('Renderer map editor — place tool', () => {
  it('never places the same repo twice', () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 1, r: 0 }), tile({ q: 3, r: 1 })], []);
    const renderer = new Renderer(canvas, state as never);
    let coord: Axial = { q: 1, r: 0 };
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => coord;

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('place');
    renderer.setMapEditorRepo(extraRepo);

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    coord = { q: 3, r: 1 };
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 20, clientY: 20 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 20, clientY: 20 }) as never);

    expect(state.world.cities).toHaveLength(1);
    expect(state.world.cities[0]?.coord).toEqual({ q: 1, r: 0 });
  });

  it('invalidates the cached unit paths when it places a city', async () => {
    const { aStarPath } = await import('./pathfinding.ts');
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState(
      [tile({ q: 0, r: 0 }), tile({ q: 1, r: 0 }), tile({ q: 2, r: 0 }), tile({ q: 3, r: 0 })],
      [],
    );
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 3, r: 0 });

    const before = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, state.world, 'hero');

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('place');
    renderer.setMapEditorRepo(extraRepo);
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    expect(state.world.cities).toHaveLength(1);

    // A fresh computation returns a new array; the cached one was the same object.
    const after = aStarPath({ q: 0, r: 0 }, { q: 2, r: 0 }, state.world, 'hero');
    expect(after).not.toBe(before);
  });

  it('clears the picker after placing so the repo leaves the dropdown', async () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 1, r: 0 })], []);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    const { doc } = makeFakeDocument();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('Option', FakeOption);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => [extraRepo] })),
    );
    const { openMapEditor } = await import('./ui/mapEditor.ts');
    openMapEditor(renderer, state as never);
    await new Promise((resolve) => setTimeout(resolve, 0)); // repo list arrives

    const panel = doc.body.querySelector('#map-editor')!;
    panel
      .querySelectorAll('.map-editor-tool')
      .find((b) => b.dataset['tool'] === 'place')!
      .click();

    const picker = panel.querySelector('.map-editor-select')!;
    expect(picker.children.map((o) => o.value)).toContain('/workspace/extra');
    picker.value = '/workspace/extra';
    picker.dispatch('change');

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    expect(state.world.cities).toHaveLength(1);

    // The toolbar was redrawn: the repo is on the map now, so it is filtered out.
    const redrawn = panel.querySelector('.map-editor-select')!;
    expect(redrawn.children.map((o) => o.value)).not.toContain('/workspace/extra');
  });
});

describe('Renderer map editor — toolbar', () => {
  it('keeps the close button across tool switches and closes the editor', async () => {
    const { doc } = makeFakeDocument();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('Option', FakeOption);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => [] })),
    );
    const renderer = {
      setMapEditorMode: vi.fn(),
      setMapEditorTool: vi.fn(),
      setMapEditorTerrain: vi.fn(),
      setMapEditorNation: vi.fn(),
      setMapEditorRepo: vi.fn(),
    };
    const { openMapEditor, isMapEditorOpen } = await import('./ui/mapEditor.ts');
    openMapEditor(renderer as never);

    const panel = doc.body.querySelector('#map-editor')!;
    expect(panel.querySelector('.map-editor-close')).not.toBeNull();

    // renderToolbar() replaces the panel children on every switch: the ✕ used
    // to be thrown away with them and never came back.
    for (const tool of ['terrain', 'erase']) {
      panel
        .querySelectorAll('.map-editor-tool')
        .find((b) => b.dataset['tool'] === tool)!
        .click();
      expect(panel.querySelector('.map-editor-close')).not.toBeNull();
    }

    expect(isMapEditorOpen()).toBe(true);
    panel.querySelector('.map-editor-close')!.click();
    expect(renderer.setMapEditorMode).toHaveBeenLastCalledWith(false);
    expect(panel.classList.contains('hidden')).toBe(true);
    expect(isMapEditorOpen()).toBe(false);
  });

  it('leaves Escape to the global hotkeys instead of wiring its own', async () => {
    const { canvas } = makeFakeCanvas();
    const state = makeState([], []);
    const renderer = new Renderer(canvas, state as never);
    const doc = document as unknown as {
      addEventListener: { mock: { calls: Array<[string, unknown]> } };
    };
    const keydowns = () => doc.addEventListener.mock.calls.filter(([type]) => type === 'keydown');
    const before = keydowns().length;

    const { initMapEditor } = await import('./ui/mapEditor.ts');
    initMapEditor(renderer, state as never);

    expect(keydowns().length).toBe(before);
  });
});
