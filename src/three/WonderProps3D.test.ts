import { afterEach, describe, expect, it } from 'vitest';
import type { District, Tile, WonderType } from '../types.ts';
import {
  areWonderPropsReady,
  clearWonderProps,
  getWonderPropsGroup,
  rebuildWonderProps,
  setWonderVisible,
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
});

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
      wonderTile({ q:  1, r: 0 }, 'institutum'),
    ];
    rebuildWonderProps(tiles);
    const g = getWonderPropsGroup();
    expect(g.children[0]!.children).toHaveLength(1);
    expect(g.children[1]!.children).toHaveLength(1);
  });

  it('skips gaceta (no tile in the current map)', () => {
    // If somehow a gaceta tile exists, it should not add to either sub-group.
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
    // Bibliotheca = 3 dais + 6 columns + 1 pediment + 1 gem = 11 meshes.
    // Institutum = 1 dais + 4 obelisks + 1 dome + 1 glow = 7 meshes.
    rebuildWonderProps([wonderTile({ q: -1, r: 0 }, 'bibliotheca')]);
    const biblioCount = countMeshes(getWonderPropsGroup().children[0]!);
    clearWonderProps();

    rebuildWonderProps([wonderTile({ q:  1, r: 0 }, 'institutum')]);
    const instCount = countMeshes(getWonderPropsGroup().children[1]!);

    expect(biblioCount).toBeGreaterThan(instCount);
    expect(biblioCount).toBe(11);
    expect(instCount).toBe(7);
  });

  it('rebuilds only on signature change (dirty-check)', () => {
    const tiles = [wonderTile({ q: -1, r: 0 }, 'bibliotheca')];
    rebuildWonderProps(tiles);
    const firstSig = _wonderPropsSignature();
    expect(firstSig).not.toBe('');

    // Second call with the same input: signature unchanged, no rebuild.
    // (We assert indirectly by checking the children count is stable.)
    rebuildWonderProps([...tiles]);
    expect(_wonderPropsSignature()).toBe(firstSig);
    expect(getWonderPropsGroup().children[0]!.children).toHaveLength(1);
  });

  it('clears on signature change so old wonders do not linger', () => {
    rebuildWonderProps([wonderTile({ q: -1, r: 0 }, 'bibliotheca')]);
    expect(getWonderPropsGroup().children[0]!.children).toHaveLength(1);

    // Switch the tile's wonderType → bibliotheca sub-group should clear,
    // institutum sub-group should get a new instance.
    rebuildWonderProps([wonderTile({ q: -1, r: 0 }, 'institutum')]);
    expect(getWonderPropsGroup().children[0]!.children).toHaveLength(0);
    expect(getWonderPropsGroup().children[1]!.children).toHaveLength(1);
  });

  it('setWonderVisible toggles per-wonder sub-group visibility', () => {
    rebuildWonderProps([
      wonderTile({ q: -1, r: 0 }, 'bibliotheca'),
      wonderTile({ q:  1, r: 0 }, 'institutum'),
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

  it('clearWonderProps disposes all meshes and resets the signature', () => {
    rebuildWonderProps([
      wonderTile({ q: -1, r: 0 }, 'bibliotheca'),
      wonderTile({ q:  1, r: 0 }, 'institutum'),
    ]);
    expect(_wonderPropsSignature()).not.toBe('');

    clearWonderProps();
    expect(_wonderPropsSignature()).toBe('');
    expect(getWonderPropsGroup().children[0]!.children).toHaveLength(0);
    expect(getWonderPropsGroup().children[1]!.children).toHaveLength(0);
  });
});

/** Count meshes (not groups) inside an arbitrary root. */
function countMeshes(root: import('three').Object3D): number {
  let count = 0;
  root.traverse((obj) => {
    if ((obj as import('three').Mesh).isMesh) count++;
  });
  return count;
}
