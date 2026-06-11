// ─── Ground plane: continuous earth base beneath all hex tiles ───────────────
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

/** Rebuild a large earth-coloured disc beneath the map so hexes don’t look like
 *  floating islands. Size scales with the tile bounding box. */
export function rebuildGroundPlane(state: GameState): void {
  if (groundMesh) {
    groundMesh.geometry.dispose();
    (groundMesh.material as MeshStandardMaterial).dispose();
    groundMesh = null;
  }

  const tiles = Array.from(state.world.tiles.values());
  if (tiles.length === 0) return;

  // Compute bounding box in world XZ
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
  const radius = Math.max(maxX - minX, maxZ - minZ) / 2 + HEX_SIZE * 4;

  const geom = new CircleGeometry(radius, 64);
  geom.rotateX(-Math.PI / 2); // face upward

  const mat = new MeshStandardMaterial({
    color: new Color(0x6f6a54), // muted olive-umber so gaps feel like earth, not raw brown cardboard
    roughness: 0.98,
    metalness: 0.0,
  });

  groundMesh = new Mesh(geom, mat);
  // Below the ocean top face (elev -1 → y = -TILE_HEIGHT): the old
  // -TILE_PRISM_HEIGHT*0.22 (-5.28) sat ABOVE the ocean tops and buried the
  // entire ocean ring under the disc — the map read as land floating on a
  // brown void, and the shoreline foam (gap #2) was invisible at every coast.
  groundMesh.position.set(cx, -TILE_HEIGHT - 2.5, cz);
  groundMesh.receiveShadow = true;
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

