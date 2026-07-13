import { describe, expect, it } from 'vitest';

import { parseOfficeAtlasManifest } from './officeAtlas.ts';

describe('office atlas manifest', () => {
  it('accepts a valid public manifest', () => {
    const manifest = {
      atlas: '/assets/office-atlas.png',
      cellWidth: 64,
      cellHeight: 64,
      spriteRects: { desk_l: [0, 0, 64, 64] },
    };

    expect(parseOfficeAtlasManifest(manifest)).toEqual(manifest);
  });

  it('rejects malformed or non-public manifests so procedural sprites remain available', () => {
    expect(parseOfficeAtlasManifest(null)).toBeNull();
    expect(
      parseOfficeAtlasManifest({
        atlas: 'relative.png',
        cellWidth: 64,
        cellHeight: 64,
        spriteRects: {},
      }),
    ).toBeNull();
    expect(
      parseOfficeAtlasManifest({
        atlas: '/assets/office-atlas.png',
        cellWidth: Number.NaN,
        cellHeight: 64,
        spriteRects: {},
      }),
    ).toBeNull();
  });
});
