// ─── Ground plane: dark earth fill beneath hex tiles (gap + map-edge void) ───
import {
  CircleGeometry,
  Mesh,
  MeshStandardMaterial,
  Color,
} from 'three';
import { type GameState } from '../game.ts';
import { axialToWorld3D, TILE_HEIGHT } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';

let groundMesh: Mesh | null = null;

/** Dark olive earth disc — fills sub-pixel hex gaps and the map rim. Sits well
 *  below prism bottoms so it never z-fights caps; warm fog no longer reads as
 *  the floor when tiles don't quite meet. */
export function rebuildGroundPlane(state: GameState): void {
  if (groundMesh) {
    groundMesh.geometry.dispose();
    (groundMesh.material as MeshStandardMaterial).dispose();
    groundMesh = null;
  }

  const tiles = Array.from(state.world.tiles.values());
  if (tiles.length === 0) return;

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
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

  const geom = new CircleGeometry(radius, 72);
  geom.rotateX(-Math.PI / 2);

  const mat = new MeshStandardMaterial({
    color: new Color(0x4a5540),
    roughness: 0.96,
    metalness: 0.0,
    fog: true,
  });

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
