// ─── RepoCiv — Local Scene 3D (Three.js isometric local view) ────────────────
// Phase A: renders the existing LocalWorld (rooms, workbenches, walls, agents)
// using Three.js with an OrthographicCamera in isometric view.
// Designed as a drop-in alternative to LocalRenderer (Canvas 2D) — same
// public interface, but WebGL rendering for multi-floor support (Phase B+).

import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  PointLight,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  Material,
  type Object3D,
} from 'three';
import type { LocalNpc, LocalRoom, LocalTile, LocalUnit, LocalWorld, ZoneType } from '../types.ts';

// ─── ADW types (Phase C) ─────────────────────────────────────────────────────
export type AdwNodeType = 'trigger' | 'engineer' | 'agent' | 'code' | 'sandbox' | 'artifact' | 'ship';
export type AdwEdgeKind = 'flow' | 'pass' | 'fail' | 'approve' | 'reject' | 'route';

export interface AdwNode3D {
  id: string;
  type: AdwNodeType;
  label: string;
  x: number; // grid position on floor 2
  y: number;
}

export interface AdwEdge3D {
  id: string;
  source: string;
  target: string;
  kind: AdwEdgeKind;
}

const ADW_NODE_COLORS: Record<AdwNodeType, number> = {
  trigger: 0x4a9e8e,
  engineer: 0xd49b3a,
  agent: 0x6b8fb5,
  code: 0x7a8b9e,
  sandbox: 0xc47a4a,
  artifact: 0xb070b0,
  ship: 0x4a8f4a,
};

const ADW_EDGE_COLORS: Record<AdwEdgeKind, number> = {
  flow: 0x4a8fb5,
  pass: 0x4a8f4a,
  fail: 0xb04a4a,
  approve: 0xd4a830,
  reject: 0xc47a4a,
  route: 0x9a8ab0,
};

// ─── Constants ────────────────────────────────────────────────────────────────

/** Tile size in world units. Matches the 2D renderer's pixel scale. */
const TILE_W = 32;
const TILE_H = 16;
/** Wall height in world units. */
const WALL_H = 20;
/** Floor thickness. */
// const FLOOR_H = 2;
/** Camera isometric angle (degrees from horizontal). */
const ISO_ANGLE = 35.264; // classic 2:1 isometric

// Zone floor colors (matching isoLocalRenderer ISO_FLOOR palette)
const ZONE_COLORS: Record<string, number> = {
  team_cluster: 0x6b8fb5,
  meeting: 0xd49b3a,
  focus: 0x4a8f4a,
  break: 0xc47a4a,
  infra: 0x7a8b9e,
  reception: 0xc4b8a0,
  biophilic: 0x4a9e8e,
  path: 0xb8b8b8,
  outside: 0xa8a8a8,
};

const WALL_COLOR = 0xc8c8c8;
const WORKBENCH_COLOR = 0x8a7a6a;
const CHAIR_COLOR = 0x6a5a4a;

// ─── Callbacks (same shape as LocalRenderer) ──────────────────────────────────
export interface LocalScene3DCallbacks {
  onTileClick: ((x: number, y: number, tile: LocalTile | null, sx: number, sy: number) => void) | null;
  onTileHover: ((x: number, y: number, tile: LocalTile | null) => void) | null;
  onTileDblClick: ((x: number, y: number, tile: LocalTile | null) => void) | null;
  onLocalUnitClick: ((unit: LocalUnit, sx: number, sy: number) => void) | null;
  onWorkbenchClick: ((tile: LocalTile, sx: number, sy: number) => void) | null;
  onLocalUnitHover: ((unit: LocalUnit | null, sx: number, sy: number) => void) | null;
  onNpcClick: ((npc: LocalNpc, sx: number, sy: number) => void) | null;
  onUnitRendered: ((unit: LocalUnit, sx: number, sy: number) => void) | null;
  onExitLocalView: (() => void) | null;
  onZonePainted: ((type: ZoneType, tiles: Array<{ x: number; y: number }>) => void) | null;
  onRequestExit: (() => void) | null;
  onDragAssign: ((unitId: string, workbenchTile: LocalTile) => void) | null;
}

// ─── Camera state ─────────────────────────────────────────────────────────────
interface CamState {
  x: number;
  y: number;
  zoom: number;
  cx: number;
  cy: number;
}

// ─── LocalScene3D ─────────────────────────────────────────────────────────────
export class LocalScene3D {
  private canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  private scene: Scene;
  private camera: OrthographicCamera;
  private cam: CamState = { x: 0, y: 0, zoom: 1, cx: 0, cy: 0 };

  private world: LocalWorld | null = null;
  private localUnits: LocalUnit[] = [];

  // ADW workflow floor (Phase C)
  private adwGroup: Group = new Group();
  private adwNodeMeshes: Map<string, Mesh> = new Map();
  private adwEdgeLines: Mesh[] = [];
  private adwGraph: { nodes: AdwNode3D[]; edges: AdwEdge3D[] } | null = null;
  /** @internal used by picking to resolve ADW node clicks */
  getAdwGraph() { return this.adwGraph; }

  // Scene groups
  private floorGroup: Group;
  private wallGroup: Group;
  private workbenchGroup: Group;
  private agentGroup: Group;

  // Reusable geometry
  private floorGeometry: PlaneGeometry;
  private wallGeometry: BoxGeometry;
  private workbenchGeometry: BoxGeometry;
  private chairGeometry: BoxGeometry;

  // Reusable materials
  private floorMaterial: MeshLambertMaterial;
  private wallMaterial: MeshStandardMaterial;
  private workbenchMaterial: MeshLambertMaterial;
  private chairMaterial: MeshLambertMaterial;

  // Instanced meshes (rebuilt when world changes)
  private floorMesh: InstancedMesh | null = null;
  private wallMesh: InstancedMesh | null = null;
  private workbenchMesh: InstancedMesh | null = null;
  private chairMesh: InstancedMesh | null = null;

  // Agent meshes (one per agent — they animate independently)
  private agentMeshes: Map<string, Mesh> = new Map();

  // Picking
  private raycaster: Raycaster;
  private ndc: Vector2;

  // Multi-floor support (Phase B)
  private currentFloor = 0;
  private floorHeight = 100; // world units between floors
  private floorTweenProgress = 1; // 1 = settled, 0 = just started switching
  private floorTweenFrom = 0;
  private floorTweenTo = 0;

  // Input state
  private inputActive = false;
  private isDragging = false;
  private dragStart: { x: number; y: number } = { x: 0, y: 0 };
  private camStart: { x: number; y: number } = { x: 0, y: 0 };
  private hoveredTile: { x: number; y: number } | null = null;

  // Transition state (fade in/out when entering/exiting local view)
  private transitionProgress = 0;
  private transitionDirection: 'none' | 'enter' | 'exit' = 'none';
  private lastTime = performance.now();

  // World signature for incremental rebuilds
  // private worldSignature = '';

  // Callbacks
  onTileClick: LocalScene3DCallbacks['onTileClick'] = null;
  onTileHover: LocalScene3DCallbacks['onTileHover'] = null;
  onTileDblClick: LocalScene3DCallbacks['onTileDblClick'] = null;
  onLocalUnitClick: LocalScene3DCallbacks['onLocalUnitClick'] = null;
  onWorkbenchClick: LocalScene3DCallbacks['onWorkbenchClick'] = null;
  onLocalUnitHover: LocalScene3DCallbacks['onLocalUnitHover'] = null;
  onNpcClick: LocalScene3DCallbacks['onNpcClick'] = null;
  onUnitRendered: LocalScene3DCallbacks['onUnitRendered'] = null;
  onExitLocalView: LocalScene3DCallbacks['onExitLocalView'] = null;
  onZonePainted: LocalScene3DCallbacks['onZonePainted'] = null;
  onRequestExit: LocalScene3DCallbacks['onRequestExit'] = null;
  onDragAssign: LocalScene3DCallbacks['onDragAssign'] = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || window.innerWidth));
    const h = Math.max(1, Math.round(rect.height || window.innerHeight));

    // WebGL renderer
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(w, h, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = 0x0001; // PCFShadowMap

    // Scene
    this.scene = new Scene();
    this.scene.background = new Color(0x0d0f08);

    // Isometric camera (orthographic)
    this.camera = new OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 5000);
    this.cam.cx = w / 2;
    this.cam.cy = h / 2;
    this.setupIsometricCamera();

    // Lighting — warm Civ V-style afternoon
    this.scene.add(new AmbientLight(0xdacfb6, 0.42));
    this.scene.add(new HemisphereLight(0xb0d8f0, 0x7aaa60, 0.36));
    const dir = new DirectionalLight(0xffe7bd, 1.1);
    dir.position.set(0.5, 1.0, 0.3).normalize().multiplyScalar(500);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -200;
    dir.shadow.camera.right = 200;
    dir.shadow.camera.top = 200;
    dir.shadow.camera.bottom = -200;
    dir.shadow.camera.near = 0.1;
    dir.shadow.camera.far = 1000;
    dir.shadow.camera.updateProjectionMatrix();
    dir.shadow.bias = -0.0005;
    this.scene.add(dir);

    // Groups
    this.floorGroup = new Group();
    this.floorGroup.name = 'floor';
    this.scene.add(this.floorGroup);
    this.wallGroup = new Group();
    this.wallGroup.name = 'walls';
    this.scene.add(this.wallGroup);
    this.workbenchGroup = new Group();
    this.workbenchGroup.name = 'workbenches';
    this.scene.add(this.workbenchGroup);
    this.agentGroup = new Group();
    this.agentGroup.name = 'agents';
    this.scene.add(this.agentGroup);

    // ADW workflow group (Phase C) — positioned at floor 1 height
    this.adwGroup.name = 'adw-workflow';
    this.adwGroup.position.y = this.floorHeight;
    this.scene.add(this.adwGroup);

    // Reusable geometry
    this.floorGeometry = new PlaneGeometry(TILE_W, TILE_H);
    this.wallGeometry = new BoxGeometry(TILE_W, WALL_H, TILE_H);
    this.workbenchGeometry = new BoxGeometry(TILE_W * 0.6, 6, TILE_H * 0.5);
    this.chairGeometry = new BoxGeometry(6, 8, 6);

    // Reusable materials
    this.floorMaterial = new MeshLambertMaterial({ color: 0xb8b8b8 });
    this.wallMaterial = new MeshStandardMaterial({ color: WALL_COLOR });
    this.workbenchMaterial = new MeshLambertMaterial({ color: WORKBENCH_COLOR });
    this.chairMaterial = new MeshLambertMaterial({ color: CHAIR_COLOR });

    // Picking
    this.raycaster = new Raycaster();
    this.ndc = new Vector2();

    this.resize();
  }

  // ─── Isometric camera setup ──────────────────────────────────────────────────
  private setupIsometricCamera() {
    const angle = (ISO_ANGLE * Math.PI) / 180;
    const dist = 800;
    this.camera.position.set(
      dist * Math.cos(angle),
      dist * Math.sin(angle),
      dist * Math.cos(angle),
    );
    this.camera.lookAt(0, 0, 0);
    this.camera.zoom = this.cam.zoom;
    this.camera.updateProjectionMatrix();
  }

  // ─── Public interface (matches LocalRenderer) ────────────────────────────────

  setCleanMode(_mode: boolean): void {
    // No-op for 3D renderer (clean mode is a 2D canvas optimization)
  }

  toggleWorkbenchLabels(): boolean {
    // No-op for 3D renderer (labels rendered differently)
    return false;
  }

  isWorkbenchLabelsVisible(): boolean {
    return false;
  }

  toggleDebugOverlay(): boolean {
    // No-op for 3D renderer
    return false;
  }

  isDebugOverlay(): boolean {
    return false;
  }

  animateCameraToGrid(_x: number, _y: number): void {
    // TODO: tween camera to grid position in 3D
  }

  setWorld(world: LocalWorld): void {
    this.world = world;
    this.rebuildScene();
    // Center camera on world center
    this.cam.x = (world.width * TILE_W) / 2;
    this.cam.y = (world.height * TILE_H) / 2;
    this.updateCamera();
  }

  setupInput(): void {
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.inputActive) return;
      if (e.button !== 0) return;
      this.isDragging = false;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.camStart = { x: this.cam.x, y: this.cam.y };
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.inputActive) return;
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // Camera pan
      if (e.buttons & 1) {
        const dx = (e.clientX - this.dragStart.x) / this.cam.zoom;
        const dy = (e.clientY - this.dragStart.y) / this.cam.zoom;
        this.cam.x = this.camStart.x - dx;
        this.cam.y = this.camStart.y - dy;
        this.updateCamera();
        this.isDragging = true;
        return;
      }

      // Hover picking
      this.pickHover(sx, sy);
    });

    this.canvas.addEventListener('mouseup', (e) => {
      if (!this.inputActive) return;
      if (this.isDragging) {
        this.isDragging = false;
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this.pickClick(sx, sy);
    });

    this.canvas.addEventListener('wheel', (e) => {
      if (!this.inputActive) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.cam.zoom = Math.max(0.3, Math.min(4, this.cam.zoom * delta));
      this.updateCamera();
    });

    this.canvas.addEventListener('dblclick', (e) => {
      if (!this.inputActive) return;
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      this.pickDblClick(sx, sy);
    });

    this.canvas.addEventListener('contextmenu', (e) => {
      if (!this.inputActive) return;
      e.preventDefault();
    });

    // Floor switching (Phase B): PgUp/PgDn
    this.canvas.addEventListener('keydown', (e) => {
      if (!this.inputActive) return;
      if (e.key === 'PageUp') {
        e.preventDefault();
        this.switchFloor(this.currentFloor + 1);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        this.switchFloor(this.currentFloor - 1);
      }
    });
  }

  setInputActive(active: boolean): void {
    this.inputActive = active;
  }

  render(units: LocalUnit[]): void {
    if (!this.world) return;
    this.localUnits = units;

    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Transition animation
    if (this.transitionDirection === 'enter') {
      this.transitionProgress = Math.min(1, this.transitionProgress + dt * 4);
      if (this.transitionProgress >= 1) this.transitionDirection = 'none';
    } else if (this.transitionDirection === 'exit') {
      this.transitionProgress = Math.max(0, this.transitionProgress - dt * 4);
      if (this.transitionProgress <= 0) this.transitionDirection = 'none';
    }

    // Floor tween (Phase B)
    if (this.floorTweenProgress < 1) {
      this.floorTweenProgress = Math.min(1, this.floorTweenProgress + dt * 3);
      this.updateCamera();
    }

    // Update agent positions
    this.updateAgents(units);

    // Render
    this.renderer.render(this.scene, this.camera);

    // Report rendered units for HUD overlay
    for (const unit of units) {
      const screenPos = this.worldToScreen(unit.gridX, unit.gridY);
      this.onUnitRendered?.(unit, screenPos.x, screenPos.y);
    }
  }

  startEnterTransition(): void {
    this.transitionDirection = 'enter';
    this.transitionProgress = 0;
  }

  startExitTransition(): void {
    this.transitionDirection = 'exit';
    this.transitionProgress = 1;
  }

  isTransitionComplete(): boolean {
    return this.transitionDirection === 'none';
  }

  // ─── Scene rebuild ───────────────────────────────────────────────────────────

  private rebuildScene(): void {
    if (!this.world) return;

    // Dispose old instanced meshes
    this.disposeMeshes();

    // Collect floor tiles, wall tiles, workbench tiles
    const floorTiles: { x: number; y: number; color: number }[] = [];
    const wallTiles: { x: number; y: number }[] = [];
    const workbenchTiles: { x: number; y: number; rotation: number }[] = [];
    const chairTiles: { x: number; y: number }[] = [];

    for (let y = 0; y < this.world.height; y++) {
      for (let x = 0; x < this.world.width; x++) {
        const tile = this.world.grid[y]?.[x];
        if (!tile) continue;

        switch (tile.type) {
          case 'floor':
          case 'path':
          case 'aisle': {
            const room = tile.roomId ? this.world.rooms.find((r: LocalRoom) => r.id === tile.roomId) : null;
            const color = room?.zoneType ? ZONE_COLORS[room.zoneType] ?? 0xb8b8b8 : 0xb8b8b8;
            floorTiles.push({ x, y, color });
            break;
          }
          case 'workbench':
          case 'standing_desk': {
            workbenchTiles.push({ x, y, rotation: 0 });
            // Add chair tile in front (facing direction)
            chairTiles.push({ x, y });
            // Also add floor under
            floorTiles.push({ x, y, color: 0x4a8f4a });
            break;
          }
          case 'wall': {
            wallTiles.push({ x, y });
            break;
          }
          case 'door': {
            // Door is a short wall — skip for now, render as floor
            floorTiles.push({ x, y, color: 0xb89860 });
            break;
          }
          case 'chair': {
            chairTiles.push({ x, y });
            floorTiles.push({ x, y, color: 0xb8b8b8 });
            break;
          }
          case 'window': {
            floorTiles.push({ x, y, color: 0x8a9aaa });
            break;
          }
          case 'reception':
          case 'meeting_room':
          case 'break_area':
          case 'phone_booth':
          case 'server_rack':
          case 'sofa':
          case 'watercooler':
          case 'planter':
          case 'whiteboard':
          case 'stairs': {
            // Render as floor with room color
            const room = tile.roomId ? this.world.rooms.find((r) => r.id === tile.roomId) : null;
            const color = room?.zoneType ? ZONE_COLORS[room.zoneType] ?? 0xb8b8b8 : 0xb8b8b8;
            floorTiles.push({ x, y, color });
            break;
          }
          default: {
            // Power/zoning/etc — render as floor
            floorTiles.push({ x, y, color: 0x444444 });
            break;
          }
        }
      }
    }

    // Build floor InstancedMesh
    this.instanceToTile.clear();
    if (floorTiles.length > 0) {
      this.floorMesh = new InstancedMesh(this.floorGeometry, this.floorMaterial.clone(), floorTiles.length);
      this.floorMesh.receiveShadow = true;
      const matrix = new Matrix4();
      for (let i = 0; i < floorTiles.length; i++) {
        const ft = floorTiles[i]!;
        const worldPos = this.tileToWorld(ft.x, ft.y);
        matrix.makeRotationX(-Math.PI / 2);
        matrix.setPosition(worldPos.x, 0, worldPos.z);
        this.floorMesh.setMatrixAt(i, matrix);
        this.floorMesh.setColorAt(i, new Color(ft.color));
        this.instanceToTile.set(i, { x: ft.x, y: ft.y });
      }
      this.floorMesh.instanceMatrix.needsUpdate = true;
      if (this.floorMesh.instanceColor) this.floorMesh.instanceColor.needsUpdate = true;
      this.floorGroup.add(this.floorMesh);
    }

    // Build wall InstancedMesh
    if (wallTiles.length > 0) {
      this.wallMesh = new InstancedMesh(this.wallGeometry, this.wallMaterial.clone(), wallTiles.length);
      this.wallMesh.castShadow = true;
      this.wallMesh.receiveShadow = true;
      const matrix = new Matrix4();
      for (let i = 0; i < wallTiles.length; i++) {
        const wt = wallTiles[i]!;
        const worldPos = this.tileToWorld(wt.x, wt.y);
        matrix.setPosition(worldPos.x, WALL_H / 2, worldPos.z);
        this.wallMesh.setMatrixAt(i, matrix);
      }
      this.wallMesh.instanceMatrix.needsUpdate = true;
      this.wallGroup.add(this.wallMesh);
    }

    // Build workbench InstancedMesh
    if (workbenchTiles.length > 0) {
      this.workbenchMesh = new InstancedMesh(this.workbenchGeometry, this.workbenchMaterial.clone(), workbenchTiles.length);
      this.workbenchMesh.castShadow = true;
      const matrix = new Matrix4();
      for (let i = 0; i < workbenchTiles.length; i++) {
        const wb = workbenchTiles[i]!;
        const worldPos = this.tileToWorld(wb.x, wb.y);
        matrix.setPosition(worldPos.x, 4, worldPos.z);
        this.workbenchMesh.setMatrixAt(i, matrix);
      }
      this.workbenchMesh.instanceMatrix.needsUpdate = true;
      this.workbenchGroup.add(this.workbenchMesh);
    }

    // Build chair InstancedMesh
    if (chairTiles.length > 0) {
      this.chairMesh = new InstancedMesh(this.chairGeometry, this.chairMaterial.clone(), chairTiles.length);
      const matrix = new Matrix4();
      for (let i = 0; i < chairTiles.length; i++) {
        const ct = chairTiles[i]!;
        const worldPos = this.tileToWorld(ct.x, ct.y);
        matrix.setPosition(worldPos.x, 4, worldPos.z);
        this.chairMesh.setMatrixAt(i, matrix);
      }
      this.chairMesh.instanceMatrix.needsUpdate = true;
      this.workbenchGroup.add(this.chairMesh);
    }

    // Add point lights for focus zones (lamps)
    for (const room of this.world.rooms) {
      if (room.zoneType === 'focus') {
        const center = this.tileToWorld(
          room.x + Math.floor(room.width / 2),
          room.y + Math.floor(room.height / 2),
        );
        const lamp = new PointLight(0xffd080, 0.6, 80, 2);
        lamp.position.set(center.x, 30, center.z);
        this.scene.add(lamp);
      }
    }
  }

  private disposeMeshes(): void {
    // Remove old meshes from groups and dispose
    for (const group of [this.floorGroup, this.wallGroup, this.workbenchGroup]) {
      while (group.children.length > 0) {
        const child = group.children[0]!;
        group.remove(child);
        if (child instanceof InstancedMesh) {
          child.geometry.dispose();
          if (child.material instanceof Material) child.material.dispose();
        }
      }
    }
    this.floorMesh = null;
    this.wallMesh = null;
    this.workbenchMesh = null;
    this.chairMesh = null;

    // Clear agent meshes
    while (this.agentGroup.children.length > 0) {
      const child = this.agentGroup.children[0]!;
      this.agentGroup.remove(child);
    }
    this.agentMeshes.clear();

    // Remove old point lights (keep ambient + directional)
    const toRemove: Object3D[] = [];
    this.scene.traverse((obj) => {
      if (obj instanceof PointLight) toRemove.push(obj);
    });
    for (const obj of toRemove) this.scene.remove(obj);
  }

  // ─── Agent rendering ──────────────────────────────────────────────────────────

  private updateAgents(units: LocalUnit[]): void {
    if (!this.world) return;

    for (const unit of units) {
      let mesh = this.agentMeshes.get(unit.id);
      if (!mesh) {
        // Create a simple agent mesh (cylinder body + sphere head)
        mesh = this.createAgentMesh(unit);
        this.agentGroup.add(mesh);
        this.agentMeshes.set(unit.id, mesh);
      }

      // Update position
      const worldPos = this.tileToWorld(unit.gridX, unit.gridY);
      mesh.position.set(worldPos.x, 0, worldPos.z);

      // Update color
      const material = mesh.material as MeshStandardMaterial;
      const targetColor = new Color(unit.color);
      if (!material.color.equals(targetColor)) {
        material.color.copy(targetColor);
      }

      // Scale pulse for idle, flatten for despawning
      if (unit.despawning && unit.fadeAlpha !== undefined) {
        mesh.scale.setScalar(unit.fadeAlpha);
        material.opacity = unit.fadeAlpha;
        material.transparent = true;
      } else {
        mesh.scale.setScalar(1);
        material.opacity = 1;
        material.transparent = false;
      }
    }

    // Remove meshes for units that no longer exist
    const activeIds = new Set(units.map((u) => u.id));
    for (const [id, mesh] of this.agentMeshes) {
      if (!activeIds.has(id)) {
        this.agentGroup.remove(mesh);
        this.agentMeshes.delete(id);
      }
    }
  }

  private createAgentMesh(unit: LocalUnit): Mesh {
    // Simple capsule: cylinder body + sphere head
    const bodyGeom = new BoxGeometry(6, 14, 6);
    const headGeom = new BoxGeometry(5, 5, 5);
    const bodyMat = new MeshStandardMaterial({ color: unit.color });
    const headMat = new MeshStandardMaterial({ color: 0xd0c0a0 });

    const body = new Mesh(bodyGeom, bodyMat);
    body.position.y = 7;
    body.castShadow = true;
    const head = new Mesh(headGeom, headMat);
    head.position.y = 16;
    head.castShadow = true;

    // Use a Group but return as Mesh-compatible
    const mesh = new Mesh(new BoxGeometry(0.01, 0.01, 0.01), bodyMat);
    mesh.visible = false; // The wrapper is invisible — children render
    mesh.add(body);
    mesh.add(head);
    return mesh;
  }

  // ─── Coordinate conversion ──────────────────────────────────────────────────

  private tileToWorld(gridX: number, gridY: number): { x: number; y: number; z: number } {
    // Isometric projection: grid (x,y) → world (x, 0, z)
    // Simple 2:1 iso: worldX = gridX * TILE_W, worldZ = gridY * TILE_H
    return {
      x: gridX * TILE_W,
      y: 0,
      z: gridY * TILE_H,
    };
  }

  private worldToScreen(gridX: number, gridY: number): { x: number; y: number } {
    const world3D = this.tileToWorld(gridX, gridY);
    const v = new Vector3(world3D.x, world3D.y, world3D.z);
    v.project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * this.canvas.width,
      y: (-v.y * 0.5 + 0.5) * this.canvas.height,
    };
  }

  // ─── Floor switching (Phase B) ────────────────────────────────────────────────

  switchFloor(targetFloor: number): void {
    const clamped = Math.max(0, Math.min(1, targetFloor)); // 0=bodega, 1=workflow
    if (clamped === this.currentFloor) return;
    this.floorTweenFrom = this.currentFloor;
    this.floorTweenTo = clamped;
    this.floorTweenProgress = 0;
    this.currentFloor = clamped;
  }

  private getFloorY(): number {
    // Interpolate floor Y position during tween
    if (this.floorTweenProgress >= 1) return this.currentFloor * this.floorHeight;
    const eased = 1 - Math.pow(1 - this.floorTweenProgress, 3); // ease-out cubic
    const fromY = this.floorTweenFrom * this.floorHeight;
    const toY = this.floorTweenTo * this.floorHeight;
    return fromY + (toY - fromY) * eased;
  }

  // ─── Camera ───────────────────────────────────────────────────────────────────

  private updateCamera(): void {
    // Adjust ortho frustum based on zoom and canvas size
    const w = this.canvas.width / this.cam.zoom;
    const h = this.canvas.height / this.cam.zoom;
    this.camera.left = -w / 2;
    this.camera.right = w / 2;
    this.camera.top = h / 2;
    this.camera.bottom = -h / 2;
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();

    // Position camera to look at cam.x, cam.y in world space
    const angle = (ISO_ANGLE * Math.PI) / 180;
    const dist = 800;
    this.camera.position.set(
      this.cam.x + dist * Math.cos(angle),
      dist * Math.sin(angle),
      this.cam.y + dist * Math.cos(angle),
    );
    this.camera.lookAt(this.cam.x, this.getFloorY(), this.cam.y);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || window.innerWidth));
    const h = Math.max(1, Math.round(rect.height || window.innerHeight));
    this.canvas.width = w;
    this.canvas.height = h;
    this.renderer.setSize(w, h, false);
    this.cam.cx = w / 2;
    this.cam.cy = h / 2;
    this.updateCamera();
  }

  // ─── Picking ──────────────────────────────────────────────────────────────────

  private screenToWorldNDC(sx: number, sy: number): Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new Vector2(
      ((sx) / rect.width) * 2 - 1,
      -((sy) / rect.height) * 2 + 1,
    );
  }

  private pickClick(sx: number, sy: number): void {
    if (!this.world) return;
    this.ndc.copy(this.screenToWorldNDC(sx, sy));
    this.raycaster.setFromCamera(this.ndc, this.camera);

    // Try picking floor first
    if (this.floorMesh) {
      const hits = this.raycaster.intersectObject(this.floorMesh);
      if (hits.length > 0) {
        const instanceId = hits[0]!.instanceId;
        if (instanceId !== undefined) {
          const tile = this.resolveTileFromInstance(instanceId);
          if (tile) {
            this.onTileClick?.(tile.x, tile.y, tile, sx, sy);
            return;
          }
        }
      }
    }

    // Try picking agents
    for (const [unitId, mesh] of this.agentMeshes) {
      const hits = this.raycaster.intersectObject(mesh, true);
      if (hits.length > 0) {
        const unit = this.localUnits.find((u) => u.id === unitId);
        if (unit) {
          this.onLocalUnitClick?.(unit, sx, sy);
          return;
        }
      }
    }

    // No hit
    this.onTileClick?.(-1, -1, null, sx, sy);
  }

  private pickHover(sx: number, sy: number): void {
    if (!this.world) return;
    this.ndc.copy(this.screenToWorldNDC(sx, sy));
    this.raycaster.setFromCamera(this.ndc, this.camera);

    if (this.floorMesh) {
      const hits = this.raycaster.intersectObject(this.floorMesh);
      if (hits.length > 0) {
        const instanceId = hits[0]!.instanceId;
        if (instanceId !== undefined) {
          const tile = this.resolveTileFromInstance(instanceId);
          if (tile) {
            this.hoveredTile = { x: tile.x, y: tile.y };
            this.onTileHover?.(tile.x, tile.y, tile);
            return;
          }
        }
      }
    }

    if (this.hoveredTile) {
      this.hoveredTile = null;
      this.onTileHover?.(-1, -1, null);
    }

    // Check agent hover
    for (const [, mesh] of this.agentMeshes) {
      const hits = this.raycaster.intersectObject(mesh, true);
      if (hits.length > 0) {
        // Find unit — simplified for now
        return;
      }
    }
  }

  private pickDblClick(sx: number, sy: number): void {
    if (!this.world) return;
    this.ndc.copy(this.screenToWorldNDC(sx, sy));
    this.raycaster.setFromCamera(this.ndc, this.camera);

    if (this.floorMesh) {
      const hits = this.raycaster.intersectObject(this.floorMesh);
      if (hits.length > 0) {
        const instanceId = hits[0]!.instanceId;
        if (instanceId !== undefined) {
          const tile = this.resolveTileFromInstance(instanceId);
          if (tile) {
            this.onTileDblClick?.(tile.x, tile.y, tile);
            return;
          }
        }
      }
    }
    this.onTileDblClick?.(-1, -1, null);
  }

  // ─── Instance → tile resolution ───────────────────────────────────────────────
  // We store a mapping from instance index to grid (x,y) during rebuild.
  private instanceToTile: Map<number, { x: number; y: number }> = new Map();

  private resolveTileFromInstance(instanceId: number): LocalTile | null {
    if (!this.world) return null;
    const pos = this.instanceToTile.get(instanceId);
    if (!pos) return null;
    return this.world.grid[pos.y]?.[pos.x] ?? null;
  }

  // ─── ADW workflow rendering (Phase C) ─────────────────────────────────────────

  /** Phase D: set a node's runtime state (idle/running/pass/fail) and animate */
  setAdwNodeState(nodeId: string, state: 'idle' | 'running' | 'pass' | 'fail'): void {
    const mesh = this.adwNodeMeshes.get(nodeId);
    if (!mesh) return;
    const material = mesh.material as MeshStandardMaterial;
    const baseColor = ADW_NODE_COLORS[(mesh.userData['adwNodeType'] as AdwNodeType) ?? 'code'] ?? 0x888888;

    switch (state) {
      case 'idle':
        material.emissiveIntensity = 0.15;
        material.emissive.setHex(baseColor);
        break;
      case 'running':
        material.emissiveIntensity = 0.4;
        material.emissive.setHex(0x4a8fb5);
        break;
      case 'pass':
        material.emissiveIntensity = 0.6;
        material.emissive.setHex(0x4a8f4a);
        break;
      case 'fail':
        material.emissiveIntensity = 0.6;
        material.emissive.setHex(0xb04a4a);
        break;
    }
  }

  /** Phase D: spawn an artifact sprite that travels from source to target node */
  spawnAdwArtifact(
    fromNodeId: string,
    toNodeId: string,
    onComplete?: () => void,
  ): void {
    const sourceMesh = this.adwNodeMeshes.get(fromNodeId);
    const targetMesh = this.adwNodeMeshes.get(toNodeId);
    if (!sourceMesh || !targetMesh) return;

    // Create a small plane mesh as the "papel/document"
    const geom = new PlaneGeometry(4, 5);
    const mat = new MeshStandardMaterial({
      color: 0xfff5e0,
      emissive: 0xffd080,
      emissiveIntensity: 0.3,
      side: 2, // DoubleSide
    });
    const artifact = new Mesh(geom, mat);
    artifact.position.copy(sourceMesh.position);
    this.adwGroup.add(artifact);

    // Tween to target over ~1.5s
    const startTime = performance.now();
    const duration = 1500;
    const startPos = sourceMesh.position.clone();
    const endPos = targetMesh.position.clone();

    const tick = () => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - t, 2); // ease-out quad

      artifact.position.lerpVectors(startPos, endPos, eased);

      // Add a slight arc (parabola)
      const arcHeight = 15;
      artifact.position.y += Math.sin(t * Math.PI) * arcHeight;

      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        this.adwGroup.remove(artifact);
        geom.dispose();
        mat.dispose();
        onComplete?.();
      }
    };
    requestAnimationFrame(tick);
  }

  loadAdwGraph(nodes: AdwNode3D[], edges: AdwEdge3D[]): void {
    // Clear old ADW meshes
    while (this.adwGroup.children.length > 0) {
      const child = this.adwGroup.children[0]!;
      this.adwGroup.remove(child);
    }
    this.adwNodeMeshes.clear();
    this.adwEdgeLines = [];

    this.adwGraph = { nodes, edges };

    // Render nodes as meshes by type
    for (const node of nodes) {
      const mesh = this.createAdwNodeMesh(node);
      this.adwGroup.add(mesh);
      this.adwNodeMeshes.set(node.id, mesh);
    }

    // Render edges as line segments
    for (const edge of edges) {
      const sourceMesh = this.adwNodeMeshes.get(edge.source);
      const targetMesh = this.adwNodeMeshes.get(edge.target);
      if (!sourceMesh || !targetMesh) continue;

      const sourcePos = sourceMesh.position;
      const targetPos = targetMesh.position;

      // Simple line geometry (straight for now; curves in Phase D)
      const points = new Float32Array([
        sourcePos.x, sourcePos.y, sourcePos.z,
        targetPos.x, targetPos.y, targetPos.z,
      ]);
      const geom = new BufferGeometry();
      geom.setAttribute('position', new Float32BufferAttribute(points, 3));
      const mat = new LineBasicMaterial({ color: ADW_EDGE_COLORS[edge.kind] ?? 0x888888 });
      const line = new LineSegments(geom, mat);
      this.adwGroup.add(line);
      this.adwEdgeLines.push(line as unknown as Mesh);
    }
  }

  private createAdwNodeMesh(node: AdwNode3D): Mesh {
    const color = ADW_NODE_COLORS[node.type] ?? 0x888888;
    const material = new MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.15,
    });

    // Different geometry per node type
    let geometry: BufferGeometry;
    switch (node.type) {
      case 'trigger':
        geometry = new ConeGeometry(8, 12, 3);
        break;
      case 'engineer':
        geometry = new BoxGeometry(12, 14, 12);
        break;
      case 'agent':
        geometry = new SphereGeometry(8, 16, 12);
        break;
      case 'code':
        geometry = new BoxGeometry(10, 10, 10);
        break;
      case 'sandbox':
        geometry = new BoxGeometry(16, 8, 16);
        break;
      case 'artifact':
        geometry = new PlaneGeometry(12, 12);
        break;
      case 'ship':
        geometry = new CylinderGeometry(6, 8, 12, 8);
        break;
      default:
        geometry = new BoxGeometry(10, 10, 10);
    }

    const mesh = new Mesh(geometry, material);
    mesh.position.set(node.x * TILE_W, 0, node.y * TILE_H);
    mesh.castShadow = true;
    mesh.userData = { adwNodeId: node.id, adwNodeType: node.type, adwLabel: node.label };
    return mesh;
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────────
  dispose(): void {
    this.disposeMeshes();
    this.renderer.dispose();
    this.floorGeometry.dispose();
    this.wallGeometry.dispose();
    this.workbenchGeometry.dispose();
    this.chairGeometry.dispose();
  }
}