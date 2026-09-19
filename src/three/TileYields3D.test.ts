import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// CSS2DObject stand-in: a real Object3D (so Group.add accepts it) that keeps
// the element and the anchor `center` the renderer would use.
vi.mock('three/examples/jsm/renderers/CSS2DRenderer.js', async () => {
  const { Object3D } = await import('three');
  class MockCSS2DObject extends Object3D {
    element: HTMLElement;
    center = {
      x: 0.5,
      y: 0.5,
      set(x: number, y: number) {
        this.x = x;
        this.y = y;
      },
    };
    constructor(el: HTMLElement) {
      super();
      this.element = el;
    }
  }
  return { CSS2DObject: MockCSS2DObject, CSS2DRenderer: class {} };
});

import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { City, Tile } from '../types.ts';
import { CITY_BANNER_LIFT } from './MapLabels3D.ts';
import { clearTileYields, getTileYieldsGroup, rebuildTileYields } from './TileYields3D.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { terrainElevation } from '../isoHex.ts';

beforeAll(() => {
  // Node environment: the module only needs createElement → className/textContent.
  vi.stubGlobal('document', {
    createElement: () => ({ className: '', textContent: '', style: {} }),
  });
});

afterEach(() => {
  clearTileYields();
});

function richTile(q: number, r: number, city?: City): Tile {
  return {
    coord: { q, r },
    terrain: 'plains',
    resources: { gold: 9, science: 5, production: 4 },
    city,
    inFog: false,
    revealed: true,
  };
}

const CITY: City = {
  id: 'alpha',
  name: 'alpha',
  coord: { q: 0, r: 0 },
  population: 120,
  territory: [],
  districts: [],
  buildings: [],
  isCapital: false,
};

function yieldObjects(): CSS2DObject[] {
  return getTileYieldsGroup().children as CSS2DObject[];
}

describe('TileYields3D city tiles', () => {
  // Regression: city-tile icons floated at a fixed world height just above
  // the banner anchor, so at most zooms the coin landed on the city name.
  it('renders one icon row anchored to the banner, bottom-aligned above it', () => {
    rebuildTileYields([richTile(0, 0, CITY)], 'high', true);

    const objs = yieldObjects();
    expect(objs).toHaveLength(1);
    const [row] = objs;
    expect(row!.element.className).toContain('map-yield-icon-city');
    expect(row!.element.textContent).toBe('🪙⚗⚙');
    // Bottom-anchored at the exact banner anchor: CSS lifts it clear of the
    // banner box, so no zoom level can slide it onto the name.
    expect(row!.center.y).toBe(1);
    const anchor = axialToWorld3D(0, 0, terrainElevation('plains'));
    expect(row!.position.y).toBeCloseTo(anchor.y + CITY_BANNER_LIFT, 5);
  });

  it('keeps one centred icon per yield on tiles without a city', () => {
    rebuildTileYields([richTile(2, 0)], 'high', true);

    const objs = yieldObjects();
    expect(objs).toHaveLength(3);
    for (const o of objs) {
      expect(o.element.className).not.toContain('map-yield-icon-city');
      expect(o.center.y).toBe(0.5);
    }
  });
});
