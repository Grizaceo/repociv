// ─── Local view: Three.js OrthographicCamera isometric setup ────────────────
// The office grid lives in 3D as a FLAT SQUARE LATTICE. The camera does the
// isometric projection — that is the whole reason to have a 3D scene.
//
// This used to bake the 2D iso projection into world XZ and then look at it
// with an iso camera, projecting twice: the office came out sheared, mis-scaled
// and off-centre from the 2D view it is supposed to mirror. Grid space is now
// square (x → +X, y → +Z, one ISO_TILE_W per step), which also lets the tile
// boxes tile edge to edge instead of overlapping.
//
// Zoom and pan still sync with the 2D LocalRenderer.cam so switching between
// the two renderers does not move the view.

import { OrthographicCamera, Vector3 } from 'three';

import { ISO_TILE_W, ISO_TILE_H, ISO_WALL_H } from '../isoOfficeSprites.ts';

// Camera angle. For a 2:1 pixel-iso diamond the elevation is asin(1/2) = 30°,
// NOT atan(h/w) = 26.57°: what has to come out 2:1 is the ratio of the screen
// projections of one grid step, and that ratio is sin(elevation). At 26.57°
// the lattice projected 1:2.24 and every tile was subtly too tall.
const CAMERA_ELEVATION = Math.asin(0.5);
const CAMERA_AZIMUTH = Math.PI / 4; // 45° — looking down the X+Z diagonal

/** One grid step in 3D world units. Square lattice: the camera, not the
 *  coordinates, produces the diamond. */
export const LOCAL_TILE_3D = ISO_TILE_W;

/** A 45° camera sees a world-space step as `step / cos(45°)` on screen, so the
 *  ortho frustum has to be widened by √2 for the 3D view to match the 2D one
 *  pixel for pixel at the same zoom. */
const ISO_FRUSTUM_SCALE = Math.SQRT2;

export interface LocalCamState {
  x: number; // pan target X (world units)
  y: number; // pan target Z (world units, mapped from 2D cam.y)
  zoom: number; // zoom multiplier (1 = 1:1 with 2D)
  cx: number; // canvas center X (pixels)
  cy: number; // canvas center Y (pixels)
}

/** Local grid (x, y, z) → 3D world. Square lattice on the XZ plane. */
export function localGridToWorld3D(x: number, y: number, z: number = 0): Vector3 {
  return new Vector3(x * LOCAL_TILE_3D, z * ISO_WALL_H, y * LOCAL_TILE_3D);
}

/** Inverse: 3D world XZ → fractional grid (x, y). */
export function world3DToLocalGrid(wx: number, wz: number): { x: number; y: number } {
  return { x: wx / LOCAL_TILE_3D, y: wz / LOCAL_TILE_3D };
}

/** The 2D renderer pans in iso-projected pixel space; the 3D scene lives in
 *  square grid space. Unproject so both cameras look at the same tile. */
export function isoPixelToGrid(px: number, py: number): { x: number; y: number } {
  const a = px / (ISO_TILE_W / 2);
  const b = py / (ISO_TILE_H / 2);
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
    // cam.x/cam.y arrive in the 2D renderer's iso-projected pixel space.
    const g = isoPixelToGrid(cam.x, cam.y);
    this.target.set(g.x * LOCAL_TILE_3D, 0, g.y * LOCAL_TILE_3D);

    // Ortho zoom: divide the frustum by zoom, then widen by the iso factor so
    // one grid step covers the same pixels here as it does in the 2D view.
    const halfW = ((this.width / 2) * ISO_FRUSTUM_SCALE) / cam.zoom;
    const halfH = ((this.height / 2) * ISO_FRUSTUM_SCALE) / cam.zoom;
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
