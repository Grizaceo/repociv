import { afterEach, describe, expect, it } from 'vitest';
import type { District, Tile, WonderType } from '../types.ts';
import {
  areWonderPropsReady,
  areWonderPropsSettled,
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

/** The single sub-group holding every connected wonder's monument. */
function wonderMonuments() {
  return getWonderPropsGroup().children[0]!;
}

afterEach(() => {
  clearWonderProps();
  setWonderVisible(true);
});

describe('WonderProps3D', () => {
  it('props are ready and settled — the builder is procedural, not async', () => {
    expect(areWonderPropsReady()).toBe(true);
    expect(areWonderPropsSettled()).toBe(true);
  });

  it('rebuilds nothing when no wonder tiles are present', () => {
    rebuildWonderProps([plainSacredTile({ q: 0, r: 0 })]);
    expect(wonderMonuments().children).toHaveLength(0);
    expect(_wonderPropsSignature()).toBe('');
  });

  it('builds a monument for a connected wonder', () => {
    rebuildWonderProps([wonderTile({ q: 0, r: -1 }, 'mi-servicio')]);
    expect(wonderMonuments().children).toHaveLength(1);
    expect(_wonderPropsSignature()).toContain('mi-servicio');
  });

  it('builds one monument per wonder tile', () => {
    rebuildWonderProps([
      wonderTile({ q: -1, r: 0 }, 'mi-servicio'),
      wonderTile({ q: 1, r: 0 }, 'otro-servicio'),
    ]);
    expect(wonderMonuments().children).toHaveLength(2);
  });

  it('skips gaceta — it is native and owns no tile', () => {
    rebuildWonderProps([wonderTile({ q: 0, r: 0 }, 'gaceta')]);
    expect(wonderMonuments().children).toHaveLength(0);
  });

  it('skips unrevealed wonder tiles', () => {
    const tile = wonderTile({ q: -1, r: 0 }, 'mi-servicio');
    tile.revealed = false;
    rebuildWonderProps([tile]);
    expect(wonderMonuments().children).toHaveLength(0);
  });

  it('rebuilds only on signature change (dirty-check)', () => {
    const tiles = [wonderTile({ q: -1, r: 0 }, 'mi-servicio')];
    rebuildWonderProps(tiles);
    const firstSig = _wonderPropsSignature();
    expect(firstSig).not.toBe('');
    rebuildWonderProps([...tiles]);
    expect(_wonderPropsSignature()).toBe(firstSig);
    expect(wonderMonuments().children).toHaveLength(1);
  });

  it('clears on signature change so old wonders do not linger', () => {
    rebuildWonderProps([
      wonderTile({ q: -1, r: 0 }, 'mi-servicio'),
      wonderTile({ q: 1, r: 0 }, 'otro-servicio'),
    ]);
    expect(wonderMonuments().children).toHaveLength(2);
    rebuildWonderProps([wonderTile({ q: -1, r: 0 }, 'mi-servicio')]);
    expect(wonderMonuments().children).toHaveLength(1);
  });

  it('setWonderVisible toggles the monument sub-group', () => {
    rebuildWonderProps([wonderTile({ q: -1, r: 0 }, 'mi-servicio')]);
    expect(wonderMonuments().visible).toBe(true);
    setWonderVisible(false);
    expect(wonderMonuments().visible).toBe(false);
    setWonderVisible(true);
    expect(wonderMonuments().visible).toBe(true);
  });

  it('clearWonderProps disposes all meshes and resets the signature', () => {
    rebuildWonderProps([wonderTile({ q: -1, r: 0 }, 'mi-servicio')]);
    const disposed: string[] = [];
    wonderMonuments().traverse((obj) => {
      const mesh = obj as import('three').Mesh;
      if (!mesh.isMesh) return;
      const original = mesh.geometry.dispose.bind(mesh.geometry);
      mesh.geometry.dispose = () => {
        disposed.push(mesh.uuid);
        original();
      };
    });
    expect(_wonderPropsSignature()).not.toBe('');
    clearWonderProps();
    expect(_wonderPropsSignature()).toBe('');
    expect(wonderMonuments().children).toHaveLength(0);
    expect(disposed.length).toBeGreaterThan(0);
  });
});
