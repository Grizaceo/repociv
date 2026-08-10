import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LocalWorld, LocalTile, LocalUnit, LocalNpc } from '../types.ts';

// No jsdom in this project — stub the DOM manually (see mcpStatus.test.ts pattern).

// ─── Mock WebGLRenderer ───────────────────────────────────────────────────
// three's WebGLRenderer needs a real WebGL context. We mock just that class
// and re-export the rest of three untouched.
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class FakeWebGLRenderer {
    domElement: HTMLCanvasElement;
    toneMapping = 0;
    toneMappingExposure = 1;
    shadowMap = { enabled: false, type: 0 };
    constructor() {
      this.domElement = {
        style: {},
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        remove: vi.fn(),
      } as unknown as HTMLCanvasElement;
    }
    setPixelRatio() {}
    setClearColor() {}
    setSize() {}
    render() {}
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

// Stub ResizeObserver (not available in node)
class FakeResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

// ─── DOM stubs ─────────────────────────────────────────────────────────────
function fakeContainer(): HTMLElement {
  const children: HTMLElement[] = [];
  const classList = new Set<string>();
  return {
    appendChild: vi.fn((c: HTMLElement) => {
      children.push(c);
      return c;
    }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    classList: {
      toggle: (name: string, on?: boolean) => {
        const want = on ?? !classList.has(name);
        if (want) classList.add(name);
        else classList.delete(name);
      },
      contains: (n: string) => classList.has(n),
      add: (n: string) => classList.add(n),
      remove: (n: string) => classList.delete(n),
    },
    children,
  } as unknown as HTMLElement;
}

function makeWorld(w = 2, h = 2): LocalWorld {
  const grid: LocalTile[][] = [];
  for (let y = 0; y < h; y++) {
    const row: LocalTile[] = [];
    for (let x = 0; x < w; x++) {
      row.push({ x, y, type: 'floor' as const, roomId: null, workbench: null });
    }
    grid.push(row);
  }
  return {
    repoId: 'test',
    grid,
    rooms: [],
    width: w,
    height: h,
    workbenches: [],
    deskAssignments: new Map(),
  };
}

let container: HTMLElement;

beforeEach(() => {
  container = fakeContainer();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('performance', { now: () => Date.now() });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Import after mocks are set up
async function makeScene() {
  const { LocalScene3D } = await import('./LocalScene3D.ts');
  return new LocalScene3D(container);
}

describe('LocalScene3D', () => {
  it('constructs with a container element', async () => {
    const scene = await makeScene();
    expect(scene).toBeDefined();
    expect(scene.isActive()).toBe(false);
    scene.dispose();
  });

  it('setActive toggles active state', async () => {
    const scene = await makeScene();
    scene.setActive(true);
    expect(scene.isActive()).toBe(true);
    scene.setActive(false);
    expect(scene.isActive()).toBe(false);
    scene.dispose();
  });

  it('setWorld stores world without crashing', async () => {
    const scene = await makeScene();
    const world = makeWorld(4, 3);
    scene.setWorld(world);
    scene.setActive(true);
    scene.render({ x: 0, y: 0, zoom: 1, cx: 100, cy: 100 }, [], [], {
      dt: 0.016,
      workbenchLabelOverlay: false,
      powerOverlay: false,
      temperatureOverlay: false,
    });
    scene.dispose();
  });

  it('render is a no-op when inactive', async () => {
    const scene = await makeScene();
    const world = makeWorld();
    scene.setWorld(world);
    // not active — render should silently return
    scene.render({ x: 0, y: 0, zoom: 1, cx: 50, cy: 50 }, [], [], {
      dt: 0.016,
      workbenchLabelOverlay: false,
      powerOverlay: false,
      temperatureOverlay: false,
    });
    scene.dispose();
  });

  it('render is a no-op without world', async () => {
    const scene = await makeScene();
    scene.setActive(true);
    scene.render({ x: 0, y: 0, zoom: 1, cx: 50, cy: 50 }, [], [], {
      dt: 0.016,
      workbenchLabelOverlay: false,
      powerOverlay: false,
      temperatureOverlay: false,
    });
    scene.dispose();
  });

  it('pickTile returns null when no floor mesh', async () => {
    const scene = await makeScene();
    expect(scene.pickTile(10, 10)).toBeNull();
    scene.dispose();
  });

  it('callbacks are null by default', async () => {
    const scene = await makeScene();
    expect(scene.callbacks.onTileClick).toBeNull();
    expect(scene.callbacks.onLocalUnitClick).toBeNull();
    expect(scene.callbacks.onWorkbenchClick).toBeNull();
    expect(scene.callbacks.onLocalUnitHover).toBeNull();
    expect(scene.callbacks.onNpcClick).toBeNull();
    expect(scene.callbacks.onUnitRendered).toBeNull();
    expect(scene.callbacks.onDragAssign).toBeNull();
    expect(scene.callbacks.onZonePainted).toBeNull();
    expect(scene.callbacks.onRequestExit).toBeNull();
    scene.dispose();
  });

  it('callbacks can be set', async () => {
    const scene = await makeScene();
    scene.callbacks.onTileClick = () => {};
    expect(scene.callbacks.onTileClick).toBeDefined();
    scene.dispose();
  });

  it('setAgentsForPicking stores units and npcs without crash', async () => {
    const scene = await makeScene();
    const units: LocalUnit[] = [
      {
        id: 'u1',
        name: 'A',
        unitType: 'worker',
        color: '#fff',
        gridX: 0,
        gridY: 0,
        targetX: null,
        targetY: null,
        path: [],
        pathIndex: 0,
        pathProgress: 0,
        state: 'idle_in_room',
        mission: null,
        workProgress: 0,
        macroUnitId: 'm1',
        currentWorkbenchId: null,
        fatigue: 100,
        maxFatigue: 100,
        isResting: false,
        effectiveSpeed: 1.0,
      },
    ];
    const npcs: LocalNpc[] = [
      {
        id: 'n1',
        name: 'M',
        color: '#fff',
        gridX: 1,
        gridY: 1,
        roomId: 'r1',
        type: 'manager',
      },
    ];
    scene.setAgentsForPicking(units, npcs);
    scene.dispose();
  });

  it('dispose cleans up without errors', async () => {
    const scene = await makeScene();
    scene.setWorld(makeWorld());
    scene.setActive(true);
    scene.dispose();
  });

  it('render with units and npcs does not crash', async () => {
    const scene = await makeScene();
    scene.setWorld(makeWorld(3, 3));
    scene.setActive(true);
    const units: LocalUnit[] = [
      {
        id: 'u1',
        name: 'A',
        unitType: 'worker',
        color: '#fff',
        gridX: 1,
        gridY: 1,
        targetX: null,
        targetY: null,
        path: [],
        pathIndex: 0,
        pathProgress: 0,
        state: 'idle_in_room',
        mission: null,
        workProgress: 0,
        macroUnitId: 'm1',
        currentWorkbenchId: null,
        fatigue: 100,
        maxFatigue: 100,
        isResting: false,
        effectiveSpeed: 1.0,
      },
    ];
    scene.render({ x: 50, y: 50, zoom: 1, cx: 150, cy: 150 }, units, [], {
      dt: 0.016,
      workbenchLabelOverlay: false,
      powerOverlay: false,
      temperatureOverlay: false,
    });
    scene.dispose();
  });
});
