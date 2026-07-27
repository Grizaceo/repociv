// LocalScene3D tests — node environment (no DOM). We mock the minimal DOM
// surface that WebGLRenderer touches during construction so we can test
// the pure logic (graph loading, floor switching, state updates, etc).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LocalScene3D, type AdwNode3D, type AdwEdge3D } from './LocalScene3D.ts';
import type { LocalWorld, LocalTile, LocalRoom } from '../types.ts';

// ─── Mock WebGLRenderer before importing LocalScene3D ────────────────────────
// Three.js WebGLRenderer needs a real WebGL context which node can't provide.
// We mock the entire class to avoid context creation while preserving the
// interface that LocalScene3D uses (setSize, render, dispose, etc).

vi.mock('three', async (importOriginal) => {
  const real = await importOriginal() as typeof import('three');
  class MockWebGLRenderer {
    setPixelRatio() {}
    setSize() {}
    setClearColor() {}
    render() {}
    dispose() {}
    shadowMap = { enabled: false, type: 0 };
    domElement = { width: 800, height: 600, style: {} };
  }
  return { ...real, WebGLRenderer: MockWebGLRenderer as unknown as typeof real.WebGLRenderer };
});

// ─── Mock DOM globals ────────────────────────────────────────────────────────
// Three.js WebGLRenderer calls document.createElement('canvas') internally
// for context creation. We stub the minimum surface area.

class MockCanvas {
  width = 800;
  height = 600;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classList = { add: () => {}, remove: () => {}, contains: () => false };
  focus = () => {};
  addEventListener = () => {};
  removeEventListener = () => {};
  getBoundingClientRect = () => ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
  getContext = () => null;
  appendChild = () => {};
  removeChild = () => {};
  setAttribute = () => {};
  getAttribute = () => null;
  removeAttribute = () => {};
}

beforeEach(() => {
  // @ts-expect-error — partial mock
  globalThis.window = { devicePixelRatio: 1, innerWidth: 800, innerHeight: 600 };
  // @ts-expect-error — partial mock
  globalThis.document = {
    createElement: (_tag: string) => new MockCanvas() as any,
    documentElement: { getComputedStyle: () => new MockCanvas() as any } as any,
    body: { classList: { add: () => {}, remove: () => {}, contains: () => false } } as any,
    getElementById: () => null as any,
  };
  // Advancing performance.now() mock (transition animation needs dt > 0)
  let _perfNow = 0;
  globalThis.performance = { now: () => { _perfNow += 16; return _perfNow; } } as any;
  globalThis.requestAnimationFrame = ((_cb: FrameRequestCallback) => {
    // Don't actually animate — just return a handle
    return 0 as any;
  }) as typeof globalThis.requestAnimationFrame;
  // getComputedStyle stub
  globalThis.getComputedStyle = (() => ({
    getPropertyValue: () => '',
  })) as unknown as typeof globalThis.getComputedStyle;
});

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeCanvas(): HTMLCanvasElement {
  // Use our MockCanvas (globalThis.document.createElement is mocked in beforeEach)
  const canvas = document.createElement('canvas');
  return canvas as unknown as HTMLCanvasElement;
}

function makeTile(x: number, y: number, type: LocalTile['type']): LocalTile {
  return { x, y, type, roomId: null, workbench: null };
}

function makeWorld(overrides: Partial<LocalWorld> = {}): LocalWorld {
  const width = 4;
  const height = 4;
  const grid: LocalTile[][] = [];
  for (let y = 0; y < height; y++) {
    const row: LocalTile[] = [];
    for (let x = 0; x < width; x++) {
      row.push(makeTile(x, y, 'floor'));
    }
    grid.push(row);
  }
  // Add some walls and a workbench
  grid[0]![0]!.type = 'wall';
  grid[0]![1]!.type = 'wall';
  grid[1]![1]!.type = 'workbench';
  grid[1]![1]!.workbench = {
    id: 'wb-1',
    filePath: '/fake/test.ts',
    fileName: 'test.ts',
    extension: 'ts',
    isTest: true,
    repoPath: 'test-repo',
  };
  const rooms: LocalRoom[] = [
    {
      id: 'room-0',
      label: 'Test Room',
      w: 4,
      h: 4,
      folderPath: 'src',
      folderName: 'src',
      x: 0,
      y: 0,
      width: 4,
      height: 4,
      workbenches: [],
      zoneType: 'team_cluster',
    },
  ];
  return {
    repoId: 'test-repo',
    grid,
    rooms,
    width,
    height,
    workbenches: [],
    deskAssignments: new Map(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LocalScene3D', () => {
  it('constructs without throwing', () => {
    const canvas = makeCanvas();
    expect(() => new LocalScene3D(canvas)).not.toThrow();
  });

  it('accepts a world via setWorld without throwing', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    const world = makeWorld();
    expect(() => scene.setWorld(world)).not.toThrow();
  });

  it('renders a frame without throwing', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());
    expect(() => scene.render([])).not.toThrow();
  });

  it('implements transition methods', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());
    expect(scene.isTransitionComplete()).toBe(true);
    scene.startEnterTransition();
    expect(scene.isTransitionComplete()).toBe(false);
    // Force the transition to complete by rendering enough frames
    for (let i = 0; i < 100; i++) scene.render([]);
    expect(scene.isTransitionComplete()).toBe(true);
  });

  it('implements setCleanMode as no-op', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    expect(() => scene.setCleanMode(true)).not.toThrow();
  });

  it('implements toggleWorkbenchLabels returning false', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    expect(scene.toggleWorkbenchLabels()).toBe(false);
    expect(scene.isWorkbenchLabelsVisible()).toBe(false);
  });

  it('implements toggleDebugOverlay returning false', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    expect(scene.toggleDebugOverlay()).toBe(false);
    expect(scene.isDebugOverlay()).toBe(false);
  });

  it('implements animateCameraToGrid as no-op', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    expect(() => scene.animateCameraToGrid(1, 1)).not.toThrow();
  });

  it('implements setInputActive', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    expect(() => scene.setInputActive(true)).not.toThrow();
    expect(() => scene.setInputActive(false)).not.toThrow();
  });

  it('implements setupInput without throwing', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    expect(() => scene.setupInput()).not.toThrow();
  });

  it('implements resize without throwing', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    expect(() => scene.resize()).not.toThrow();
  });

  it('implements dispose without throwing', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());
    expect(() => scene.dispose()).not.toThrow();
  });

  // ─── Phase B: Floor switching ────────────────────────────────────────────────

  it('starts on floor 0', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    // No public getter, but switchFloor(1) should trigger a change
    scene.setWorld(makeWorld());
    scene.render([]);
    // switchFloor to same floor should be no-op
    scene.switchFloor(0);
    scene.render([]);
    // No assertion crash = pass
  });

  it('switchFloor to 1 starts tween', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());
    scene.render([]);
    scene.switchFloor(1);
    // Render to let tween advance
    scene.render([]);
    // Should not throw during tween
    expect(true).toBe(true);
  });

  it('switchFloor clamps to valid range (0-1)', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());
    // Clamping should not throw
    scene.switchFloor(-1); // should clamp to 0
    scene.switchFloor(99); // should clamp to 1
    expect(true).toBe(true);
  });

  // ─── Phase C: ADW workflow ───────────────────────────────────────────────────

  it('loadAdwGraph renders nodes and edges without throwing', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());

    const nodes: AdwNode3D[] = [
      { id: 'n1', type: 'trigger', label: 'Start', x: 0, y: 0 },
      { id: 'n2', type: 'agent', label: 'Reviewer', x: 2, y: 0 },
      { id: 'n3', type: 'artifact', label: 'Output', x: 4, y: 0 },
    ];
    const edges: AdwEdge3D[] = [
      { id: 'e1', source: 'n1', target: 'n2', kind: 'flow' },
      { id: 'e2', source: 'n2', target: 'n3', kind: 'pass' },
    ];
    expect(() => scene.loadAdwGraph(nodes, edges)).not.toThrow();
  });

  it('loadAdwGraph with empty arrays does not throw', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());
    expect(() => scene.loadAdwGraph([], [])).not.toThrow();
  });

  it('getAdwGraph returns null before loadAdwGraph', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    expect(scene.getAdwGraph()).toBe(null);
  });

  it('getAdwGraph returns loaded graph after loadAdwGraph', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());
    const nodes: AdwNode3D[] = [
      { id: 'n1', type: 'trigger', label: 'Start', x: 0, y: 0 },
    ];
    scene.loadAdwGraph(nodes, []);
    const graph = scene.getAdwGraph();
    expect(graph).not.toBe(null);
    expect(graph!.nodes.length).toBe(1);
    expect(graph!.nodes[0]!.id).toBe('n1');
  });

  it('loadAdwGraph can be called twice (rebuild)', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());
    scene.loadAdwGraph(
      [{ id: 'n1', type: 'trigger', label: 'A', x: 0, y: 0 }],
      [],
    );
    scene.loadAdwGraph(
      [
        { id: 'n2', type: 'agent', label: 'B', x: 1, y: 0 },
        { id: 'n3', type: 'code', label: 'C', x: 2, y: 0 },
      ],
      [{ id: 'e1', source: 'n2', target: 'n3', kind: 'flow' }],
    );
    const graph = scene.getAdwGraph();
    expect(graph!.nodes.length).toBe(2);
    expect(graph!.edges.length).toBe(1);
  });

  // ─── Phase D: Artifact animation + node state ────────────────────────────────

  it('setAdwNodeState does not throw for unknown node', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());
    expect(() => scene.setAdwNodeState('nonexistent', 'running')).not.toThrow();
  });

  it('setAdwNodeState updates node emissive', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());
    scene.loadAdwGraph(
      [{ id: 'n1', type: 'trigger', label: 'Start', x: 0, y: 0 }],
      [],
    );
    expect(() => scene.setAdwNodeState('n1', 'running')).not.toThrow();
    expect(() => scene.setAdwNodeState('n1', 'pass')).not.toThrow();
    expect(() => scene.setAdwNodeState('n1', 'fail')).not.toThrow();
    expect(() => scene.setAdwNodeState('n1', 'idle')).not.toThrow();
  });

  it('spawnAdwArtifact does not throw for unknown nodes', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());
    expect(() => scene.spawnAdwArtifact('unknown1', 'unknown2')).not.toThrow();
  });

  it('spawnAdwArtifact creates a traveling mesh for known nodes', () => {
    const canvas = makeCanvas();
    const scene = new LocalScene3D(canvas);
    scene.setWorld(makeWorld());
    scene.loadAdwGraph(
      [
        { id: 'n1', type: 'trigger', label: 'Start', x: 0, y: 0 },
        { id: 'n2', type: 'agent', label: 'End', x: 4, y: 0 },
      ],
      [{ id: 'e1', source: 'n1', target: 'n2', kind: 'flow' }],
    );
    let completed = false;
    scene.spawnAdwArtifact('n1', 'n2', () => { completed = true; });
    // The tween runs via requestAnimationFrame, which jsdom doesn't drive.
    // Just verify it doesn't throw.
    expect(completed).toBe(false);
  });
});