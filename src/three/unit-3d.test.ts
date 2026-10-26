import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Mock UnitProps3D so we get the procedural fallback figurine (no async GLB),
// while preserving pure helpers (UNIT_ROLE_GLB_IDS, unitRoleGlbForType, extractUnitPartsFromScene).
vi.mock('./UnitProps3D.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./UnitProps3D.ts')>();
  return {
    ...actual,
    areUnitPropsReady: () => false,
    getUnitPropParts: () => null,
    getUnitPropPartsForType: () => null,
    ensureUnitPropsLoad: () => {},
    areUnitPropsSettled: () => true,
  };
});

import {
  clearUnits,
  rebuildUnits,
  tickUnits,
  _testGetEntry,
  _testEntryCount,
} from './UnitMesh3D.ts';
import {
  UNIT_ROLE_GLB_IDS,
  unitRoleGlbForType,
  extractUnitPartsFromScene,
  isUnitTintPart,
  KNOWLEDGE_CITY_UNIT_URLS,
} from './UnitProps3D.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { catmullRom, idleBreathScale, strideLift, yawToward } from './unitWalkPose.ts';
import type { City, Unit, Tile, Terrain } from '../types.ts';
import { createNation, resetNationStoreCache } from '../nations.ts';

function makeUnit(id: string, q: number, r: number, state: 'idle' | 'moving' = 'idle'): Unit {
  return {
    id,
    name: id,
    type: 'worker',
    civ: 'gris',
    coord: { q, r },
    path: [],
    pathIndex: 0,
    pathProgress: 0,
    state,
    speed: 1,
    color: '#4488ff',
    movesLeft: 2,
    maxMoves: 2,
    fatigue: 100,
    maxFatigue: 100,
    isResting: false,
    effectiveSpeed: 1,
  };
}

function makeTile(q: number, r: number, terrain: Terrain = 'plains'): Tile {
  return {
    coord: { q, r },
    terrain,
    resources: { gold: 0, science: 0, production: 0 },
    city: undefined,
    inFog: false,
    revealed: true,
  };
}

function makeCity(id: string, q: number, r: number): City {
  return {
    id,
    name: id,
    coord: { q, r },
    population: 1,
    territory: [],
    districts: [],
    buildings: [],
    isCapital: false,
  };
}

function movingUnit(
  id: string,
  path: { q: number; r: number }[],
  extras: Partial<Unit> = {},
): Unit {
  const start = path[0] ?? { q: 0, r: 0 };
  return { ...makeUnit(id, start.q, start.r, 'moving'), path, ...extras };
}

const tiles = new Map<string, Tile>([
  ['0,0', makeTile(0, 0)],
  ['1,0', makeTile(1, 0)],
  ['2,0', makeTile(2, 0)],
]);
const getTile = (key: string) => tiles.get(key);

afterEach(() => {
  clearUnits();
});

describe('UnitMesh3D lifecycle — spawn', () => {
  it('new units start at scale 0 (spawning state)', () => {
    rebuildUnits([makeUnit('u1', 0, 0)], getTile);
    const entry = _testGetEntry('u1');
    expect(entry).toBeDefined();
    expect(entry!.lifeState).toBe('spawning');
    expect(entry!.group.scale.x).toBe(0);
  });

  it('spawn tween grows scale 0→1 over 300ms with ease-out', () => {
    rebuildUnits([makeUnit('u1', 0, 0)], getTile);
    const entry = _testGetEntry('u1')!;

    // 150ms (halfway): scale should be > 0 and < 1.
    tickUnits(0.15, 0.15);
    expect(entry.group.scale.x).toBeGreaterThan(0);
    expect(entry.group.scale.x).toBeLessThan(1);

    // 300ms total: spawn complete.
    tickUnits(0.3, 0.15);
    expect(entry.lifeState).toBe('alive');
    // Easing makes it ~1.0 but idle breath immediately takes over.
    expect(entry.group.scale.x).toBeGreaterThan(0.95);
  });

  it('frozen animTime (dt=0) does not advance spawn tween', () => {
    rebuildUnits([makeUnit('u1', 0, 0)], getTile);
    const entry = _testGetEntry('u1')!;
    expect(entry.group.scale.x).toBe(0);

    tickUnits(2.0, 0.0);
    expect(entry.lifeState).toBe('spawning');
    expect(entry.group.scale.x).toBe(0);
  });
});

describe('UnitMesh3D lifecycle — despawn', () => {
  it('removed units enter despawning state and shrink to 0 over 200ms', () => {
    // Spawn first.
    rebuildUnits([makeUnit('u1', 0, 0)], getTile);
    tickUnits(0.3, 0.3); // complete spawn
    expect(_testGetEntry('u1')!.lifeState).toBe('alive');

    // Remove unit.
    rebuildUnits([], getTile);
    const entry = _testGetEntry('u1')!;
    expect(entry.lifeState).toBe('despawning');

    // 100ms (halfway): scale between 0 and 1.
    tickUnits(0.4, 0.1);
    expect(entry.group.scale.x).toBeGreaterThan(0);
    expect(entry.group.scale.x).toBeLessThan(1);

    // 200ms total: entry removed.
    tickUnits(0.5, 0.1);
    expect(_testGetEntry('u1')).toBeUndefined();
    expect(_testEntryCount()).toBe(0);
  });
});

describe('UnitMesh3D lifecycle — idle breath', () => {
  it('alive units oscillate scale around 1 with a subtle breath, not a token pulse', () => {
    rebuildUnits([makeUnit('u1', 0, 0)], getTile);
    tickUnits(0.3, 0.3); // complete spawn

    const entry = _testGetEntry('u1')!;
    expect(entry.lifeState).toBe('alive');

    const scales: number[] = [];
    for (let i = 0; i < 40; i++) {
      tickUnits(i * 0.1, 0.1);
      scales.push(entry.group.scale.x);
    }

    for (const s of scales) {
      expect(s).toBeGreaterThanOrEqual(0.98);
      expect(s).toBeLessThanOrEqual(1.02);
    }
    const min = Math.min(...scales);
    const max = Math.max(...scales);
    expect(max - min).toBeGreaterThan(0.001);
    expect(max - min).toBeLessThan(0.03);
  });
});

describe('UnitMesh3D walk pose', () => {
  it('keeps stride lift well below a terrain step', () => {
    const path = [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 2, r: 0 },
    ];
    rebuildUnits([movingUnit('u1', path)], getTile);
    tickUnits(0.3, 0.3);

    const entry = _testGetEntry('u1')!;
    let maxLift = 0;
    for (let i = 0; i < 30; i++) {
      tickUnits(0.3 + i * 0.02, 0.02);
      const lift = entry.group.position.y - entry.currentPos.y;
      if (lift > maxLift) maxLift = lift;
    }
    expect(maxLift).toBeGreaterThan(0.05);
    expect(maxLift).toBeLessThan(2);
  });

  it('idle units stay on the surface (Y stays at base)', () => {
    rebuildUnits([makeUnit('u1', 0, 0, 'idle')], getTile);
    tickUnits(0.3, 0.3);

    const entry = _testGetEntry('u1')!;
    const baseY = entry.group.position.y;

    for (let i = 0; i < 20; i++) {
      tickUnits(i * 0.02, 0.02);
      expect(entry.group.position.y).toBeLessThanOrEqual(baseY + 0.1);
    }
  });

  it('turns yaw toward the next waypoint without snapping in one frame', () => {
    const path = [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 2, r: 0 },
    ];
    rebuildUnits([movingUnit('u1', path)], getTile);
    tickUnits(0.3, 0.3);
    const entry = _testGetEntry('u1')!;
    expect(entry.yaw).toBe(0);

    const from = axialToWorld3D(0, 0, 0);
    const to = axialToWorld3D(1, 0, 0);
    const target = yawToward(to.x - from.x, to.z - from.z, 0);
    expect(Math.abs(target)).toBeGreaterThan(0.2);

    tickUnits(0.32, 0.02);
    expect(Math.abs(entry.yaw)).toBeGreaterThan(0);
    expect(Math.abs(entry.yaw)).toBeLessThan(Math.abs(target) * 0.5);

    for (let i = 0; i < 40; i++) tickUnits(0.4 + i * 0.05, 0.05);
    expect(entry.yaw).toBeCloseTo(target, 1);
  });

  it('does not snap back to the hex centre on a dirty rebuild mid-stride', () => {
    const path = [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 2, r: 0 },
      { q: 3, r: 0 },
    ];
    const u = movingUnit('u1', path);
    rebuildUnits([u], getTile);
    tickUnits(0.3, 0.3);
    tickUnits(0.5, 0.2);
    const entry = _testGetEntry('u1')!;
    const xBefore = entry.currentPos.x;
    expect(entry.pathProgress).toBeGreaterThan(0.3);

    rebuildUnits([{ ...u, coord: { q: 1, r: 0 }, pathIndex: 1, pathProgress: 0 }], getTile);
    expect(_testGetEntry('u1')!.currentPos.x).toBeCloseTo(xBefore, 5);
    expect(_testGetEntry('u1')!.pathIndex).toBe(entry.pathIndex);
  });

  it('raises Y when walking onto a hill instead of floating or hopping', () => {
    const hillTiles = new Map<string, Tile>([
      ['0,0', makeTile(0, 0, 'plains')],
      ['1,0', makeTile(1, 0, 'hills')],
    ]);
    const hillGet = (key: string) => hillTiles.get(key);
    const path = [
      { q: 0, r: 0 },
      { q: 1, r: 0 },
    ];
    rebuildUnits([movingUnit('u1', path)], hillGet);
    tickUnits(0.3, 0.3);
    const entry = _testGetEntry('u1')!;
    const startY = entry.currentPos.y;
    for (let i = 0; i < 16; i++) tickUnits(0.3 + i * 0.02, 0.02);
    expect(entry.currentPos.y).toBeGreaterThan(startY + 2);
    expect(entry.strideY).toBeLessThan(2);
  });
});

describe('unitWalkPose helpers', () => {
  it('catmullRom hits the segment endpoints', () => {
    expect(catmullRom(0, 10, 20, 30, 0)).toBeCloseTo(10);
    expect(catmullRom(0, 10, 20, 30, 1)).toBeCloseTo(20);
  });

  it('idle breath is a 1% oscillation and frozen while moving', () => {
    expect(idleBreathScale(0, 0, true)).toBe(1);
    const a = idleBreathScale(0, 0, false);
    const b = idleBreathScale(0.6, 0, false);
    expect(Math.abs(a - 1)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(b - a)).toBeGreaterThan(0.001);
  });

  it('stride lift is non-negative and smaller than a terrain step', () => {
    expect(strideLift(0.1, false)).toBe(0);
    expect(strideLift(0.1, true)).toBeGreaterThan(0);
    expect(strideLift(0.1, true)).toBeLessThan(2);
  });
});

describe('UnitMesh3D idle phase', () => {
  // Regression: idlePhase came from Math.random(), whose (seeded) sequence the
  // golden-capture script can't pin — other code draws from it a
  // frame-dependent number of times — so the frozen idle pulse landed on a
  // different ring scale every run. The phase must be a function of the id.
  it('derives the idle phase from the unit id, not from Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.123);
    rebuildUnits([makeUnit('MAIN', 0, 0)], getTile);
    const first = _testGetEntry('MAIN')!.idlePhase;
    clearUnits();

    spy.mockReturnValue(0.987);
    rebuildUnits([makeUnit('MAIN', 0, 0)], getTile);
    const second = _testGetEntry('MAIN')!.idlePhase;
    spy.mockRestore();

    expect(second).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(Math.PI * 2);
  });

  it('keeps different units out of phase', () => {
    rebuildUnits([makeUnit('MAIN', 0, 0), makeUnit('scout-1', 1, 0)], getTile);

    expect(_testGetEntry('MAIN')!.idlePhase).not.toBe(_testGetEntry('scout-1')!.idlePhase);
  });
});

describe('UnitMesh3D nation colour', () => {
  beforeEach(() => {
    const storage: Record<string, string> = {};
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage[key] ?? null,
        setItem: (key: string, value: string) => {
          storage[key] = value;
        },
        removeItem: (key: string) => {
          delete storage[key];
        },
      },
    });
    resetNationStoreCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetNationStoreCache();
  });

  function twoNations() {
    const red = createNation('Roja', '#ff0000');
    const blue = createNation('Azul', '#0000ff');
    const cityA = { ...makeCity('city-a', 0, 0), nationId: red.id };
    const cityB = { ...makeCity('city-b', 1, 0), nationId: blue.id };
    const tileA = { ...makeTile(0, 0), city: cityA };
    const tileB = { ...makeTile(1, 0), city: cityB };
    const getTileWithCities = (key: string) =>
      key === '0,0' ? tileA : key === '1,0' ? tileB : undefined;
    return { red, cityA, cityB, getTileWithCities };
  }

  it('takes the colour of its own city, not of the hex it stands on', () => {
    const { red, cityA, cityB, getTileWithCities } = twoNations();
    // The unit works in A but is standing on B's hex.
    const unit = { ...makeUnit('u1', 1, 0), cityId: cityA.id };

    rebuildUnits([unit], getTileWithCities, [cityA, cityB]);

    expect(_testGetEntry('u1')!.nationColor).toBe(red.color);
  });

  it('keeps the ring and the figure when the unit walks off the city hex', () => {
    const { red, cityA, cityB, getTileWithCities } = twoNations();
    const unit = { ...makeUnit('u1', 1, 0), cityId: cityA.id };
    rebuildUnits([unit], getTileWithCities, [cityA, cityB]);
    const before = _testGetEntry('u1')!;
    const group = before.group;

    rebuildUnits([{ ...unit, coord: { q: 2, r: 0 } }], getTileWithCities, [cityA, cityB]);

    const after = _testGetEntry('u1')!;
    expect(after.group).toBe(group);
    expect(after.nationColor).toBe(red.color);
  });
});

describe('UnitProps3D role figurine mapping and GLB assets on disk', () => {
  it('maps every UnitType to its expected role figurine GLB', () => {
    expect(unitRoleGlbForType('hero')).toBe('unit-mage');
    expect(unitRoleGlbForType('claude')).toBe('unit-mage');
    expect(unitRoleGlbForType('openclaw')).toBe('unit-mage');

    expect(unitRoleGlbForType('worker')).toBe('unit-engineer');
    expect(unitRoleGlbForType('codex')).toBe('unit-engineer');
    expect(unitRoleGlbForType('cursor')).toBe('unit-engineer');

    expect(unitRoleGlbForType('scout')).toBe('unit-rogue');
    expect(unitRoleGlbForType('caravan')).toBe('unit-rogue');

    expect(unitRoleGlbForType('praetorian')).toBe('unit-knight');
    expect(unitRoleGlbForType('army')).toBe('unit-knight');
    expect(unitRoleGlbForType('lexo')).toBe('unit-knight');
  });

  it('hot-swaps figurine group when unit type changes without resetting alive lifeState', () => {
    const u1 = makeUnit('u1', 0, 0);
    rebuildUnits([u1], getTile);
    tickUnits(0.3, 0.3);
    const entryBefore = _testGetEntry('u1')!;
    expect(entryBefore.lifeState).toBe('alive');
    const oldGroup = entryBefore.group;

    const u1Promoted: Unit = { ...u1, type: 'claude' };
    rebuildUnits([u1Promoted], getTile);
    const entryAfter = _testGetEntry('u1')!;
    expect(entryAfter.lifeState).toBe('alive');
    expect(entryAfter.unitType).toBe('claude');
    expect(entryAfter.group).not.toBe(oldGroup);
  });

  it('has valid glTF 2.0 binary files (< 60 KB, tintable slot 1) on disk for all role figurines', async () => {
    expect(existsSync('public/assets/3d/props/unit-worker-0.glb')).toBe(true);
    const loader = new GLTFLoader();
    for (const id of UNIT_ROLE_GLB_IDS) {
      const p = `public/assets/3d/props/units/${id}.glb`;
      expect(existsSync(p), p).toBe(true);
      const buf = readFileSync(p);
      expect(buf.byteLength).toBeGreaterThan(100);
      expect(buf.byteLength).toBeLessThan(60 * 1024);
      // Verify glTF magic (0x46546C67) and version 2
      expect(buf.readUInt32LE(0)).toBe(0x46546c67);
      expect(buf.readUInt32LE(4)).toBe(2);
      const jsonLen = buf.readUInt32LE(12);
      const gltfJson = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
      expect(gltfJson.materials.length).toBeGreaterThanOrEqual(2);
      expect(gltfJson.materials[1].name).toContain('tint');

      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const parsed = await loader.parseAsync(ab, '');
      const extracted = extractUnitPartsFromScene(parsed.scene);
      expect(extracted.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps CSG knowledge-city kits with tintable slot 1', async () => {
    const loader = new GLTFLoader();
    const kits = [
      'public/assets/3d/props/knowledge-city/unit-coordinator.glb',
      'public/assets/3d/props/knowledge-city/unit-builder.glb',
      'public/assets/3d/props/knowledge-city/unit-ranger.glb',
      'public/assets/3d/props/knowledge-city/unit-guardian.glb',
    ];
    for (const p of kits) {
      expect(existsSync(p), p).toBe(true);
      const buf = readFileSync(p);
      expect(buf.byteLength).toBeGreaterThan(100);
      expect(buf.byteLength).toBeLessThan(20 * 1024);
      expect(buf.readUInt32LE(0)).toBe(0x46546c67);
      expect(buf.readUInt32LE(4)).toBe(2);
      const jsonLen = buf.readUInt32LE(12);
      const gltfJson = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
      expect(gltfJson.materials[1].name).toContain('tint');
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const parsed = await loader.parseAsync(ab, '');
      expect(extractUnitPartsFromScene(parsed.scene).length).toBe(4);
    }
  });

  it('overlays the four approved Meshy PBR maps', () => {
    expect(Object.keys(KNOWLEDGE_CITY_UNIT_URLS)).toEqual([...UNIT_ROLE_GLB_IDS]);
    expect(KNOWLEDGE_CITY_UNIT_URLS).toEqual({
      'unit-mage': '/assets/3d/props/meshy/unit-coordinator-map.glb',
      'unit-engineer': '/assets/3d/props/meshy/unit-builder-map.glb',
      'unit-rogue': '/assets/3d/props/meshy/unit-ranger-map.glb',
      'unit-knight': '/assets/3d/props/meshy/unit-guardian-map.glb',
    });
    for (const url of Object.values(KNOWLEDGE_CITY_UNIT_URLS)) {
      const p = `public${url}`;
      expect(existsSync(p), p).toBe(true);
      const buf = readFileSync(p);
      expect(buf.byteLength).toBeGreaterThan(100 * 1024);
      expect(buf.byteLength).toBeLessThan(600 * 1024);
      expect(buf.readUInt32LE(0)).toBe(0x46546c67);
      expect(buf.readUInt32LE(4)).toBe(2);
      const jsonLen = buf.readUInt32LE(12);
      const gltfJson = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
      expect(gltfJson.meshes).toHaveLength(1);
      expect(gltfJson.materials).toHaveLength(1);
      expect(gltfJson.images.length).toBeGreaterThan(0);
    }
  });

  it('plants figurine feet at y=0 when the GLB origin is centered', () => {
    const source = new Group();
    source.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
    expect(new Box3().setFromObject(source).min.y).toBeCloseTo(-0.5, 5);
    const parts = extractUnitPartsFromScene(source);
    const planted = new Group();
    for (const part of parts) {
      const mesh = new Mesh(part.geometry, part.material);
      mesh.applyMatrix4(part.matrix);
      planted.add(mesh);
    }
    expect(new Box3().setFromObject(planted).min.y).toBeCloseTo(0, 3);
  });

  it('tints a single-part Meshy figurine and slot 1 of multi-part kits', () => {
    const tint = { name: 'unit-garment-tint' };
    const other = { name: 'slate' };
    expect(isUnitTintPart([{} as never], 0, other)).toBe(true);
    expect(isUnitTintPart([{} as never, {} as never], 1, other)).toBe(true);
    expect(isUnitTintPart([{} as never, {} as never], 0, other)).toBe(false);
    expect(isUnitTintPart([{} as never, {} as never], 0, tint)).toBe(true);
  });
});
