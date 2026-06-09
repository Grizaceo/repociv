// ─── WebGL map facade: renderer loop, camera sync, resize, picking ───────────
import {
  WebGLRenderer,
  OrthographicCamera,
  Vector3,
  type Scene,
} from 'three';
import { type Camera as MapCamera } from '../hex.ts';
import { type Axial } from '../hex.ts';
import { type GameState } from '../game.ts';
import { terrainElevation } from '../isoHex.ts';
import { tileKey } from '../types.ts';
import {
  createHexWorldScene,
  updateHexWorldScene,
  disposeHexWorldScene,
  getTerrainMesh,
  type HexSceneRenderOptions,
} from './HexWorldScene.ts';
import { HexPicker } from './HexPicker.ts';
import { axialToWorld3D } from './axialToWorld3D.ts';

const CAMERA_TILT = 0.65;
const CAMERA_DISTANCE = 220;

export class ThreeMapRenderer {
  private container: HTMLElement;
  private renderer: WebGLRenderer;
  private scene: Scene;
  private camera: OrthographicCamera;
  private picker = new HexPicker();
  private target = new Vector3();
  private resizeObserver: ResizeObserver;
  private width = 1;
  private height = 1;
  private lastTileSignature = '';

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x050505, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';

    this.scene = createHexWorldScene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
    this.handleResize();
  }

  private handleResize(): void {
    let rect = this.container.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) {
      const app = document.getElementById('app');
      rect = app?.getBoundingClientRect() ?? rect;
    }
    if (rect.width < 8 || rect.height < 8) {
      this.width = Math.max(1, window.innerWidth);
      this.height = Math.max(1, window.innerHeight);
    } else {
      this.width = Math.max(1, rect.width);
      this.height = Math.max(1, rect.height);
    }
    this.renderer.setSize(this.width, this.height, false);
    this.updateProjection(1);
  }

  private updateProjection(zoom: number): void {
    const aspect = this.width / this.height;
    const halfH = (this.height * 0.5) / zoom;
    const halfW = halfH * aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
  }

  /** Sync orthographic Civ camera with 2D map Camera struct. */
  syncCamera(cam: MapCamera): void {
    this.updateProjection(cam.zoom);
    this.target.set(cam.x, 0, cam.y);
    const dist = CAMERA_DISTANCE;
    this.camera.position.set(
      this.target.x - dist * Math.cos(CAMERA_TILT),
      this.target.y + dist * Math.sin(CAMERA_TILT),
      this.target.z + dist * 0.35,
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  render(state: GameState, cam: MapCamera, opts: HexSceneRenderOptions): void {
    this.syncCamera(cam);

    const tileSignature = `${state.world.tiles.size}:${state.world.cities.length}:${state.world.units.length}`;
    const fullRebuild = tileSignature !== this.lastTileSignature;
    if (fullRebuild) this.lastTileSignature = tileSignature;

    updateHexWorldScene(this.scene, state, opts, this.picker);

    this.renderer.render(this.scene, this.camera);
  }

  pickAxial(screenX: number, screenY: number): Axial | null {
    const mesh = getTerrainMesh();
    if (!mesh) return null;
    return this.picker.pick(mesh, this.camera, this.width, this.height, screenX, screenY);
  }

  /** Tile center in canvas pixels (for canvas overlay sync). */
  projectTileCenter(coord: Axial, state: GameState): { x: number; y: number } {
    const tile = state.world.tiles.get(tileKey(coord));
    const elev = tile ? terrainElevation(tile.terrain) : 0;
    const world = axialToWorld3D(coord.q, coord.r, elev);
    world.y += 2;
    return this.picker.projectToScreen(world, this.camera, this.width, this.height);
  }

  getPicker(): HexPicker {
    return this.picker;
  }

  getCanvasSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  setActive(active: boolean): void {
    this.container.classList.toggle('active', active);
    if (active) this.handleResize();
  }

  /** Force layout sync after container becomes visible. */
  resize(): void {
    this.handleResize();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    disposeHexWorldScene(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export type { HexSceneRenderOptions };
