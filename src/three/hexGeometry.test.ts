import { describe, it, expect } from 'vitest';
import { createHexPrismGeometry } from './hexGeometry.ts';

describe('createHexPrismGeometry', () => {
  it('top-face triangles have normals pointing +Y', () => {
    const geom = createHexPrismGeometry(50, 8);
    const positions = geom.getAttribute('position').array as Float32Array;
    const normals = geom.getAttribute('normal').array as Float32Array;

    let topFaceCount = 0;
    for (let i = 0; i < positions.length; i += 9) {
      const y0 = positions[i + 1]!;
      const y1 = positions[i + 4]!;
      const y2 = positions[i + 7]!;
      if (y0 === 0 && y1 === 0 && y2 === 0) {
        const ny = normals[i + 4]!;
        expect(ny).toBeGreaterThan(0.9);
        topFaceCount++;
      }
    }
    expect(topFaceCount).toBe(4);
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
});
