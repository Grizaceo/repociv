import { describe, expect, it, vi } from 'vitest';
import { HexRenderer } from './hexRenderer.ts';
import { UnitRenderer } from './unitRenderer.ts';
import type { City, Tile, Unit } from './types.ts';
import type { GameState } from './game.ts';

function makeMockCtx() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    ellipse: vi.fn(),
    rect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    roundRect: vi.fn(),
    drawImage: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createPattern: vi.fn(() => ({})),
    setLineDash: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    transform: vi.fn(),
    clip: vi.fn(),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    shadowColor: '',
    shadowBlur: 0,
  } as unknown as CanvasRenderingContext2D;
}

describe('HexRenderer 2D tiles, city sprites & compact labels', () => {
  it('draws 2.5D bevelled hex sprite when hexTileSprites are loaded', () => {
    const ctx = makeMockCtx();
    const hexR = new HexRenderer(ctx);
    const fakeCanvas = {} as HTMLCanvasElement;
    (hexR as unknown as { assetsLoaded: boolean }).assetsLoaded = true;
    (hexR as unknown as { hexTileSprites: Record<string, HTMLCanvasElement> }).hexTileSprites = {
      plains: fakeCanvas,
    };

    const tile: Tile = {
      coord: { q: 0, r: 0 },
      terrain: 'plains',
      revealed: true,
      inFog: false,
      resources: { gold: 1, science: 1, production: 1 },
    };

    hexR.drawTileSurface(tile, true, [], 0);
    expect(ctx.drawImage).toHaveBeenCalledWith(
      fakeCanvas,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('selects city sprite tier by population and capital flag', () => {
    const ctx = makeMockCtx();
    const hexR = new HexRenderer(ctx);
    const sprites = {
      city_hamlet: { tier: 'hamlet' } as unknown as HTMLCanvasElement,
      city_village: { tier: 'village' } as unknown as HTMLCanvasElement,
      city_town: { tier: 'town' } as unknown as HTMLCanvasElement,
      city_capital: { tier: 'capital' } as unknown as HTMLCanvasElement,
    };
    (hexR as unknown as { assetsLoaded: boolean }).assetsLoaded = true;
    (hexR as unknown as { spriteImages: Record<string, HTMLCanvasElement> }).spriteImages = sprites;

    const baseCity: City = {
      id: 'c1',
      name: 'repo',
      coord: { q: 0, r: 0 },
      population: 2,
      isCapital: false,
      territory: [],
      districts: [],
      buildings: [],
    };

    hexR.drawCitySprite({ ...baseCity, population: 2 }, { x: 10, y: 20 });
    expect(ctx.drawImage).toHaveBeenLastCalledWith(
      sprites.city_hamlet,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );

    hexR.drawCitySprite({ ...baseCity, population: 5 }, { x: 10, y: 20 });
    expect(ctx.drawImage).toHaveBeenLastCalledWith(
      sprites.city_village,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );

    hexR.drawCitySprite({ ...baseCity, population: 10 }, { x: 10, y: 20 });
    expect(ctx.drawImage).toHaveBeenLastCalledWith(
      sprites.city_town,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );

    hexR.drawCitySprite({ ...baseCity, isCapital: true, population: 1 }, { x: 10, y: 20 });
    expect(ctx.drawImage).toHaveBeenLastCalledWith(
      sprites.city_capital,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('truncates long city names in compact mode and preserves full name otherwise', () => {
    const ctx = makeMockCtx();
    const hexR = new HexRenderer(ctx);
    const city: City = {
      id: 'long-repo',
      name: 'postulacion-nucleo-medicina-personalizada',
      coord: { q: 0, r: 0 },
      population: 3,
      isCapital: false,
      territory: [],
      districts: [],
      buildings: [],
    };

    hexR.drawCityLabel(city, { x: 0, y: 0 }, undefined, true);
    expect(ctx.fillText).toHaveBeenCalledWith(
      'POSTULACION-NUC…',
      expect.any(Number),
      expect.any(Number),
    );

    hexR.drawCityLabel(city, { x: 0, y: 0 }, undefined, false);
    expect(ctx.fillText).toHaveBeenCalledWith(
      'POSTULACION-NUCLEO-MEDICINA-PERSONALIZADA',
      expect.any(Number),
      expect.any(Number),
    );
  });
});

describe('UnitRenderer smooth spline movement path & turn pips', () => {
  it('traces quadratic spline segments, destination arrowhead, and numbered step pips', () => {
    const ctx = makeMockCtx();
    const state = {
      world: { tiles: new Map(), cities: [], units: [], buildings: [] },
      subagents: new Map(),
    } as unknown as GameState;
    const unitR = new UnitRenderer(ctx, state);

    const unit: Unit = {
      id: 'U1',
      name: 'Scout',
      type: 'scout',
      civ: 'gris',
      cityId: 'capital',
      coord: { q: 0, r: 0 },
      path: [
        { q: 0, r: 0 },
        { q: 1, r: 0 },
        { q: 2, r: 1 },
        { q: 3, r: 1 },
      ],
      pathIndex: 0,
      pathProgress: 0,
      state: 'moving',
      speed: 2,
      color: '#58a6ff',
      movesLeft: 3,
      maxMoves: 3,
      fatigue: 100,
      maxFatigue: 100,
      isResting: false,
      effectiveSpeed: 2,
    };

    unitR.drawMovementPath(unit);

    expect(ctx.quadraticCurveTo).toHaveBeenCalled();
    expect(ctx.fillText).toHaveBeenCalledWith('1', expect.any(Number), expect.any(Number));
    expect(ctx.fillText).toHaveBeenCalledWith('2', expect.any(Number), expect.any(Number));
    expect(ctx.fillText).toHaveBeenCalledWith('3', expect.any(Number), expect.any(Number));
  });
});
