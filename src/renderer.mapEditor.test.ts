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
  disabled = false;
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

  it('does not put an erased hex back into a territory when another city is founded', () => {
    const { canvas, fire } = makeFakeCanvas();
    const a = makeCity('a', { q: 0, r: 0 }, '/w/a');
    const state = makeState(
      [
        tile({ q: 0, r: 0 }, 'plains', a),
        tile({ q: 1, r: 0 }),
        tile({ q: 2, r: 0 }),
        tile({ q: 3, r: 0 }),
        tile({ q: 4, r: 0 }),
        tile({ q: 5, r: 0 }),
      ],
      [a],
    );
    const renderer = new Renderer(canvas, state as never);
    let hex: Axial = { q: 1, r: 0 };
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => hex;

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('erase');
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    expect(state.world.tiles.has('1,0')).toBe(false);

    hex = { q: 5, r: 0 };
    renderer.setMapEditorTool('place');
    renderer.setMapEditorRepo(extraRepo);
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    expect(state.world.cities).toHaveLength(2);

    expect(a.territory.some((t) => t.q === 1 && t.r === 0)).toBe(false);
  });

  it('keeps the hex, frees the districts and recalcs the territory of an erased city', () => {
    const { canvas, fire } = makeFakeCanvas();
    const gone = makeCity('gone', { q: 0, r: 0 }, '/w/gone');
    const district = {
      id: 'gone-src',
      name: 'src',
      type: 'campus' as const,
      coord: { q: 1, r: 0 },
    };
    gone.districts = [district];
    const stay = makeCity('stay', { q: 3, r: 0 }, '/w/stay');
    const state = makeState(
      [
        tile({ q: 0, r: 0 }, 'plains', gone),
        { ...tile({ q: 1, r: 0 }), district },
        tile({ q: 2, r: 0 }),
        tile({ q: 3, r: 0 }, 'plains', stay),
      ],
      [gone, stay],
    );
    const renderer = new Renderer(canvas, state as never);
    let hex: Axial = { q: 0, r: 0 };
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => hex;

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('erase');
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);

    expect(state.world.cities.map((c) => c.id)).toEqual(['stay']);
    expect(state.world.tiles.has('0,0')).toBe(true);
    expect(state.world.tiles.get('0,0')?.city).toBeUndefined();
    expect(state.world.tiles.get('1,0')?.district).toBeUndefined();
    expect(stay.territory.some((t) => t.q === 1 && t.r === 0)).toBe(true);

    // The freed district hex can now be erased like any other hex.
    hex = { q: 1, r: 0 };
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    expect(state.world.tiles.has('1,0')).toBe(false);
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
  it('refuses to found on a district hex', () => {
    const { canvas, fire } = makeFakeCanvas();
    const owner = makeCity('owner', { q: 0, r: 0 }, '/w/owner');
    const district = {
      id: 'owner-src',
      name: 'src',
      type: 'campus' as const,
      coord: { q: 1, r: 0 },
    };
    owner.districts = [district];
    const state = makeState(
      [tile({ q: 0, r: 0 }, 'plains', owner), { ...tile({ q: 1, r: 0 }), district }],
      [owner],
    );
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('place');
    renderer.setMapEditorRepo(extraRepo);

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);

    expect(state.world.cities).toHaveLength(1);
    expect(state.world.tiles.get('1,0')?.district?.id).toBe('owner-src');
  });

  it('refuses to found on the ocean', () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 1, r: 0 }, 'ocean')], []);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('place');
    renderer.setMapEditorRepo(extraRepo);

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);

    expect(state.world.cities).toHaveLength(0);
  });

  it('keeps the painted terrain of the hex it founds on', () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 1, r: 0 })], []);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('terrain');
    renderer.setMapEditorTerrain('forest');
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    expect(state.world.tiles.get('1,0')?.terrain).toBe('forest');

    renderer.setMapEditorTool('place');
    renderer.setMapEditorRepo(extraRepo);
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);

    expect(state.world.cities).toHaveLength(1);
    expect(state.world.tiles.get('1,0')?.terrain).toBe('forest');
  });

  it('uses plains when the hex is not painted, whatever it looks like', () => {
    const { canvas, fire } = makeFakeCanvas();
    // Fill terrain is randomized per load: an unpainted forest hex must not be
    // kept, or the city would change terrain on every reload.
    const state = makeState([tile({ q: 1, r: 0 }, 'forest')], []);
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('place');
    renderer.setMapEditorRepo(extraRepo);
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);

    expect(state.world.cities).toHaveLength(1);
    expect(state.world.tiles.get('1,0')?.terrain).toBe('plains');
  });

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

describe('Renderer map editor — history round trips', () => {
  async function snapshot(state: { world: World }) {
    const { getMapEdits } = await import('./mapEdits.ts');
    const { getNationStore } = await import('./nations.ts');
    const tiles: Record<string, string> = {};
    for (const [key, tile] of state.world.tiles) {
      tiles[key] = `${tile.terrain}|${tile.city?.id ?? ''}|${tile.district?.id ?? ''}`;
    }
    const edits = getMapEdits();
    return {
      tiles,
      cities: state.world.cities.map((c) => `${c.id}@${c.coord.q},${c.coord.r}`).sort(),
      units: state.world.units.map((u) => `${u.id}@${u.coord.q},${u.coord.r}`).sort(),
      terrain: { ...edits.terrain },
      removedHexes: [...edits.removedHexes].sort(),
      removedCities: [...edits.removedCities].sort(),
      placed: edits.placedCities.map((p) => `${p.repoPath}@${p.coord.q},${p.coord.r}`).sort(),
      nations: { ...getNationStore().assignments },
    };
  }

  async function dragCity(
    renderer: InstanceType<typeof Renderer>,
    fire: (type: string, ev: Event) => void,
    from: Axial,
    to: Axial,
  ) {
    let hex = from;
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => hex;
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    hex = to;
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 40, clientY: 10 }) as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('move: undo, redo and undo again keep the city on its hex', async () => {
    const { canvas, fire } = makeFakeCanvas();
    const c = makeCity('c', { q: 0, r: 0 }, '/w/c');
    const state = makeState([tile({ q: 0, r: 0 }, 'plains', c), tile({ q: 3, r: 0 })], [c]);
    const renderer = new Renderer(canvas, state as never);
    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('move');

    const before = await snapshot(state);
    await dragCity(renderer, fire, { q: 0, r: 0 }, { q: 3, r: 0 });
    const after = await snapshot(state);
    expect(after).not.toEqual(before);

    expect(renderer.undoLastMapEdit()).toBe('Mover c');
    expect(await snapshot(state)).toEqual(before);
    expect(state.world.tiles.get('0,0')?.city).toBe(c);

    expect(renderer.redoLastMapEdit()).toBe('Mover c');
    expect(await snapshot(state)).toEqual(after);

    expect(renderer.undoLastMapEdit()).toBe('Mover c');
    expect(await snapshot(state)).toEqual(before);
    expect(state.world.tiles.get('0,0')?.city).toBe(c);
    expect(state.world.tiles.get('3,0')?.city).toBeUndefined();

    expect(renderer.redoLastMapEdit()).toBe('Mover c');
    expect(await snapshot(state)).toEqual(after);
  });

  it('stacks the move in the same turn the city is dropped', () => {
    const { canvas, fire } = makeFakeCanvas();
    const c = makeCity('c', { q: 0, r: 0 }, '/w/c');
    const state = makeState(
      [tile({ q: 0, r: 0 }, 'plains', c), tile({ q: 1, r: 0 }), tile({ q: 3, r: 0 })],
      [c],
    );
    const renderer = new Renderer(canvas, state as never);
    let hex: Axial = { q: 1, r: 0 };
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => hex;

    // A brush stroke first, so an undo that runs before the move is stacked
    // would undo the paint instead.
    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('terrain');
    renderer.setMapEditorTerrain('mountain');
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);

    renderer.setMapEditorTool('move');
    hex = { q: 0, r: 0 };
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    hex = { q: 3, r: 0 };
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 40, clientY: 10 }) as never);

    // No promise flush: the move has to be on the stack already.
    expect(renderer.undoLastMapEdit()).toBe('Mover c');
    expect(c.coord).toEqual({ q: 0, r: 0 });
    expect(state.world.tiles.get('0,0')?.city).toBe(c);
  });

  it('remove city: undo, redo and undo again match before and after', async () => {
    const { canvas, fire } = makeFakeCanvas();
    const c = makeCity('gone', { q: 0, r: 0 }, '/w/gone');
    const state = makeState([tile({ q: 0, r: 0 }, 'plains', c), tile({ q: 2, r: 0 })], [c]);
    const renderer = new Renderer(canvas, state as never);
    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('erase');
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 0, r: 0 });

    const before = await snapshot(state);
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    const after = await snapshot(state);
    expect(after).not.toEqual(before);

    expect(renderer.undoLastMapEdit()).toBe('Sacar gone');
    expect(await snapshot(state)).toEqual(before);
    expect(renderer.redoLastMapEdit()).toBe('Sacar gone');
    expect(await snapshot(state)).toEqual(after);
    expect(renderer.undoLastMapEdit()).toBe('Sacar gone');
    expect(await snapshot(state)).toEqual(before);
    expect(renderer.redoLastMapEdit()).toBe('Sacar gone');
    expect(await snapshot(state)).toEqual(after);
  });

  it('redo of a removal takes the units that joined meanwhile through GameState', async () => {
    const { GameState } = await import('./game.ts');
    const { canvas, fire } = makeFakeCanvas();
    const city = makeCity('repociv', { q: 0, r: 0 }, '/workspace/repociv');
    const state = new GameState(makeWorld([tile({ q: 0, r: 0 }, 'plains', city)], [city]));
    state.spawnUnit('MAIN', 'MAIN', 'hero', 'gris', { q: 0, r: 0 }, undefined, city.id);
    const renderer = new Renderer(canvas, state as never);
    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('erase');
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 0, r: 0 });

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    expect(state.getUnit('MAIN')).toBeUndefined();

    renderer.undoLastMapEdit();
    expect(state.getUnit('MAIN')).toBeDefined();
    // An agent joins the city between the undo and the redo.
    const late = state.spawnUnit(
      'LATE',
      'LATE',
      'hero',
      'gris',
      { q: 0, r: 0 },
      undefined,
      city.id,
    );

    renderer.redoLastMapEdit();
    expect(state.getUnit('MAIN')).toBeUndefined();
    expect(state.getUnit('LATE')).toBeUndefined();
    expect(state.world.units.some((u) => u.id === late.id)).toBe(false);
  });

  it('found: undo, redo and undo again match before and after', async () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 1, r: 0 })], []);
    const renderer = new Renderer(canvas, state as never);
    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('place');
    renderer.setMapEditorRepo(extraRepo);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    const before = await snapshot(state);
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    const after = await snapshot(state);
    expect(after).not.toEqual(before);

    expect(renderer.undoLastMapEdit()).toBe('Fundar extra');
    expect(await snapshot(state)).toEqual(before);
    expect(renderer.redoLastMapEdit()).toBe('Fundar extra');
    expect(await snapshot(state)).toEqual(after);
    expect(renderer.undoLastMapEdit()).toBe('Fundar extra');
    expect(await snapshot(state)).toEqual(before);
    expect(renderer.redoLastMapEdit()).toBe('Fundar extra');
    expect(await snapshot(state)).toEqual(after);
  });

  it('redo of a removal finds the city a redone founding built', async () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 1, r: 0 })], []);
    const renderer = new Renderer(canvas, state as never);
    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('place');
    renderer.setMapEditorRepo(extraRepo);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    renderer.setMapEditorTool('erase');
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    const removed = await snapshot(state);

    expect(renderer.undoLastMapEdit()).toBe('Sacar extra');
    expect(renderer.undoLastMapEdit()).toBe('Fundar extra');
    expect(renderer.redoLastMapEdit()).toBe('Fundar extra');
    expect(renderer.redoLastMapEdit()).toBe('Sacar extra');
    expect(await snapshot(state)).toEqual(removed);

    expect(renderer.undoLastMapEdit()).toBe('Sacar extra');
    expect(state.world.cities).toHaveLength(1);
  });

  it('undo of a founding takes its units through GameState', async () => {
    const { GameState } = await import('./game.ts');
    const { canvas, fire } = makeFakeCanvas();
    const state = new GameState(makeWorld([tile({ q: 1, r: 0 })], []));
    const renderer = new Renderer(canvas, state as never);
    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('place');
    renderer.setMapEditorRepo(extraRepo);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    const city = state.world.cities[0]!;
    // An agent of the new city appears before the undo.
    const unit = state.spawnUnit('NEW', 'NEW', 'hero', 'gris', { q: 1, r: 0 }, undefined, city.id);

    expect(renderer.undoLastMapEdit()).toBe('Fundar extra');
    expect(state.getUnit('NEW')).toBeUndefined();
    expect(state.world.units.some((u) => u.id === unit.id)).toBe(false);

    expect(renderer.redoLastMapEdit()).toBe('Fundar extra');
    expect(state.getUnit('NEW')).toBe(unit);
    expect(state.world.units.some((u) => u.id === unit.id)).toBe(true);
  });

  it('erase hex: undo, redo and undo again match before and after', async () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 0, r: 0 }), tile({ q: 1, r: 0 })], []);
    const renderer = new Renderer(canvas, state as never);
    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('erase');
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    const before = await snapshot(state);
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    const after = await snapshot(state);

    expect(renderer.undoLastMapEdit()).toBe('Borrar hex');
    expect(await snapshot(state)).toEqual(before);
    expect(renderer.redoLastMapEdit()).toBe('Borrar hex');
    expect(await snapshot(state)).toEqual(after);
    expect(renderer.undoLastMapEdit()).toBe('Borrar hex');
    expect(await snapshot(state)).toEqual(before);
    expect(renderer.redoLastMapEdit()).toBe('Borrar hex');
    expect(await snapshot(state)).toEqual(after);
  });

  it('paint: undo, redo and undo again match before and after', async () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 1, r: 0 })], []);
    const renderer = new Renderer(canvas, state as never);
    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('terrain');
    renderer.setMapEditorTerrain('mountain');
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 1, r: 0 });

    const before = await snapshot(state);
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    const after = await snapshot(state);

    expect(renderer.undoLastMapEdit()).toBe('Pintar');
    expect(await snapshot(state)).toEqual(before);
    expect(renderer.redoLastMapEdit()).toBe('Pintar');
    expect(await snapshot(state)).toEqual(after);
    expect(renderer.undoLastMapEdit()).toBe('Pintar');
    expect(await snapshot(state)).toEqual(before);
    expect(renderer.redoLastMapEdit()).toBe('Pintar');
    expect(await snapshot(state)).toEqual(after);
  });

  it('nation: undo, redo and undo again match before and after', async () => {
    const { createNation } = await import('./nations.ts');
    const nation = createNation('Imperio');
    const { canvas, fire } = makeFakeCanvas();
    const c = makeCity('c', { q: 0, r: 0 }, '/w/c');
    const state = makeState([tile({ q: 0, r: 0 }, 'plains', c)], [c]);
    const renderer = new Renderer(canvas, state as never);
    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('nation');
    renderer.setMapEditorNation(nation.id);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 0, r: 0 });

    const before = await snapshot(state);
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    const after = await snapshot(state);
    expect(after).not.toEqual(before);

    expect(renderer.undoLastMapEdit()).toBe('Nación de c');
    expect(await snapshot(state)).toEqual(before);
    expect(renderer.redoLastMapEdit()).toBe('Nación de c');
    expect(await snapshot(state)).toEqual(after);
    expect(renderer.undoLastMapEdit()).toBe('Nación de c');
    expect(await snapshot(state)).toEqual(before);
    expect(renderer.redoLastMapEdit()).toBe('Nación de c');
    expect(await snapshot(state)).toEqual(after);
  });
});

describe('Renderer map editor — history bar', () => {
  async function openBar() {
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
      undoLastMapEdit: vi.fn(),
      redoLastMapEdit: vi.fn(),
    };
    const { openMapEditor } = await import('./ui/mapEditor.ts');
    const history = await import('./mapEditHistory.ts');
    history.clearMapEditHistory();
    openMapEditor(renderer as never);
    const panel = doc.body.querySelector('#map-editor')!;
    const buttons = () => panel.querySelectorAll('.map-editor-history-btn');
    return { doc, panel, buttons, renderer, history };
  }

  it('shows undo and redo disabled until there is history', async () => {
    const { buttons, history } = await openBar();
    expect(buttons()).toHaveLength(2);
    expect(buttons()[0]!.disabled).toBe(true);
    expect(buttons()[1]!.disabled).toBe(true);

    history.pushMapEdit({ label: 'Pintar', undo: () => {}, redo: () => {} });

    expect(buttons()[0]!.disabled).toBe(false);
    expect(buttons()[0]!.title).toBe('Deshacer: Pintar (Ctrl+Z)');
    expect(buttons()[1]!.disabled).toBe(true);
  });

  it('keeps the buttons across tool switches and they call the renderer', async () => {
    const { panel, buttons, renderer, history } = await openBar();
    history.pushMapEdit({ label: 'Fundar extra', undo: () => {}, redo: () => {} });

    for (const tool of ['terrain', 'erase']) {
      panel
        .querySelectorAll('.map-editor-tool')
        .find((b) => b.dataset['tool'] === tool)!
        .click();
      expect(buttons()).toHaveLength(2);
    }

    const undo = buttons()[0]!;
    expect(undo.disabled).toBe(false);
    undo.click();
    expect(renderer.undoLastMapEdit).toHaveBeenCalledTimes(1);
  });

  it('restore asks first and does nothing when cancelled', async () => {
    const { doc, panel } = await openBar();
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);

    const { placeCity, getMapEdits } = await import('./mapEdits.ts');
    placeCity({ repoPath: '/w/extra', repoName: 'extra', coord: { q: 1, r: 0 } });

    const restore = panel.querySelector('.map-editor-restore')!;
    restore.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(getMapEdits().placedCities).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    expect(doc.body.querySelector('#map-editor')).toBe(panel);
  });

  it('restore clears every edit and reloads when accepted', async () => {
    const { panel } = await openBar();
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );

    const { placeCity, getMapEdits } = await import('./mapEdits.ts');
    const { canUndoMapEdit, pushMapEdit } = await import('./mapEditHistory.ts');
    placeCity({ repoPath: '/w/extra', repoName: 'extra', coord: { q: 1, r: 0 } });
    pushMapEdit({ label: 'Pintar', undo: () => {}, redo: () => {} });

    panel.querySelector('.map-editor-restore')!.click();

    expect(getMapEdits().placedCities).toHaveLength(0);
    expect(canUndoMapEdit()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('Renderer map editor — undo and redo', () => {
  it('undoes a whole brush stroke with one step and redoes it', async () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 1, r: 2 }), tile({ q: 2, r: 2 }), tile({ q: 3, r: 2 })], []);
    const renderer = new Renderer(canvas, state as never);
    let hex: Axial = { q: 1, r: 2 };
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => hex;

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('terrain');
    renderer.setMapEditorTerrain('mountain');
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    hex = { q: 2, r: 2 };
    fire('mousemove', new FakeMouseEvent('mousemove', { clientX: 12, clientY: 10 }) as never);
    hex = { q: 3, r: 2 };
    fire('mousemove', new FakeMouseEvent('mousemove', { clientX: 14, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 14, clientY: 10 }) as never);
    const painted = () => ['1,2', '2,2', '3,2'].map((k) => state.world.tiles.get(k)?.terrain);
    expect(painted()).toEqual(['mountain', 'mountain', 'mountain']);

    expect(renderer.undoLastMapEdit()).toBe('Pintar');
    expect(painted()).toEqual(['plains', 'plains', 'plains']);

    expect(renderer.redoLastMapEdit()).toBe('Pintar');
    expect(painted()).toEqual(['mountain', 'mountain', 'mountain']);
  });

  it('brings back a removed city and its unit, and removes them again on redo', async () => {
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
    const renderer = new Renderer(canvas, state as never);
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => ({ q: 0, r: 0 });

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('erase');
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    expect(state.world.cities).toHaveLength(0);
    expect(state.getUnit('MAIN')).toBeUndefined();

    expect(renderer.undoLastMapEdit()).toBe('Sacar repociv');
    expect(state.world.cities).toHaveLength(1);
    expect(state.getUnit('MAIN')).toBe(unit);
    expect(state.world.tiles.get('0,0')?.city?.id).toBe('repociv');

    expect(renderer.redoLastMapEdit()).toBe('Sacar repociv');
    expect(state.world.cities).toHaveLength(0);
    expect(state.getUnit('MAIN')).toBeUndefined();
  });

  it('puts the repo back in the picker when a founding is undone', async () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeState([tile({ q: 1, r: 0 }), tile({ q: 2, r: 0 })], []);
    const renderer = new Renderer(canvas, state as never);
    let hex: Axial = { q: 1, r: 0 };
    (renderer as unknown as { pickAxial: () => Axial }).pickAxial = () => hex;

    renderer.setMapEditorMode(true);
    renderer.setMapEditorTool('place');
    renderer.setMapEditorRepo(extraRepo);
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    expect(state.world.cities).toHaveLength(1);

    expect(renderer.undoLastMapEdit()).toBe('Fundar extra');
    expect(state.world.cities).toHaveLength(0);

    expect(renderer.redoLastMapEdit()).toBe('Fundar extra');
    expect(state.world.cities).toHaveLength(1);
    expect(state.world.cities[0]?.coord).toEqual({ q: 1, r: 0 });

    // Undo again: the repo is selected again, so another hex can be founded.
    expect(renderer.undoLastMapEdit()).toBe('Fundar extra');
    hex = { q: 2, r: 0 };
    fire('mousedown', new FakeMouseEvent('mousedown', { clientX: 10, clientY: 10 }) as never);
    fire('mouseup', new FakeMouseEvent('mouseup', { clientX: 10, clientY: 10 }) as never);
    expect(state.world.cities).toHaveLength(1);
    expect(state.world.cities[0]?.coord).toEqual({ q: 2, r: 0 });
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
