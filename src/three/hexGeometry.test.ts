import { describe, it, expect } from 'vitest';
import { createHexPrismGeometry, sharedHexGeometry } from './hexGeometry.ts';

describe('createHexPrismGeometry', () => {
  it('top-facing triangles have normals pointing +Y', () => {
    const geom = createHexPrismGeometry(50, 8);
    const positions = geom.getAttribute('position').array as Float32Array;
    const normals = geom.getAttribute('normal').array as Float32Array;

    let upwardCount = 0;
    for (let i = 0; i < positions.length; i += 9) {
      const ny = normals[i + 4]!;
      if (ny > 0.85) {
        upwardCount++;
      }
    }
    // Bevel geometry: inner top (4) + top bevel ring (12) = 16 upward-facing tris
    // Full-radius top: 4 upward-facing tris only
    expect(upwardCount).toBeGreaterThanOrEqual(4);
  });

  it('provides UVs for every vertex in 0..1 range', () => {
    const geom = createHexPrismGeometry(50, 8);
    const positions = geom.getAttribute('position');
    const uv = geom.getAttribute('uv');
    expect(uv).toBeDefined();
    expect(uv.count).toBe(positions.count);
    const arr = uv.array as Float32Array;
    for (const value of arr) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('uses a full-radius top face for seamless flat-top tiling', () => {
    const geom = createHexPrismGeometry(50, 8);
    const count = geom.getAttribute('position').count;
    // Full-radius prism: 4 top + 4 bottom + 12 side = 20 triangles = 60 vertices
    expect(count).toBe(60);
  });

  it('exports shared geometry with default size', () => {
    expect(sharedHexGeometry).toBeDefined();
    expect(sharedHexGeometry.getAttribute('position').count).toBeGreaterThan(0);
  });
});
