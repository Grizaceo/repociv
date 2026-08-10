// ─── Ground plane: dark earth fill beneath hex tiles (gap + map-edge void) ───
import { CircleGeometry, Mesh, MeshStandardMaterial, Color, Float32BufferAttribute } from 'three';
import { type GameState } from '../game.ts';
import { axialToWorld3D, TILE_HEIGHT } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

let groundMesh: Mesh | null = null;

/** Dark earth disc — fills sub-pixel hex gaps and the map rim. Sits well
 *  below prism bottoms so it never z-fights caps; warm fog no longer reads as
 *  the floor when tiles don't quite meet. Vertex colors darken toward the rim
 *  so the disc fades into the void instead of ending at a hard circle edge. */
export function rebuildGroundPlane(state: GameState): void {
  if (groundMesh) {
    groundMesh.geometry.dispose();
    (groundMesh.material as MeshStandardMaterial).dispose();
    groundMesh = null;
  }

  const tiles = Array.from(state.world.tiles.values());
  if (tiles.length === 0) return;

  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const tile of tiles) {
    const pos = axialToWorld3D(tile.coord.q, tile.coord.r, 0);
    minX = Math.min(minX, pos.x);
    maxX = Math.max(maxX, pos.x);
    minZ = Math.min(minZ, pos.z);
    maxZ = Math.max(maxZ, pos.z);
  }

  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const radius = Math.max(maxX - minX, maxZ - minZ) / 2 + HEX_SIZE * 5;

  // Higher resolution circle for smoother rim
  const geom = new CircleGeometry(radius, 96);
  geom.rotateX(-Math.PI / 2);

  // Per-vertex color: warm dark earth in center, fading to near-black at rim
  const posAttr = geom.getAttribute('position');
  const colors: number[] = [];
  const baseColor = new Color(0x4a5540); // dark olive earth
  const rimColor = new Color(0x1a1a18); // near-black void
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const z = posAttr.getZ(i);
    const dist = Math.hypot(x, z);
    const t = Math.min(1.0, dist / radius);
    // Smoothstep fade: center 60% stays base, outer 40% darkens to rim
    const fade = Math.max(0.0, (t - 0.6) / 0.4);
    const c = baseColor.clone().lerp(rimColor, fade * 0.85);
    colors.push(c.r, c.g, c.b);
  }
  geom.setAttribute('color', new Float32BufferAttribute(colors, 3));

  const mat = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.0,
    fog: true,
  });
  // Fallback base color for ambient lighting
  mat.color = new Color(0x4a5540);

  groundMesh = new Mesh(geom, mat);
  groundMesh.position.set(cx, -TILE_HEIGHT * 3 - 8, cz);
  groundMesh.receiveShadow = true;
  groundMesh.renderOrder = -200;
}

export function getGroundMesh(): Mesh | null {
  return groundMesh;
}

export function disposeGroundMesh(): void {
  if (groundMesh) {
    groundMesh.geometry.dispose();
    (groundMesh.material as MeshStandardMaterial).dispose();
    groundMesh = null;
  }
}
