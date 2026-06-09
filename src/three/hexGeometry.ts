// ─── Flat-top hex prism geometry (aligned with hex.ts circumradius) ───────────
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { HEX_SIZE } from '../constants.ts';
import { hexCornerAngle } from '../isoHex.ts';

/** Side depth of terrain prism below the top face (world units). */
export const TILE_PRISM_HEIGHT = 8;

/** Extruded flat-top hex prism centered at origin; top at y=0, bottom at y=-height.
 *  Includes UVs for texture atlas sampling: local XZ coordinates mapped to [0,1]. */
export function createHexPrismGeometry(
  circumradius = HEX_SIZE,
  height = TILE_PRISM_HEIGHT,
): BufferGeometry {
  const top: Array<[number, number, number]> = [];
  const bottom: Array<[number, number, number]> = [];
  for (let i = 0; i < 6; i++) {
    const angle = hexCornerAngle(i);
    const x = circumradius * Math.cos(angle);
    const z = circumradius * Math.sin(angle);
    top.push([x, 0, z]);
    bottom.push([x, -height, z]);
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  const toUv = (p: [number, number, number]): [number, number] => [
    0.5 + p[0] / (circumradius * 2),
    0.5 + p[2] / (circumradius * 2),
  ];

  const pushTri = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ) => {
    positions.push(...a, ...b, ...c);
    // UVs
    const [au, av] = toUv(a);
    const [bu, bv] = toUv(b);
    const [cu, cv] = toUv(c);
    uvs.push(au, av, bu, bv, cu, cv);
    // Normals
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const sn = [nx / len, ny / len, nz / len] as const;
    normals.push(...sn, ...sn, ...sn);
  };

  // CCW from +Y so front faces are visible from the tilted overhead camera.
  for (let i = 1; i < 5; i++) {
    pushTri(top[0]!, top[i + 1]!, top[i]!);
  }
  for (let i = 1; i < 5; i++) {
    pushTri(bottom[0]!, bottom[i + 1]!, bottom[i]!);
  }
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    pushTri(top[i]!, bottom[i]!, bottom[j]!);
    pushTri(top[i]!, bottom[j]!, top[j]!);
  }

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geom.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return geom;
}

/** Reusable unit hex for InstancedMesh. */
export const sharedHexGeometry = createHexPrismGeometry(HEX_SIZE, TILE_PRISM_HEIGHT);
