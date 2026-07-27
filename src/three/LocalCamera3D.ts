// ─── RepoCiv — Local Camera 3D (isometric camera for the 3D local view) ──────
// Mirrors the 2D iso renderer geometry exactly (same tile/wall constants) and
// builds an OrthographicCamera that looks at the local grid from the classic
// isometric elevation/azimuth used by isoOfficeSprites.ts.
//
// Constants are imported from isoOfficeSprites.ts so this module stays in sync
// with the 2D renderer — do NOT hardcode the tile/wall sizes here.

import { OrthographicCamera, Vector3 } from 'three';
import {
  ISO_TILE_W,
  ISO_TILE_H,
  ISO_WALL_H,
  ISO_PARTITION_H,
} from '../isoOfficeSprites.ts';

// ─── Camera orientation (matches 2D iso projection) ───────────────────────
// The 2D renderer maps (x,y) -> screen via (x-y)*W/2, (x+y)*H/2.
// That implies the viewer sits along an azimuth of 45° (X+Z diagonal) at an
// elevation whose tangent is H/W (= 32/64 = 0.5), i.e. atan(0.5) ≈ 26.57°.
export const CAMERA_ELEVATION = Math.atan(ISO_TILE_H / ISO_TILE_W); // ≈ 26.57°
export const CAMERA_AZIMUTH = Math.PI / 4; // 45° — looking down X+Z diagonal

// ─── Grid ↔ world conversion ──────────────────────────────────────────────
/**
 * Convert local grid coordinates (x, y, z) to a Three.js world Vector3.
 * Mirrors isoProject() but emits a 3D position where Y is vertical (height).
 *
 *   X = (x - y) * (ISO_TILE_W / 2)   // [= (x-y)*32]
 *   Y = z * ISO_WALL_H               // [= z*24]
 *   Z = (x + y) * (ISO_TILE_H / 2)   // [= (x+y)*16]
 */
export function localGridToWorld3D(x: number, y: number, z = 0): Vector3 {
  return new Vector3(
    (x - y) * (ISO_TILE_W / 2),
    z * ISO_WALL_H,
    (x + y) * (ISO_TILE_H / 2),
  );
}

/**
 * Inverse of localGridToWorld3D for the horizontal plane (z derived separately).
 * Given a world (wx, wz), recover grid (x, y):
 *   a = wx / (ISO_TILE_W / 2)
 *   b = wz / (ISO_TILE_H / 2)
 *   x = (a + b) / 2
 *   y = (b - a) / 2
 */
export function world3DToLocalGrid(wx: number, wz: number): { x: number; y: number } {
  const a = wx / (ISO_TILE_W / 2);
  const b = wz / (ISO_TILE_H / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

// ─── Camera state (mirrors the 2D LocalCam) ────────────────────────────────
export interface LocalCamState {
  x: number; // target grid x (or world x — same units as localGridToWorld3D)
  y: number; // target grid y
  zoom: number; // >1 zooms in (frustum shrinks), <1 zooms out
  cx: number; // canvas width (px)
  cy: number; // canvas height (px)
}

// ─── LocalCamera3D ─────────────────────────────────────────────────────────
export class LocalCamera3D {
  private readonly camera: OrthographicCamera;
  private halfW = 0;
  private halfH = 0;
  private zoom = 1;
  private target: Vector3;

  constructor(width: number, height: number) {
    this.halfW = width / 2;
    this.halfH = height / 2;
    this.zoom = 1;
    this.target = new Vector3(0, 0, 0);
    this.camera = new OrthographicCamera(
      -this.halfW,
      this.halfW,
      this.halfH,
      -this.halfH,
      -2000,
      2000,
    );
    this.updatePosition();
  }

  /**
   * Sync the camera from a 2D-style LocalCamState.
   * - target moves to (cam.x, cam.y) in world space
   * - zoom scales the frustum (higher zoom = smaller frustum = closer view)
   */
  syncCamera(cam: LocalCamState): void {
    this.halfW = cam.cx / 2;
    this.halfH = cam.cy / 2;
    this.zoom = cam.zoom;
    this.target.set(cam.x, 0, cam.y);

    const zw = this.halfW / this.zoom;
    const zh = this.halfH / this.zoom;
    this.camera.left = -zw;
    this.camera.right = zw;
    this.camera.top = zh;
    this.camera.bottom = -zh;
    this.camera.updateProjectionMatrix();

    this.updatePosition();
  }

  resize(width: number, height: number): void {
    this.halfW = width / 2;
    this.halfH = height / 2;
    const zw = this.halfW / this.zoom;
    const zh = this.halfH / this.zoom;
    this.camera.left = -zw;
    this.camera.right = zw;
    this.camera.top = zh;
    this.camera.bottom = -zh;
    this.camera.updateProjectionMatrix();
    this.updatePosition();
  }

  getCamera(): OrthographicCamera {
    return this.camera;
  }

  /**
   * Vertical world Y for a given floor index. Used for multi-floor buildings.
   * Each floor is `floorHeight` tall (typically ISO_WALL_H).
   */
  getFloorY(floor: number, floorHeight: number): number {
    return floor * floorHeight;
  }

  /**
   * Place the camera at target + dist*direction and aim at the target.
   * Direction is the unit vector from target toward the viewer:
   *   dir = (cos(az)*cos(elev), sin(elev), sin(az)*cos(elev))
   * dist=1000 keeps the camera well outside the scene while keeping the
   * orthographic frustum the thing that actually defines the view.
   */
  private updatePosition(): void {
    const dist = 1000;
    const dirX = Math.cos(CAMERA_AZIMUTH) * Math.cos(CAMERA_ELEVATION);
    const dirY = Math.sin(CAMERA_ELEVATION);
    const dirZ = Math.sin(CAMERA_AZIMUTH) * Math.cos(CAMERA_ELEVATION);
    this.camera.position.set(
      this.target.x + dist * dirX,
      this.target.y + dist * dirY,
      this.target.z + dist * dirZ,
    );
    this.camera.lookAt(this.target);
  }
}

// Re-export the iso constants so consumers of this module (e.g. LocalTile3D)
// can import them from one place without reaching into isoOfficeSprites.ts.
export { ISO_TILE_W, ISO_TILE_H, ISO_WALL_H, ISO_PARTITION_H };