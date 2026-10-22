import { describe, expect, it } from 'vitest';
import {
  ISO_TILE_H,
  ISO_TILE_W,
  ISO_WALL_H,
  isoProject,
  isoTileCorners,
  isoUnproject,
} from './isoGeometry.ts';
import {
  isoProject as rendererProject,
  isoUnproject as rendererUnproject,
} from './isoLocalRenderer.ts';
import {
  ISO_TILE_H as spriteTileH,
  ISO_TILE_W as spriteTileW,
  ISO_WALL_H as spriteWallH,
  isoProject as spriteProject,
} from './isoOfficeSprites.ts';

// Captured from the original implementation before extraction (78cb6c2).
// Includes negative/fractional coordinates, elevation and a large-coordinate case.
const fixtures = [
  {
    input: [0, 0, 0],
    projected: {
      px: 0,
      py: 0,
    },
    corners: [
      {
        x: 0,
        y: -16,
      },
      {
        x: 32,
        y: 0,
      },
      {
        x: 0,
        y: 16,
      },
      {
        x: -32,
        y: 0,
      },
    ],
    unprojected: {
      x: 0,
      y: 0,
    },
  },
  {
    input: [1, 0, 0],
    projected: {
      px: 32,
      py: 16,
    },
    corners: [
      {
        x: 32,
        y: 0,
      },
      {
        x: 64,
        y: 16,
      },
      {
        x: 32,
        y: 32,
      },
      {
        x: 0,
        y: 16,
      },
    ],
    unprojected: {
      x: 0.015625,
      y: -0.015625,
    },
  },
  {
    input: [0, 1, 0],
    projected: {
      px: -32,
      py: 16,
    },
    corners: [
      {
        x: -32,
        y: 0,
      },
      {
        x: 0,
        y: 16,
      },
      {
        x: -32,
        y: 32,
      },
      {
        x: -64,
        y: 16,
      },
    ],
    unprojected: {
      x: 0.03125,
      y: 0.03125,
    },
  },
  {
    input: [-3, 7, 0],
    projected: {
      px: -320,
      py: 64,
    },
    corners: [
      {
        x: -320,
        y: 48,
      },
      {
        x: -288,
        y: 64,
      },
      {
        x: -320,
        y: 80,
      },
      {
        x: -352,
        y: 64,
      },
    ],
    unprojected: {
      x: 0.171875,
      y: 0.265625,
    },
  },
  {
    input: [1.25, -2.5, 0],
    projected: {
      px: 120,
      py: -20,
    },
    corners: [
      {
        x: 120,
        y: -36,
      },
      {
        x: 152,
        y: -20,
      },
      {
        x: 120,
        y: -4,
      },
      {
        x: 88,
        y: -20,
      },
    ],
    unprojected: {
      x: -0.05859375,
      y: -0.09765625,
    },
  },
  {
    input: [2, 3, 1],
    projected: {
      px: -32,
      py: 56,
    },
    corners: [
      {
        x: -32,
        y: 40,
      },
      {
        x: 0,
        y: 56,
      },
      {
        x: -32,
        y: 72,
      },
      {
        x: -64,
        y: 56,
      },
    ],
    unprojected: {
      x: 0.125,
      y: 0.0625,
    },
  },
  {
    input: [-1.5, 2.25, -0.5],
    projected: {
      px: -120,
      py: 24,
    },
    corners: [
      {
        x: -120,
        y: 8,
      },
      {
        x: -88,
        y: 24,
      },
      {
        x: -120,
        y: 40,
      },
      {
        x: -152,
        y: 24,
      },
    ],
    unprojected: {
      x: 0.046875,
      y: 0.09375,
    },
  },
  {
    input: [10000, -20000, 4],
    projected: {
      px: 960000,
      py: -160096,
    },
    corners: [
      {
        x: 960000,
        y: -160112,
      },
      {
        x: 960032,
        y: -160096,
      },
      {
        x: 960000,
        y: -160080,
      },
      {
        x: 959968,
        y: -160096,
      },
    ],
    unprojected: {
      x: -468.75,
      y: -781.25,
    },
  },
] as const;

describe('isometric geometry characterization', () => {
  it('preserves dimensions through the sprite facade', () => {
    expect([ISO_TILE_W, ISO_TILE_H, ISO_WALL_H]).toEqual([64, 32, 24]);
    expect([spriteTileW, spriteTileH, spriteWallH]).toEqual([64, 32, 24]);
  });

  it('preserves the same function objects through existing facades', () => {
    expect(spriteProject).toBe(isoProject);
    expect(rendererProject).toBe(isoProject);
    expect(rendererUnproject).toBe(isoUnproject);
  });

  describe.each(fixtures)('fixture $input', ({ input, projected, corners, unprojected }) => {
    const [x, y, z] = input;
    it('preserves projected position', () => {
      expect(isoProject(x, y, z)).toEqual(projected);
    });
    it('preserves corner order (north, east, south, west) and elevation', () => {
      expect(isoTileCorners(x, y, z)).toEqual(corners);
    });
    it('preserves inverse-projection outputs for captured screen-coordinate inputs', () => {
      expect(isoUnproject(x, y)).toEqual(unprojected);
    });
    it('round-trips ground-plane coordinates', () => {
      const point = isoProject(x, y);
      expect(isoUnproject(point.px, point.py)).toEqual({ x, y });
    });
  });

  it('defaults elevation to zero', () => {
    expect(isoProject(2, 3)).toEqual(isoProject(2, 3, 0));
    expect(isoTileCorners(2, 3)).toEqual(isoTileCorners(2, 3, 0));
  });

  it('returns independent corner arrays and points', () => {
    const first = isoTileCorners(0, 0);
    first[0]!.x = 999;
    first.pop();
    expect(isoTileCorners(0, 0)).toEqual([
      { x: 0, y: -16 },
      { x: 32, y: 0 },
      { x: 0, y: 16 },
      { x: -32, y: 0 },
    ]);
  });
});
