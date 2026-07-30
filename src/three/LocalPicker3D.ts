// ─── Local view: raycast picking on floor InstancedMesh ────────────────────
// Converts screen clicks to local grid (x, y) via raycast against the floor
// InstancedMesh. Reuses the HexPicker pattern but maps hit point world
// coordinates back to grid space via world3DToLocalGrid.

import { Raycaster, Vector2, type Camera, type InstancedMesh } from 'three';
import { world3DToLocalGrid } from './LocalCamera3D.ts';

export class LocalPicker3D {
  private ndc = new Vector2();
  private raycaster = new Raycaster();

  /** Pick a grid tile from screen coordinates.
   *  Returns fractional grid coords, or null if no hit. */
  pick(
    floorMesh: InstancedMesh,
    camera: Camera,
    canvasWidth: number,
    canvasHeight: number,
    screenX: number,
    screenY: number,
  ): { x: number; y: number } | null {
    this.ndc.x = (screenX / canvasWidth) * 2 - 1;
    this.ndc.y = -(screenY / canvasHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, camera);
    const hits = this.raycaster.intersectObject(floorMesh, false);
    if (hits.length === 0 || hits[0]!.instanceId === undefined) return null;

    const hitPoint = hits[0]!.point;
    return world3DToLocalGrid(hitPoint.x, hitPoint.z);
  }

  /** Pick with NDC coordinates directly (test helper). */
  pickNdc(
    floorMesh: InstancedMesh,
    camera: Camera,
    ndcX: number,
    ndcY: number,
  ): { x: number; y: number } | null {
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, camera);
    const hits = this.raycaster.intersectObject(floorMesh, false);
    if (hits.length === 0 || hits[0]!.instanceId === undefined) return null;
    const hitPoint = hits[0]!.point;
    return world3DToLocalGrid(hitPoint.x, hitPoint.z);
  }
}
