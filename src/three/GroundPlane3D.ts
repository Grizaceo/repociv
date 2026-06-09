// ─── Ground plane: continuous earth base beneath all hex tiles ───────────────
import {
  CircleGeometry,
  Mesh,
  MeshStandardMaterial,
  Color,
} from 'three';
import { type GameState } from '../game.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';
import { HEX_SIZE } from '../constants.ts';
import { TILE_PRISM_HEIGHT } from './hexGeometry.ts';

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
    color: new Color(0x8b7355), // warm light earth — Civ V-style base tone
    roughness: 0.95,
    metalness: 0.0,
  });

  groundMesh = new Mesh(geom, mat);
  groundMesh.position.set(cx, -TILE_PRISM_HEIGHT * 0.45, cz);
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

