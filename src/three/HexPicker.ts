// ─── Raycast picking: screen → axial via InstancedMesh ───────────────────────
import { Raycaster, Vector2, Vector3, type Camera, type InstancedMesh } from 'three';
import { type Axial } from '../hex.ts';
import { tileKey } from '../types.ts';

export class HexPicker {
  private ndc = new Vector2();
  private raycaster = new Raycaster();
  private readonly instanceToAxial = new Map<number, Axial>();
  private readonly axialToInstance = new Map<string, number>();

  /** Rebuild lookup tables when tile instances change. */
  setInstanceMap(entries: Array<{ instanceId: number; coord: Axial }>): void {
    this.instanceToAxial.clear();
    this.axialToInstance.clear();
    for (const { instanceId, coord } of entries) {
      this.instanceToAxial.set(instanceId, coord);
      this.axialToInstance.set(tileKey(coord), instanceId);
    }
  }

  getAxialForInstance(instanceId: number): Axial | null {
    return this.instanceToAxial.get(instanceId) ?? null;
  }

  getInstanceForAxial(coord: Axial): number | null {
    return this.axialToInstance.get(tileKey(coord)) ?? null;
  }

  /** Pick from canvas pixel coordinates. */
  pick(
    mesh: InstancedMesh,
    camera: Camera,
    canvasWidth: number,
    canvasHeight: number,
    screenX: number,
    screenY: number,
  ): Axial | null {
    this.ndc.x = (screenX / canvasWidth) * 2 - 1;
    this.ndc.y = -(screenY / canvasHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, camera);
    const hits = this.raycaster.intersectObject(mesh, false);
    if (hits.length === 0 || hits[0]!.instanceId === undefined) return null;
    return this.instanceToAxial.get(hits[0]!.instanceId) ?? null;
  }

  /** Test helper: pick from normalized device coords without DOM. */
  pickNdc(
    mesh: InstancedMesh,
    camera: Camera,
    ndcX: number,
    ndcY: number,
  ): Axial | null {
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, camera);
    const hits = this.raycaster.intersectObject(mesh, false);
    if (hits.length === 0 || hits[0]!.instanceId === undefined) return null;
    return this.instanceToAxial.get(hits[0]!.instanceId) ?? null;
  }

  /** Project world position to canvas pixels (for overlays). */
  projectToScreen(
    world: Vector3,
    camera: Camera,
    canvasWidth: number,
    canvasHeight: number,
    target = new Vector2(),
  ): { x: number; y: number } {
    const v = world.clone().project(camera);
    target.x = ((v.x + 1) / 2) * canvasWidth;
    target.y = ((-v.y + 1) / 2) * canvasHeight;
    return { x: target.x, y: target.y };
  }
}
