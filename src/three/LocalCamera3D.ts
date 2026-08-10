// ─── Local view: Three.js OrthographicCamera isometric setup ────────────────
// Maps the existing 2D iso projection (isoOfficeSprites.ts) into 3D world
// coordinates so an OrthographicCamera at ~26.57° elevation reproduces the
// exact same diamond grid.  Zoom and pan are driven by syncing with the 2D
// LocalRenderer.cam state.

import { OrthographicCamera, Vector3 } from 'three';

import { ISO_TILE_W, ISO_TILE_H, ISO_WALL_H } from '../isoOfficeSprites.ts';

// Camera angle: the 2D iso projection has a 2:1 diamond (64:32),
// which corresponds to atan(1/2) ≈ 26.57° elevation.
const CAMERA_ELEVATION = Math.atan(ISO_TILE_H / ISO_TILE_W);
const CAMERA_AZIMUTH = Math.PI / 4; // 45° — looking down the X+Z diagonal

export interface LocalCamState {
  x: number; // pan target X (world units)
  y: number; // pan target Z (world units, mapped from 2D cam.y)
  zoom: number; // zoom multiplier (1 = 1:1 with 2D)
  cx: number; // canvas center X (pixels)
  cy: number; // canvas center Y (pixels)
}

/** Convert a local grid (x, y, z) to 3D world coordinates. */
export function localGridToWorld3D(x: number, y: number, z: number = 0): Vector3 {
  return new Vector3((x - y) * (ISO_TILE_W / 2), z * ISO_WALL_H, (x + y) * (ISO_TILE_H / 2));
}

/** Inverse: 3D world XZ → grid (x, y) fractional. */
export function world3DToLocalGrid(wx: number, wz: number): { x: number; y: number } {
  // Invert: wx = (x - y) * 32, wz = (x + y) * 16
  // → x = (wx/32 + wz/16) / 2, y = (wz/16 - wx/32) / 2
  const a = wx / (ISO_TILE_W / 2);
  const b = wz / (ISO_TILE_H / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Re-exports for convenience so other local-3D modules import from one place. */
export { ISO_TILE_W, ISO_TILE_H, ISO_WALL_H };

export class LocalCamera3D {
  private camera: OrthographicCamera;
  private target: Vector3;
  private width: number;
  private height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.target = new Vector3(0, 0, 0);

    // Ortho frustum: ±half in world units. The 2D renderer uses pixel-space
    // directly; for 3D we set the frustum to half the viewport size and
    // apply zoom as a divisor.
    const halfW = width / 2;
    const halfH = height / 2;
    this.camera = new OrthographicCamera(-halfW, halfW, halfH, -halfH, -2000, 2000);

    this.updatePosition();
  }

  /** Sync camera with the 2D LocalCamState (x, y, zoom from LocalRenderer.cam). */
  syncCamera(cam: LocalCamState): void {
    this.target.set(cam.x, 0, cam.y);

    // Ortho zoom: divide frustum by zoom factor
    const halfW = this.width / 2 / cam.zoom;
    const halfH = this.height / 2 / cam.zoom;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();

    this.updatePosition();
  }

  private updatePosition(): void {
    // Position the camera along the iso viewing direction at distance 1000.
    // Direction: (cos(az)*cos(elev), sin(elev), sin(az)*cos(elev))
    // This places the camera up-and-back so it looks down at the grid
    // from the classic 2:1 iso angle.
    const dist = 1000;
    const dx = Math.cos(CAMERA_AZIMUTH) * Math.cos(CAMERA_ELEVATION);
    const dy = Math.sin(CAMERA_ELEVATION);
    const dz = Math.sin(CAMERA_AZIMUTH) * Math.cos(CAMERA_ELEVATION);
    this.camera.position.set(
      this.target.x + dist * dx,
      this.target.y + dist * dy,
      this.target.z + dist * dz,
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  getCamera(): OrthographicCamera {
    return this.camera;
  }
}
