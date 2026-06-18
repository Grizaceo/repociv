// ─── WebGL map facade: renderer loop, camera sync, resize, picking ───────────
import {
  ACESFilmicToneMapping,
  PCFSoftShadowMap,
  WebGLRenderer,
  PerspectiveCamera,
  Vector3,
  type Scene,
  type Camera as ThreeCamera,
} from 'three';
import { type Camera as MapCamera } from '../hex.ts';
import { type Axial } from '../hex.ts';
import { type GameState } from '../game.ts';
import { terrainElevation } from '../isoHex.ts';
import { tileKey } from '../types.ts';
import { HEX_SIZE } from '../constants.ts';
import {
  createHexWorldScene,
  updateHexWorldScene,
  disposeHexWorldScene,
  getTerrainMesh,
  isTerrainAtlasReady,
  type HexSceneRenderOptions,
} from './HexWorldScene.ts';
import { HexPicker } from './HexPicker.ts';
import { areMountainPropsReady } from './MountainProps3D.ts';
import { areUnitPropsReady } from './UnitProps3D.ts';
import { areResourcePropsReady } from './ResourceProps3D.ts';
import { areForestPropsReady } from './ForestProps3D.ts';
import { areCityPropsReady } from './CityProps3D.ts';
import { axialToWorld3D, hexCornerAngle3D } from './axialToWorld3D.ts';
import { initLabelRenderer, renderLabels, disposeLabels } from './MapLabels3D.ts';
import { updateSkyDome } from './SkyDome3D.ts';
import { SKY_TOP } from './terrainShader.ts';

const CAMERA_TILT = 0.62;
const CAMERA_BASE_DISTANCE = 320;
const CAMERA_FOV = 42;

export class ThreeMapRenderer {
  private container: HTMLElement;
  private renderer: WebGLRenderer;
  private scene: Scene;
  private camera: PerspectiveCamera;
  private picker = new HexPicker();
  private target = new Vector3();
  private cornerWorld = new Vector3();
  private resizeObserver: ResizeObserver;
  private width = 1;
  private height = 1;
  private lastTileSignature = '';
  // Dirty-rate telemetry: % of frames that triggered the heavy rebuilds.
  // Idle should sit near 0% — anything above ~5% means the signature has
  // a false positive (some input flapping per frame).
  private _dirtyFrames = 0;
  private _windowFrames = 0;
  private _dirtyRatePct = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Filmic curve gives the warm, slightly compressed highlights of the
    // Civ V palette; the linear default read flat and pastel. The sky dome
    // is a raw ShaderMaterial (not tone-mapped) but FogExp2 converges
    // distant tiles to the horizon colour, so the seam stays coherent.
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;
    // Soft sun shadows — props anchor to the ground the way Civ V's do.
    // One directional 4k map over the whole world; texel ≈ 1.4 world units,
    // which reads as a soft blob, exactly the target.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.setClearColor(SKY_TOP.getHex(), 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';

    initLabelRenderer(container);

    this.scene = createHexWorldScene();
    this.camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 4000);

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
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  /** Sync perspective Civ camera with 2D map Camera struct. */
  syncCamera(cam: MapCamera): void {
    this.target.set(cam.x, 0, cam.y);
    const dist = CAMERA_BASE_DISTANCE / cam.zoom;
    this.camera.position.set(
      this.target.x - dist * Math.cos(CAMERA_TILT),
      this.target.y + dist * Math.sin(CAMERA_TILT),
      this.target.z + dist * 0.38,
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  render(state: GameState, cam: MapCamera, opts: HexSceneRenderOptions): void {
    this.syncCamera(cam);
    // Keep the gradient sky centered on the camera (it must never clip).
    updateSkyDome(this.camera.position);

    // The world signature feeds the dirty-flag: terrain/ground/territory/
    // cities/units/labels are rebuilt only when one of these inputs
    // changes. Render options participate too: the gated rebuilds take
    // lod/fog/layer toggles as arguments, so a toggle or zoom-driven LOD
    // change must mark the scene dirty even when world state is stable.
    // Per-frame animTime-driven updates (foam, shoreline, sun arc,
    // shader time) still run on every frame because their input is
    // animTime, not world state.
    const tileSignature =
      computeWorldSignature(state) +
      `@${opts.lod}:${opts.fogEnabled ? 1 : 0}:${opts.showStructure ? 1 : 0}:${opts.showOps ? 1 : 0}:${opts.showLabels ? 1 : 0}` +
      `:atlas${isTerrainAtlasReady() ? 1 : 0}` +
      `:mprops${areMountainPropsReady() ? 1 : 0}` +
      `:fprops${areForestPropsReady() ? 1 : 0}` +
      `:cprops${areCityPropsReady() ? 1 : 0}` +
      `:uprops${areUnitPropsReady() ? 1 : 0}` +
      `:rprops${areResourcePropsReady() ? 1 : 0}`;
    const stateDirty = tileSignature !== this.lastTileSignature;
    this.lastTileSignature = tileSignature;

    this._windowFrames++;
    if (stateDirty) this._dirtyFrames++;
    if (this._windowFrames >= 300) {
      this._dirtyRatePct = Math.round((this._dirtyFrames / this._windowFrames) * 1000) / 10;
      this._windowFrames = 0;
      this._dirtyFrames = 0;
    }

    updateHexWorldScene(this.scene, state, opts, this.picker, stateDirty);

    this.renderer.render(this.scene, this.camera);
    renderLabels(this.scene, this.camera, this.width, this.height);
  }

  pickAxial(screenX: number, screenY: number): Axial | null {
    const mesh = getTerrainMesh();
    if (!mesh) return null;
    return this.picker.pick(mesh, this.camera, this.width, this.height, screenX, screenY);
  }

  /** Tile center in map world space (for canvas overlay sync). */
  projectTileCenter(coord: Axial, state: GameState, cam: MapCamera): { x: number; y: number } {
    const tile = state.world.tiles.get(tileKey(coord));
    const elev = tile ? terrainElevation(tile.terrain) : 0;
    const world = axialToWorld3D(coord.q, coord.r, elev);
    world.y += 2;
    return this.screenToMapSpace(world, cam);
  }

  /** Hex corner outline in map world space for canvas overlay. */
  projectHexOutline(coord: Axial, state: GameState, cam: MapCamera): Array<{ x: number; y: number }> {
    const tile = state.world.tiles.get(tileKey(coord));
    const elev = tile ? terrainElevation(tile.terrain) : 0;
    const center = axialToWorld3D(coord.q, coord.r, elev);
    const corners: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 6; i++) {
      const angle = hexCornerAngle3D(i);
      this.cornerWorld.set(
        center.x + HEX_SIZE * Math.cos(angle),
        center.y + 1.5,
        center.z + HEX_SIZE * Math.sin(angle),
      );
      corners.push(this.screenToMapSpace(this.cornerWorld, cam));
    }
    return corners;
  }

  private screenToMapSpace(world: Vector3, cam: MapCamera): { x: number; y: number } {
    const screen = this.picker.projectToScreen(world, this.camera, this.width, this.height);
    return {
      x: (screen.x - cam.cx) / cam.zoom + cam.x,
      y: (screen.y - cam.cy) / cam.zoom + cam.y,
    };
  }

  getCamera(): ThreeCamera {
    return this.camera;
  }

  getPicker(): HexPicker {
    return this.picker;
  }

  /** True once the terrain texture atlas loaded (golden-capture wait). */
  isAtlasReady(): boolean {
    return isTerrainAtlasReady();
  }

  /** % of frames in the last 300-frame window that ran the heavy rebuilds. */
  getDirtyRatePct(): number {
    return this._dirtyRatePct;
  }

  /** Shadow-pipeline introspection for capture scripts and debugging. */
  getShadowDebug(): {
    shadowMapEnabled: boolean;
    sunCastShadow: boolean;
    sunShadowMapAllocated: boolean;
    casters: number;
    receivers: number;
  } {
    let casters = 0;
    let receivers = 0;
    let sunCast = false;
    let sunMap = false;
    this.scene.traverse((o) => {
      const obj = o as unknown as {
        isDirectionalLight?: boolean;
        isMesh?: boolean;
        castShadow?: boolean;
        receiveShadow?: boolean;
        shadow?: { map: unknown };
      };
      if (obj.isDirectionalLight && obj.castShadow) {
        sunCast = true;
        sunMap = Boolean(obj.shadow?.map);
      }
      if (obj.isMesh) {
        if (obj.castShadow) casters++;
        if (obj.receiveShadow) receivers++;
      }
    });
    return {
      shadowMapEnabled: this.renderer.shadowMap.enabled,
      sunCastShadow: sunCast,
      sunShadowMapAllocated: sunMap,
      casters,
      receivers,
    };
  }

  getCanvasSize(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  setActive(active: boolean): void {
    this.container.classList.toggle('active', active);
    if (active) this.handleResize();
  }

  resize(): void {
    this.handleResize();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    disposeLabels(this.container);
    disposeHexWorldScene(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/**
 * Hash of the world state inputs that drive the "state-driven" rebuilds
 * in HexWorldScene. Changing any of these forces a rebuild of the
 * terrain mesh, ground plane, territory lines, city clusters, units,
 * and labels. Per-frame animTime-driven updates (foam, shoreline, sun
 * arc, shader time) are NOT gated by this — they run every frame.
 *
 * It must cover every world input the gated rebuilds read, not just
 * entity counts: unit coords/state (units move without changing id),
 * fog/revealed flips (terrain mesh tints by fog), city names and
 * territory growth (labels and territory lines). Misses here freeze
 * the corresponding visual until an unrelated state change — see the
 * Phase-2 audit. It does not include animTime or render options;
 * those are appended at the call site in ThreeMapRenderer.render.
 */
export function computeWorldSignature(state: GameState): string {
  const tiles = state.world.tiles;
  const cities = state.world.cities;
  const units = state.world.units;
  let revealed = 0;
  let fogged = 0;
  for (const t of tiles.values()) {
    if (t.revealed) revealed++;
    if (t.inFog) fogged++;
  }
  return [
    tiles.size,
    revealed,
    fogged,
    cities.length,
    units.length,
    // Include wonder districts so connecting/disconnecting a wonder at runtime
    // (which replaces a territory tile in place — tiles.size unchanged) still
    // flips the dirty flag and rebuilds the wonder props.
    cities
      .map(
        (c) =>
          `${c.id}:${c.name}:${c.territory.length}:${(c.districts ?? [])
            .filter((d) => d.type === 'wonder')
            .map((d) => d.wonderType)
            .join(',')}`,
      )
      .join('|'),
    units.map((u) => `${u.id}:${u.coord.q},${u.coord.r}:${u.state}`).join('|'),
  ].join('#');
}

export type { HexSceneRenderOptions };