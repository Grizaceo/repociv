// ─── RepoCiv — Renderer input isolation (Phase 6 local view) ─────────────────
//
// Regression: when the user enters the local 2D isometric view, the global
// renderer's canvas listeners were still firing on every mousedown/mousemove/
// mouseup/wheel/contextmenu/dblclick/mouseleave. Both the global renderer
// and the LocalRenderer attach to the same HTMLCanvasElement, so a click
// in the local view would also call global pickAxial() with screen coords
// and open a different city's panel ("ciertas casillas en local view
// abren ventanas de otras ciudades", reported 2026-06-12, recurring).
//
// Fix in three layers, all enforced by these tests:
//   1. The global renderer's setupInput listeners early-return on
//      state.viewMode === 'local' (bailIfLocal helper) OR if the canvas
//      has the data-local-active="true" attribute set by render().
//   2. The local renderer's setupInput listeners call
//      e.stopImmediatePropagation() so the global listeners never see the
//      event at all when they would otherwise run first.
//   3. handleClick() — the inner workhorse that mouseup reaches — also
//      bails on state.viewMode === 'local' and on the canvas attribute,
//      so any future code path that reaches it without the listener
//      guard is also safe.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────
// We mock the heavyweight collaborators the Renderer constructor pulls in
// so we can construct it in a unit-test environment. The point of these
// tests is NOT to exercise the rendering pipeline — only the input guards.

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

vi.mock('./ui/wonderVignette.ts', () => ({
  openWonderVignette: vi.fn(),
}));

vi.mock('./ui/capitalPanel.ts', () => ({
  openCapitalPanel: vi.fn(),
}));

vi.mock('./ui/layerPanel.ts', () => ({
  updateLodDisplay: vi.fn(),
}));

vi.mock('./ui/spatialPreview.ts', () => ({
  hideDirectivePreview: vi.fn(),
  hideContextMenu: vi.fn(),
  showDirectivePreview: vi.fn(),
  showContextMenu: vi.fn(),
  showDragTooltip: vi.fn(),
  notifyTilePicked: vi.fn(),
}));

vi.mock('./ui/constructionPanel.ts', () => ({
  refreshCityList: vi.fn(),
}));

// ─── DOM / window / ResizeObserver stubs ──────────────────────────────────────
// The repo deliberately avoids jsdom (see vite.config.ts coverage excludes).
// We follow the existing game.test.ts / map.test.ts pattern of stubbing
// just the browser globals the renderer + localRenderer touch.

class FakeMouseEvent {
  type: string;
  button = 0;
  clientX = 0;
  clientY = 0;
  bubbles = false;
  cancelable = false;
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

class FakeResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

const fakeStyle = {
  getPropertyValue: vi.fn(() => ''),
};

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
  reset() {
    this._set.clear();
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
    reset() {
      this._set.clear();
    },
  },
};

const documentListeners: Record<string, Array<(e: Event) => void>> = {};
const windowListeners: Record<string, Array<(e: Event) => void>> = {};

function installBrowserGlobals() {
  bodyClassList.reset();
  fakeFrame.classList.reset();
  for (const k of Object.keys(documentListeners)) delete documentListeners[k];
  for (const k of Object.keys(windowListeners)) delete windowListeners[k];

  vi.stubGlobal('MouseEvent', FakeMouseEvent);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
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
    addEventListener: vi.fn((type: string, fn: (e: Event) => void) => {
      (documentListeners[type] ??= []).push(fn);
    }),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('window', {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: vi.fn((type: string, fn: (e: Event) => void) => {
      (windowListeners[type] ??= []).push(fn);
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
}

installBrowserGlobals();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A minimal canvas stub: getContext('2d') returns a no-op 2D context,
 *  getBoundingClientRect returns a fixed rect, addEventListener stores
 *  the listener so tests can dispatch and observe. */
function makeFakeCanvas() {
  type Listener = (e: Event) => void;
  const listeners: Record<string, Listener[]> = {};
  const ctxStub = new Proxy(
    {},
    {
      get: () => vi.fn(),
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 800,
    height: 600,
    tabIndex: 0,
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
  // Mimic real DOM dispatch: stopImmediatePropagation halts the remaining
  // listeners on the same target, stopPropagation only affects bubbling
  // to ancestors (not relevant at the element level).
  return {
    canvas,
    listeners,
    fire: (type: string, ev: Event) => {
      for (const l of listeners[type] ?? []) {
        l(ev);
        if (
          (ev as unknown as { immediatePropagationStopped?: boolean }).immediatePropagationStopped
        )
          break;
      }
    },
  };
}

/** A minimal GameState stub. The renderer's listeners only need a few
 *  methods; we wire them as vi.fn() so tests can assert call counts. */
function makeFakeState() {
  return {
    viewMode: 'macro' as 'macro' | 'local',
    world: {
      tiles: new Map() as Map<string, unknown>,
      cities: [] as unknown[],
      units: [] as unknown[],
      buildings: [] as unknown[],
    },
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

// ─── Setup ────────────────────────────────────────────────────────────────────
let Renderer: typeof import('./renderer.ts').Renderer;

beforeEach(async () => {
  installBrowserGlobals();
  vi.resetModules();
  const mod = await import('./renderer.ts');
  Renderer = mod.Renderer;
});

afterEach(() => {
  bodyClassList.reset();
  fakeFrame.classList.reset();
});

// ─── Test (a): local-mode click does NOT call global pickAxial ────────────────
describe('Renderer input isolation — local view does not fire global pickAxial', () => {
  it('mousedown in local mode is short-circuited before pickAxial/state lookup', () => {
    const { canvas, listeners, fire } = makeFakeCanvas();
    const state = makeFakeState();
    state.viewMode = 'local';
    const renderer = new Renderer(canvas, state as never);

    // Spy on the private pickAxial and assert it is not consulted
    // when the user mousedown-clicks while in local view.
    const pickAxialSpy = vi.fn();
    (renderer as unknown as { pickAxial: typeof pickAxialSpy }).pickAxial = pickAxialSpy;

    // Pre-condition: at least one mousedown listener was registered on
    // the canvas. If not, the test below is meaningless.
    expect(listeners['mousedown']?.length ?? 0).toBeGreaterThan(0);

    fire('mousedown', new MouseEvent('mousedown', { button: 0, clientX: 200, clientY: 200 }));

    // The global handler must have early-returned; the state methods
    // that the mousedown handler would have called must be untouched.
    expect(pickAxialSpy).not.toHaveBeenCalled();
    expect(state.getUnitAt).not.toHaveBeenCalled();
    // tiles.get is called on the Map, not as a state method — but if
    // the guard works, no coord was computed at all.
  });

  it('the canvas data-local-active attribute is set to "true" while local view is active', () => {
    const { canvas } = makeFakeCanvas();
    const state = makeFakeState();
    const renderer = new Renderer(canvas, state as never);

    // Constructor seeds the dataset
    expect(canvas.dataset['localActive']).toBe('false');

    // Drive render() into local mode by setting viewMode + a stub localR
    state.viewMode = 'local';
    const fakeLocalR = {
      setInputActive: vi.fn(),
      setupInput: vi.fn(),
      setWorld: vi.fn(),
      render: vi.fn(),
      startEnterTransition: vi.fn(),
      startExitTransition: vi.fn(),
      isTransitionComplete: () => true,
      onRequestExit: null,
      onLocalUnitHover: null,
      onWorkbenchClick: null,
      onLocalUnitClick: null,
      onNpcClick: null,
      onTileClick: null,
      onUnitRendered: null,
      onZonePainted: null,
    };
    (renderer as unknown as { localR: unknown }).localR = fakeLocalR;
    (renderer as unknown as { render: () => void }).render();

    expect(canvas.dataset['localActive']).toBe('true');
  });
});

// ─── Test (b): macro-mode click still works (regression guard) ────────────────
describe('Renderer input isolation — macro mode still processes clicks', () => {
  it('mousedown in macro mode calls pickAxial and state.getUnitAt', () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeFakeState();
    state.viewMode = 'macro';
    const renderer = new Renderer(canvas, state as never);

    const pickAxialSpy = vi.fn(() => ({ q: 0, r: 0 }));
    (renderer as unknown as { pickAxial: typeof pickAxialSpy }).pickAxial = pickAxialSpy;

    fire('mousedown', new MouseEvent('mousedown', { button: 0, clientX: 200, clientY: 200 }));

    expect(pickAxialSpy).toHaveBeenCalledTimes(1);
    expect(state.getUnitAt).toHaveBeenCalled();
  });

  it('mousedown, mousemove, and mouseup all flow through in macro mode (drag-pan works)', () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeFakeState();
    const renderer = new Renderer(canvas, state as never);

    // mousedown starts a camera pan
    fire('mousedown', new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100 }));
    const dragStart = (renderer as unknown as { dragStart: { x: number; y: number } }).dragStart;
    expect(dragStart).toEqual({ x: 100, y: 100 });

    // mousemove while dragging should mutate cam.x / cam.y
    const cam = (renderer as unknown as { cam: { x: number; y: number } }).cam;
    const camBefore = { x: cam.x, y: cam.y };
    fire('mousemove', new MouseEvent('mousemove', { clientX: 150, clientY: 120 }));
    expect(cam.x === camBefore.x && cam.y === camBefore.y).toBe(false);
  });
});

// ─── Test (c): local-mode drag does NOT pan the global camera ────────────────
describe('Renderer input isolation — local mode drag does not pan global camera', () => {
  it('mousedown + mousemove in local mode leaves cam.x / cam.y unchanged', () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeFakeState();
    state.viewMode = 'local';
    const renderer = new Renderer(canvas, state as never);

    const cam = (renderer as unknown as { cam: { x: number; y: number } }).cam;
    const camStart = { x: cam.x, y: cam.y };
    const dragStart = (renderer as unknown as { dragStart: { x: number; y: number } }).dragStart;

    fire('mousedown', new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100 }));
    fire('mousemove', new MouseEvent('mousemove', { clientX: 200, clientY: 220 }));

    // dragStart must NOT have been written by the global handler
    expect(dragStart).toEqual({ x: 0, y: 0 });
    // cam must be untouched
    expect(cam.x).toBe(camStart.x);
    expect(cam.y).toBe(camStart.y);
  });

  it('handleClick backstop rejects clicks even if state and dataset both signal local', () => {
    const { canvas, fire } = makeFakeCanvas();
    const state = makeFakeState();
    const renderer = new Renderer(canvas, state as never);

    // Set local mode AFTER construction. The constructor wrote
    // localActive='false' and registered a mousedown that bails via
    // bailIfLocal — so a freshly dispatched mousedown in local mode
    // must NOT touch dragStart or any state method. This also exercises
    // the handleClick backstop indirectly: were the mousedown handler to
    // slip through, handleClick would still refuse via its own guard.
    state.viewMode = 'local';
    canvas.dataset['localActive'] = 'true';

    const dragStart = (renderer as unknown as { dragStart: { x: number; y: number } }).dragStart;
    fire('mousedown', new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100 }));
    fire('mouseup', new MouseEvent('mouseup', { button: 0, clientX: 100, clientY: 100 }));

    expect(dragStart).toEqual({ x: 0, y: 0 });
    expect(state.moveUnit).not.toHaveBeenCalled();
    expect(state.selectUnit).not.toHaveBeenCalled();
    expect(state.startBuilding).not.toHaveBeenCalled();
  });
});

// ─── Layer 2 sanity: localRenderer uses stopImmediatePropagation ─────────────
// Pure unit test of the localRenderer's stopBubble helper. Does not depend
// on the Renderer at all.

describe('LocalRenderer input isolation — stopImmediatePropagation on the canvas', () => {
  it('mousedown listener calls stopImmediatePropagation so a sibling listener is blocked', async () => {
    const { LocalRenderer } = await import('./localRenderer.ts');
    const { canvas, listeners, fire } = makeFakeCanvas();
    const lr = new LocalRenderer(canvas);
    lr.setupInput();
    lr.setInputActive(true);

    // Track stopImmediatePropagation on a synthetic event
    const e = new MouseEvent('mousedown', {
      button: 0,
      clientX: 50,
      clientY: 50,
      bubbles: true,
    });
    let immediateCalls = 0;
    const origImmediate = e.stopImmediatePropagation.bind(e);
    e.stopImmediatePropagation = vi.fn(() => {
      immediateCalls++;
      origImmediate();
    }) as typeof e.stopImmediatePropagation;

    // Attach a second listener AFTER setupInput so it sits behind the
    // localRenderer's mousedown. If the local renderer correctly calls
    // stopImmediatePropagation, this listener must never fire.
    const siblingListener = vi.fn();
    canvas.addEventListener('mousedown', siblingListener as never);

    fire('mousedown', e);

    // Layer 2: local mousedown must call stopImmediatePropagation
    expect(immediateCalls).toBeGreaterThan(0);
    // And it must do so BEFORE any other listener on the same element runs
    expect(siblingListener).not.toHaveBeenCalled();
    // Sanity: at least one local mousedown listener was actually registered
    expect(listeners['mousedown']?.length ?? 0).toBeGreaterThan(0);
  });
});
