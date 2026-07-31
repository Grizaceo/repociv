// ─── Local view: Three.js scene orchestrator ───────────────────────────────
// Top-level class that owns the Three.js Scene, WebGLRenderer, OrthographicCamera
// (via LocalCamera3D), tile meshes (LocalTile3D), agent figurines (LocalAgent3D),
// and lighting. Mirrors ThreeMapRenderer structure but for the local view.

import {
  ACESFilmicToneMapping,
  PCFSoftShadowMap,
  WebGLRenderer,
  AmbientLight,
  DirectionalLight,
  HemisphereLight,
  Scene,
  Color,
} from 'three';

import type { LocalWorld, LocalUnit, LocalNpc, LocalTile } from '../types.ts';
import { LocalCamera3D, type LocalCamState, ISO_TILE_W, ISO_TILE_H } from './LocalCamera3D.ts';
import { LocalTile3D } from './LocalTile3D.ts';
import { LocalAgent3D } from './LocalAgent3D.ts';
import { LocalPicker3D } from './LocalPicker3D.ts';

export interface LocalSceneRenderOptions {
  dt: number;
  workbenchLabelOverlay: boolean;
  powerOverlay: boolean;
  temperatureOverlay: boolean;
}

export interface LocalSceneCallbacks {
  onTileClick: ((x: number, y: number, tile: LocalTile | null, sx: number, sy: number) => void) | null;
  onLocalUnitClick: ((unit: LocalUnit, sx: number, sy: number) => void) | null;
  onWorkbenchClick: ((tile: LocalTile, sx: number, sy: number) => void) | null;
  onLocalUnitHover: ((unit: LocalUnit | null, sx: number, sy: number) => void) | null;
  onNpcClick: ((npc: LocalNpc, sx: number, sy: number) => void) | null;
  onUnitRendered: ((unit: LocalUnit, sx: number, sy: number) => void) | null;
  onDragAssign: ((unitId: string, workbenchTile: LocalTile) => void) | null;
  onZonePainted: ((type: string, tiles: Array<{ x: number; y: number }>) => void) | null;
  onRequestExit: (() => void) | null;
}

export class LocalScene3D {
  private container: HTMLElement;
  private renderer: WebGLRenderer;
  private scene: Scene;
  private camera3D: LocalCamera3D;
  private tile3D: LocalTile3D;
  private agent3D: LocalAgent3D;
  private picker: LocalPicker3D;
  private resizeObserver: ResizeObserver;
  private width = 1;
  private height = 1;
  private world: LocalWorld | null = null;
  private active = false;

  // Callbacks (wired from renderer.ts)
  callbacks: LocalSceneCallbacks = {
    onTileClick: null,
    onLocalUnitClick: null,
    onWorkbenchClick: null,
    onLocalUnitHover: null,
    onNpcClick: null,
    onUnitRendered: null,
    onDragAssign: null,
    onZonePainted: null,
    onRequestExit: null,
  };

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.setClearColor(0x1a1a1e, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';

    this.scene = new Scene();
    this.scene.background = new Color(0x1a1a1e);

    // Lighting: warm office lighting matching the 2D iso renderer
    this.scene.add(new AmbientLight(0xdacfb6, 0.45));
    this.scene.add(new HemisphereLight(0xb0d8f0, 0x6a5a4a, 0.3));

    // "Window light" directional — from the upper-left, warm
    const dirLight = new DirectionalLight(0xffe7bd, 1.1);
    dirLight.position.set(-200, 300, 200);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.left = -400;
    dirLight.shadow.camera.right = 400;
    dirLight.shadow.camera.top = 400;
    dirLight.shadow.camera.bottom = -400;
    dirLight.shadow.camera.near = 0.1;
    dirLight.shadow.camera.far = 1000;
    dirLight.shadow.camera.updateProjectionMatrix();
    dirLight.shadow.bias = -0.0005;
    this.scene.add(dirLight);

    this.camera3D = new LocalCamera3D(this.width, this.height);
    this.tile3D = new LocalTile3D();
    this.agent3D = new LocalAgent3D();
    this.picker = new LocalPicker3D();

    this.scene.add(this.tile3D.getGroup());
    this.scene.add(this.agent3D.getGroup());

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);
    this.handleResize();

    this.setupInput();
  }

  private handleResize(): void {
    let rect = this.container.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) {
      const app = document.getElementById('app');
      rect = app?.getBoundingClientRect() ?? rect;
    }
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.renderer.setSize(this.width, this.height, false);
    this.camera3D.resize(this.width, this.height);
  }

  setWorld(world: LocalWorld): void {
    this.world = world;
    // Center camera on world center
    const centerX = (world.width / 2) * (ISO_TILE_W / 2);
    const centerY = (world.height / 2) * (ISO_TILE_H / 2);
    // Initial camera state — will be overridden by syncCamera each frame
    this.camera3D.syncCamera({ x: centerX, y: centerY, zoom: 1, cx: this.width / 2, cy: this.height / 2 });
  }

  render(cam: LocalCamState, units: LocalUnit[], npcs: LocalNpc[], opts: LocalSceneRenderOptions): void {
    if (!this.world || !this.active) return;

    // Rebuild tiles if dirty
    this.tile3D.rebuild(this.world, {
      workbenchLabelOverlay: opts.workbenchLabelOverlay,
      powerOverlay: opts.powerOverlay,
      temperatureOverlay: opts.temperatureOverlay,
    });

    // Update agents (incremental add/remove + per-frame animations)
    this.agent3D.update(units, npcs, opts.dt);

    // Sync camera
    this.camera3D.syncCamera(cam);

    // Render
    this.renderer.render(this.scene, this.camera3D.getCamera());
  }

  pickTile(screenX: number, screenY: number): { x: number; y: number } | null {
    const floorMesh = this.tile3D.getFloorMesh();
    if (!floorMesh) return null;
    return this.picker.pick(floorMesh, this.camera3D.getCamera(), this.width, this.height, screenX, screenY);
  }

  setActive(active: boolean): void {
    this.active = active;
    this.container.classList.toggle('active', active);
    if (active) this.handleResize();
  }

  isActive(): boolean {
    return this.active;
  }

  resize(): void {
    this.handleResize();
  }

  private setupInput(): void {
    const canvas = this.renderer.domElement;

    // Click handler: pick tile, determine type, fire callback
    canvas.addEventListener('click', (e: MouseEvent) => {
      if (!this.world || !this.active) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const grid = this.pickTile(sx, sy);
      if (!grid) return;

      // Round to integer grid coords
      const gx = Math.floor(grid.x);
      const gy = Math.floor(grid.y);

      // Find tile at grid position
      const tile = this.world.grid[gy]?.[gx] ?? null;

      // Check for unit at this position first
      const unit = this.findUnitAt(gx, gy);
      if (unit && this.callbacks.onLocalUnitClick) {
        this.callbacks.onLocalUnitClick(unit, sx, sy);
        return;
      }

      // Check for NPC
      const npc = this.findNpcAt(gx, gy);
      if (npc && this.callbacks.onNpcClick) {
        this.callbacks.onNpcClick(npc, sx, sy);
        return;
      }

      // Workbench click
      if (tile?.type === 'workbench' && this.callbacks.onWorkbenchClick) {
        this.callbacks.onWorkbenchClick(tile, sx, sy);
        return;
      }

      // Default: tile click
      if (this.callbacks.onTileClick) {
        this.callbacks.onTileClick(gx, gy, tile, sx, sy);
      }
    });

    // Right-click: exit local view
    canvas.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      if (this.callbacks.onRequestExit) {
        this.callbacks.onRequestExit();
      }
    });

    // Hover: pick tile, find unit, fire onLocalUnitHover
    let hoverThrottle = 0;
    canvas.addEventListener('mousemove', (e: MouseEvent) => {
      if (!this.world || !this.active) return;
      const now = performance.now();
      if (now - hoverThrottle < 50) return; // throttle to ~20fps
      hoverThrottle = now;

      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      const grid = this.pickTile(sx, sy);
      if (!grid) {
        if (this.callbacks.onLocalUnitHover) {
          this.callbacks.onLocalUnitHover(null, sx, sy);
        }
        return;
      }

      const gx = Math.floor(grid.x);
      const gy = Math.floor(grid.y);
      const unit = this.findUnitAt(gx, gy);
      if (this.callbacks.onLocalUnitHover) {
        this.callbacks.onLocalUnitHover(unit, sx, sy);
      }
    });
  }

  private _hoveredUnits: LocalUnit[] = [];
  private _hoveredNpcs: LocalNpc[] = [];
  private findUnitAt(gx: number, gy: number): LocalUnit | null {
    // Stored from last render() call
    for (const u of this._hoveredUnits) {
      if (Math.floor(u.gridX) === gx && Math.floor(u.gridY) === gy) return u;
    }
    return null;
  }

  private findNpcAt(gx: number, gy: number): LocalNpc | null {
    for (const n of this._hoveredNpcs) {
      if (Math.floor(n.gridX) === gx && Math.floor(n.gridY) === gy) return n;
    }
    return null;
  }

  /** Store current units/npcs for hit-testing (called from render). */
  setAgentsForPicking(units: LocalUnit[], npcs: LocalNpc[]): void {
    this._hoveredUnits = units;
    this._hoveredNpcs = npcs;
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.tile3D.dispose();
    this.agent3D.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
