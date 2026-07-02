import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferAttribute, BufferGeometry, MeshStandardMaterial } from 'three';
import type { District, Tile, WonderType } from '../types.ts';
import {
  areWonderPropsReady,
  areWonderGlbReady,
  clearWonderProps,
  getWonderPropsGroup,
  rebuildWonderProps,
  setWonderVisible,
  _injectWonderGlbForTest,
  _wonderPropsSignature,
} from './WonderProps3D.ts';

function wonderTile(coord: { q: number; r: number }, type: WonderType): Tile {
  const district: District = {
    id: `district-${coord.q}-${coord.r}`,
    name: type,
    type: 'wonder',
    coord,
    wonderType: type,
  };
  return {
    coord,
    terrain: 'sacred',
    district,
    resources: { gold: 0, science: 0, production: 0 },
    inFog: false,
    revealed: true,
  };
}

function plainSacredTile(coord: { q: number; r: number }): Tile {
  return {
    coord,
    terrain: 'sacred',
    resources: { gold: 0, science: 0, production: 0 },
    inFog: false,
    revealed: true,
  };
}

afterEach(() => {
  clearWonderProps();
  _injectWonderGlbForTest(null);
});

function fakeMergedGlb() {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  geometry.addGroup(0, 3, 0);
  return { geometry, materials: [new MeshStandardMaterial()] };
}

describe('WonderProps3D', () => {
  it('areWonderPropsReady() returns true (procedural, no async load)', () => {
    expect(areWonderPropsReady()).toBe(true);
  });

  it('rebuilds nothing when no wonder tiles are present', () => {
    rebuildWonderProps([plainSacredTile({ q: 0, r: 0 })]);
    const g = getWonderPropsGroup();
    // Three sub-groups (bibliotheca, institutum, generic) exist but are empty.
    expect(g.children).toHaveLength(3);
    expect(g.children[0]!.children).toHaveLength(0);
    expect(g.children[1]!.children).toHaveLength(0);
    expect(g.children[2]!.children).toHaveLength(0);
    expect(_wonderPropsSignature()).toBe('');
  });

  it('builds a generic monument for a user-connected wonder', () => {
    const tiles = [wonderTile({ q: 0, r: -1 }, 'mi-servicio')];
    rebuildWonderProps(tiles);
    const g = getWonderPropsGroup();
    // Sub-group 2 = generic
    expect(g.children[0]!.children).toHaveLength(0);
    expect(g.children[1]!.children).toHaveLength(0);
    expect(g.children[2]!.children).toHaveLength(1);
    expect(_wonderPropsSignature()).toContain('mi-servicio');
  });

  it('builds a bibliotheca instance on a bibliotheca wonder tile', () => {
    const tiles = [wonderTile({ q: -1, r: 0 }, 'bibliotheca')];
    rebuildWonderProps(tiles);
    const g = getWonderPropsGroup();
    // Sub-group 0 = bibliotheca
    expect(g.children[0]!.children).toHaveLength(1);
    // Sub-group 1 = institutum (empty)
    expect(g.children[1]!.children).toHaveLength(0);
    expect(_wonderPropsSignature()).toContain('bibliotheca');
  });

  it('builds an institutum instance on an institutum wonder tile', () => {
    const tiles = [wonderTile({ q: 1, r: 0 }, 'institutum')];
    rebuildWonderProps(tiles);
    const g = getWonderPropsGroup();
    expect(g.children[0]!.children).toHaveLength(0);
    expect(g.children[1]!.children).toHaveLength(1);
    expect(_wonderPropsSignature()).toContain('institutum');
  });

  it('builds both wonders when both wonder tiles are present', () => {
    const tiles = [
      wonderTile({ q: -1, r: 0 }, 'bibliotheca'),
      wonderTile({ q: 1, r: 0 }, 'institutum'),
    ];
    rebuildWonderProps(tiles);
    const g = getWonderPropsGroup();
    expect(g.children[0]!.children).toHaveLength(1);
    expect(g.children[1]!.children).toHaveLength(1);
  });

  it('skips gaceta (no tile in the current map)', () => {
    const tiles = [wonderTile({ q: 0, r: 0 }, 'gaceta')];
    rebuildWonderProps(tiles);
    const g = getWonderPropsGroup();
    expect(g.children[0]!.children).toHaveLength(0);
    expect(g.children[1]!.children).toHaveLength(0);
  });

  it('skips unrevealed wonder tiles', () => {
    const tile = wonderTile({ q: -1, r: 0 }, 'bibliotheca');
    tile.revealed = false;
    rebuildWonderProps([tile]);
    const g = getWonderPropsGroup();
    expect(g.children[0]!.children).toHaveLength(0);
  });

  it('produces distinct geometry for bibliotheca vs institutum', () => {
    rebuildWonderProps([wonderTile({ q: -1, r: 0 }, 'bibliotheca')]);
    const biblioCount = countMeshes(getWonderPropsGroup().children[0]!);
    clearWonderProps();
    rebuildWonderProps([wonderTile({ q: 1, r: 0 }, 'institutum')]);
    const instCount = countMeshes(getWonderPropsGroup().children[1]!);
    expect(biblioCount).toBeGreaterThan(instCount);
    expect(biblioCount).toBe(12);
    expect(instCount).toBe(7);
  });

  it('roof on bibliotheca is a hex pyramid standing point-up above the columns', () => {
    // The roof replaced an off-axis triangular pediment that read as a stray
    // wedge on the hexagonal colonnade. It is now a six-sided cone (matching
    // the column ring) sitting point-up on the entablature. This guards that
    // shape: exactly one ConeGeometry, hex base, apex on +Y, eaves above the
    // dais top.
    rebuildWonderProps([wonderTile({ q: -1, r: 0 }, 'bibliotheca')]);
    const biblio = getWonderPropsGroup().children[0]!;
    expect(biblio.children).toHaveLength(1);

    const inst = biblio.children[0]! as import('three').Group;
    const cones = inst.children.filter((c) => {
      const m = c as import('three').Mesh;
      return m.isMesh && (m.geometry as import('three').BufferGeometry).type === 'ConeGeometry';
    });
    expect(cones).toHaveLength(1);
    const roof = cones[0] as import('three').Mesh;

    // (a) Hexagonal base — matches the six columns.
    const params = (roof.geometry as unknown as { parameters?: { radialSegments?: number } })
      .parameters;
    expect(params?.radialSegments).toBe(6);

    // (b) Apex stays on +Y: no tilt on X or Z (a Y spin is allowed for the
    //     hex flat-to-gap alignment).
    expect(roof.rotation.x).toBe(0);
    expect(roof.rotation.z).toBe(0);

    // (c) Sits above the colonnade — higher than every stone cylinder
    //     (the 3 dais tiers, 6 columns, entablature). The gem finial is a
    //     sphere above the roof and is intentionally excluded.
    const cylinders = inst.children.filter(
      (c) =>
        (c as import('three').Mesh).isMesh &&
        ((c as import('three').Mesh).geometry as import('three').BufferGeometry).type ===
          'CylinderGeometry',
    );
    const maxCylinder = Math.max(...cylinders.map((c) => c.position.y));
    expect(roof.position.y).toBeGreaterThan(maxCylinder);
  });

  it('rebuilds only on signature change (dirty-check)', () => {
    const tiles = [wonderTile({ q: -1, r: 0 }, 'bibliotheca')];
    rebuildWonderProps(tiles);
    const firstSig = _wonderPropsSignature();
    expect(firstSig).not.toBe('');
    rebuildWonderProps([...tiles]);
    expect(_wonderPropsSignature()).toBe(firstSig);
    expect(getWonderPropsGroup().children[0]!.children).toHaveLength(1);
  });

  it('clears on signature change so old wonders do not linger', () => {
    rebuildWonderProps([wonderTile({ q: -1, r: 0 }, 'bibliotheca')]);
    expect(getWonderPropsGroup().children[0]!.children).toHaveLength(1);
    rebuildWonderProps([wonderTile({ q: -1, r: 0 }, 'institutum')]);
    expect(getWonderPropsGroup().children[0]!.children).toHaveLength(0);
    expect(getWonderPropsGroup().children[1]!.children).toHaveLength(1);
  });

  it('setWonderVisible toggles per-wonder sub-group visibility', () => {
    rebuildWonderProps([
      wonderTile({ q: -1, r: 0 }, 'bibliotheca'),
      wonderTile({ q: 1, r: 0 }, 'institutum'),
    ]);
    const g = getWonderPropsGroup();
    expect(g.children[0]!.visible).toBe(true);
    expect(g.children[1]!.visible).toBe(true);
    setWonderVisible('bibliotheca', false);
    expect(g.children[0]!.visible).toBe(false);
    expect(g.children[1]!.visible).toBe(true);
    setWonderVisible('institutum', false);
    expect(g.children[0]!.visible).toBe(false);
    expect(g.children[1]!.visible).toBe(false);
    setWonderVisible('bibliotheca', true);
    setWonderVisible('institutum', true);
    expect(g.children[0]!.visible).toBe(true);
    expect(g.children[1]!.visible).toBe(true);
  });

  describe('GLB swap-in', () => {
    it('uses the loaded GLB instead of the procedural builder once ready', () => {
      const biblio = fakeMergedGlb();
      const inst = fakeMergedGlb();
      _injectWonderGlbForTest(
        new Map([
          ['bibliotheca', biblio],
          ['institutum', inst],
        ]),
      );
      expect(areWonderGlbReady()).toBe(true);

      rebuildWonderProps([
        wonderTile({ q: -1, r: 0 }, 'bibliotheca'),
        wonderTile({ q: 1, r: 0 }, 'institutum'),
      ]);
      const g = getWonderPropsGroup();
      // One GLB mesh per wonder — not the 12/7-mesh procedural groups.
      expect(countMeshes(g.children[0]!)).toBe(1);
      expect(countMeshes(g.children[1]!)).toBe(1);
      const biblioMesh = g.children[0]!.children[0] as import('three').Mesh;
      expect(biblioMesh.geometry).toBe(biblio.geometry);
      expect(biblioMesh.userData.sharedAsset).toBe(true);
    });

    it('clearWonderProps keeps shared GLB assets alive for later rebuilds', () => {
      const biblio = fakeMergedGlb();
      _injectWonderGlbForTest(new Map([['bibliotheca', biblio]]));
      const tiles = [wonderTile({ q: -1, r: 0 }, 'bibliotheca')];
      rebuildWonderProps(tiles);
      // BufferGeometry.dispose() only dispatches a 'dispose' event (attributes
      // stay readable), so listen for the event — the only observable signal.
      const geomDispose = vi.fn();
      const matDispose = vi.fn();
      biblio.geometry.addEventListener('dispose', geomDispose);
      biblio.materials[0]!.addEventListener('dispose', matDispose);
      clearWonderProps();
      expect(geomDispose).not.toHaveBeenCalled();
      expect(matDispose).not.toHaveBeenCalled();
      rebuildWonderProps(tiles);
      const mesh = getWonderPropsGroup().children[0]!.children[0] as import('three').Mesh;
      expect(mesh.geometry).toBe(biblio.geometry);
    });

    it('clearWonderProps still disposes procedural (non-shared) meshes', () => {
      // No GLB injected — the procedural temple is built.
      rebuildWonderProps([wonderTile({ q: -1, r: 0 }, 'bibliotheca')]);
      const inst = getWonderPropsGroup().children[0]!.children[0] as import('three').Group;
      const disposeSpy = vi.fn();
      inst.traverse((obj) => {
        const m = obj as import('three').Mesh;
        if (m.isMesh) m.geometry.addEventListener('dispose', disposeSpy);
      });
      clearWonderProps();
      expect(disposeSpy).toHaveBeenCalled();
    });

    it('clears a stale procedural wonder when the GLB resolves after the last wonder tile vanished', () => {
      // Ghost regression: '' is both the "empty world" signature and (before
      // the FORCE_REBUILD sentinel) the swap-in reset value. Sequence: build a
      // procedural temple, GLB arrives (resets lastSignature), then the wonder
      // district disappears while OTHER tiles remain. The temple must go.
      rebuildWonderProps([wonderTile({ q: -1, r: 0 }, 'bibliotheca')]);
      expect(getWonderPropsGroup().children[0]!.children).toHaveLength(1);
      _injectWonderGlbForTest(new Map([['bibliotheca', fakeMergedGlb()]]));
      rebuildWonderProps([plainSacredTile({ q: 0, r: 0 })]);
      expect(getWonderPropsGroup().children[0]!.children).toHaveLength(0);
    });

    it('generic wonders stay procedural even when GLBs are loaded', () => {
      _injectWonderGlbForTest(new Map([['bibliotheca', fakeMergedGlb()]]));
      rebuildWonderProps([wonderTile({ q: 0, r: -1 }, 'mi-servicio')]);
      const generic = getWonderPropsGroup().children[2]!;
      expect(generic.children).toHaveLength(1);
      // Procedural monument = several meshes, none tagged as shared asset.
      expect(countMeshes(generic)).toBeGreaterThan(1);
    });
  });

  it('clearWonderProps disposes all meshes and resets the signature', () => {
    rebuildWonderProps([
      wonderTile({ q: -1, r: 0 }, 'bibliotheca'),
      wonderTile({ q: 1, r: 0 }, 'institutum'),
    ]);
    expect(_wonderPropsSignature()).not.toBe('');
    clearWonderProps();
    expect(_wonderPropsSignature()).toBe('');
    expect(getWonderPropsGroup().children[0]!.children).toHaveLength(0);
    expect(getWonderPropsGroup().children[1]!.children).toHaveLength(0);
  });
});

function countMeshes(root: import('three').Object3D): number {
  let count = 0;
  root.traverse((obj) => {
    if ((obj as import('three').Mesh).isMesh) count++;
  });
  return count;
}
