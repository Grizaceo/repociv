import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock CSS2DObject so we don't need a DOM environment.
// Extends the real Object3D so Group.add accepts it.
vi.mock('three/examples/jsm/renderers/CSS2DRenderer.js', async () => {
  const { Object3D } = await import('three');
  class MockCSS2DObject extends Object3D {
    element: HTMLElement;
    center = { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; } };
    constructor(el: HTMLElement) {
      super();
      this.element = el;
    }
  }
  return { CSS2DObject: MockCSS2DObject };
});

// Mock document.createElement to return a fake element that syncs
// textContent from innerHTML (enough for the popup tests).
const fakeElement = (): HTMLElement => {
  const el = {
    _innerHTML: '',
    _textContent: '',
    className: '',
    style: {},
    parentNode: null as HTMLElement | null,
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v: string) {
      this._innerHTML = v;
      // Crude HTML strip to derive textContent.
      this._textContent = v.replace(/<[^>]*>/g, '');
    },
    get textContent() { return this._textContent; },
    set textContent(v: string) { this._textContent = v; },
  };
  return el as unknown as HTMLElement;
};
(globalThis as unknown as { document: typeof document }).document = {
  createElement: vi.fn(fakeElement) as unknown as typeof document.createElement,
} as unknown as typeof document;

import {
  clearTilePopup,
  getTilePopupGroup,
  showTilePopup,
  isPopupVisible,
} from './TilePopup3D.ts';
import type { Tile, City, Unit } from '../types.ts';

function makeTile(q: number, r: number, city?: City): Tile {
  return {
    coord: { q, r },
    terrain: 'plains',
    resources: { gold: 10, science: 5, production: 3 },
    city,
    inFog: false,
    revealed: true,
  };
}

function makeCity(id: string, q: number, r: number, isCapital = false): City {
  return {
    id,
    name: id,
    coord: { q, r },
    population: 120,
    territory: [],
    districts: [],
    buildings: [],
    isCapital,
  };
}

function makeUnit(id: string, cityId: string): Unit {
  return {
    id,
    name: id,
    type: 'worker',
    civ: 'gris',
    coord: { q: 0, r: 0 },
    path: [],
    pathIndex: 0,
    pathProgress: 0,
    state: 'idle',
    speed: 1,
    color: '#4488ff',
    movesLeft: 2,
    maxMoves: 2,
    fatigue: 100,
    maxFatigue: 100,
    isResting: false,
    effectiveSpeed: 1,
    cityId,
  };
}

afterEach(() => {
  clearTilePopup();
});

describe('TilePopup3D', () => {
  it('showTilePopup adds a popup to the group', () => {
    expect(getTilePopupGroup().children.length).toBe(0);
    expect(isPopupVisible()).toBe(false);

    const tile = makeTile(0, 0);
    showTilePopup(tile, { q: 0, r: 0 }, undefined, []);

    expect(getTilePopupGroup().children.length).toBe(1);
    expect(isPopupVisible()).toBe(true);
  });

  it('popup for a city tile shows the city name', () => {
    const city = makeCity('alpha', 0, 0, true);
    const tile = makeTile(0, 0, city);
    showTilePopup(tile, { q: 0, r: 0 }, city, []);

    const popup = getTilePopupGroup().children[0] as unknown as {
      element: { textContent: string };
    };
    expect(popup.element.textContent).toContain('alpha');
  });

  it('popup shows yield values from the tile', () => {
    const tile = makeTile(0, 0);
    showTilePopup(tile, { q: 0, r: 0 }, undefined, []);

    const popup = getTilePopupGroup().children[0] as unknown as {
      element: { textContent: string };
    };
    expect(popup.element.textContent).toContain('10'); // gold
    expect(popup.element.textContent).toContain('5');  // science
    expect(popup.element.textContent).toContain('3');  // production
  });

  it('popup shows garrison count', () => {
    const city = makeCity('alpha', 0, 0);
    const tile = makeTile(0, 0, city);
    const garrison = [makeUnit('u1', 'alpha'), makeUnit('u2', 'alpha')];
    showTilePopup(tile, { q: 0, r: 0 }, city, garrison);

    const popup = getTilePopupGroup().children[0] as unknown as {
      element: { textContent: string };
    };
    expect(popup.element.textContent).toContain('2');
  });

  it('showTilePopup replaces an existing popup', () => {
    const tile1 = makeTile(0, 0);
    showTilePopup(tile1, { q: 0, r: 0 }, undefined, []);
    expect(getTilePopupGroup().children.length).toBe(1);

    const tile2 = makeTile(1, 0);
    showTilePopup(tile2, { q: 1, r: 0 }, undefined, []);
    expect(getTilePopupGroup().children.length).toBe(1);
  });

  it('clearTilePopup removes the popup', () => {
    const tile = makeTile(0, 0);
    showTilePopup(tile, { q: 0, r: 0 }, undefined, []);
    expect(getTilePopupGroup().children.length).toBe(1);

    clearTilePopup();
    expect(getTilePopupGroup().children.length).toBe(0);
    expect(isPopupVisible()).toBe(false);
  });

  it('popup is positioned above the tile in world space', () => {
    const tile = makeTile(2, 3);
    showTilePopup(tile, { q: 2, r: 3 }, undefined, []);

    const popup = getTilePopupGroup().children[0] as unknown as {
      position: { x: number; y: number; z: number };
    };
    // The position should be at the tile's world coords, lifted up.
    expect(popup.position.y).toBeGreaterThan(0);
  });

  it('capital city shows "Capital" as owner', () => {
    const city = makeCity('alpha', 0, 0, true);
    const tile = makeTile(0, 0, city);
    showTilePopup(tile, { q: 0, r: 0 }, city, []);

    const popup = getTilePopupGroup().children[0] as unknown as {
      element: { textContent: string };
    };
    expect(popup.element.textContent).toContain('Capital');
  });

  it('unclaimed tile shows "Wilderness" as owner', () => {
    const tile = makeTile(0, 0);
    showTilePopup(tile, { q: 0, r: 0 }, undefined, []);

    const popup = getTilePopupGroup().children[0] as unknown as {
      element: { textContent: string };
    };
    expect(popup.element.textContent).toContain('Wilderness');
  });
});