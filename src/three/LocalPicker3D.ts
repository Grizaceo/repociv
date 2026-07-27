// ─── RepoCiv — Local Picker 3D (raycast picking for local view) ──────────────
// Mirrors HexPicker.ts pattern: screen → NDC → Raycaster → InstancedMesh hit.

import { Raycaster, Vector2, type Camera } from 'three';
import type { LocalTile, LocalUnit, LocalWorld } from '../types.ts';
import type { LocalTile3D } from './LocalTile3D.ts';
import type { LocalAgent3D } from './LocalAgent3D.ts';

export interface PickResult {
  tile: LocalTile | null;
  tileX: number;
  tileY: number;
  unit: LocalUnit | null;
}

export class LocalPicker3D {
  private ndc = new Vector2();
  private raycaster = new Raycaster();

  /**
   * Pick at screen coordinates (sx, sy) on a canvas of size (canvasW, canvasH).
   * Returns the first hit: either a floor tile (via LocalTile3D.instanceToTile)
   * or an agent (via LocalAgent3D.getAgentMeshes).
   */
  pick(
    sx: number,
    sy: number,
    canvasW: number,
    canvasH: number,
    camera: Camera,
    tile3D: LocalTile3D,
    agent3D: LocalAgent3D,
    world: LocalWorld,
    units: LocalUnit[],
  ): PickResult {
    // Screen → NDC
    this.ndc.set(
      (sx / canvasW) * 2 - 1,
      -(sy / canvasH) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);

    // Try floor mesh first
    const floorMesh = tile3D.getFloorMesh();
    if (floorMesh) {
      const hits = this.raycaster.intersectObject(floorMesh);
      if (hits.length > 0) {
        const instanceId = hits[0]!.instanceId;
        if (instanceId !== undefined) {
          const tile = tile3D.resolveTileFromInstance(instanceId, world);
          if (tile) {
            return { tile, tileX: tile.x, tileY: tile.y, unit: null };
          }
        }
      }
    }

    // Try agent meshes
    const agentMeshes = agent3D.getAgentMeshes();
    for (const [unitId, mesh] of agentMeshes) {
      const hits = this.raycaster.intersectObject(mesh, true);
      if (hits.length > 0) {
        const unit = units.find((u) => u.id === unitId);
        if (unit) {
          return { tile: null, tileX: -1, tileY: -1, unit };
        }
      }
    }

    return { tile: null, tileX: -1, tileY: -1, unit: null };
  }

  /** Pick for hover (lighter — only floor tiles, no agent check). */
  pickHover(
    sx: number,
    sy: number,
    canvasW: number,
    canvasH: number,
    camera: Camera,
    tile3D: LocalTile3D,
    world: LocalWorld,
  ): { x: number; y: number; tile: LocalTile | null } | null {
    this.ndc.set(
      (sx / canvasW) * 2 - 1,
      -(sy / canvasH) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, camera);

    const floorMesh = tile3D.getFloorMesh();
    if (floorMesh) {
      const hits = this.raycaster.intersectObject(floorMesh);
      if (hits.length > 0) {
        const instanceId = hits[0]!.instanceId;
        if (instanceId !== undefined) {
          const tile = tile3D.resolveTileFromInstance(instanceId, world);
          if (tile) {
            return { x: tile.x, y: tile.y, tile };
          }
        }
      }
    }
    return null;
  }
}