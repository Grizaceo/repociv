// ─── RepoCiv — Local Scene 3D (Three.js isometric local view) ────────────────
// Modular refactor: delegates to LocalCamera3D, LocalTile3D, LocalAgent3D,
// LocalPicker3D. Uses exact ISO constants for pixel-perfect parity with 2D.
// Implements the same public interface as LocalRenderer (Canvas 2D).

import {
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
  BufferGeometry,
  ConeGeometry,
  BoxGeometry,
  SphereGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
} from 'three';
import type { LocalNpc, LocalTile, LocalUnit, LocalWorld, ZoneType } from '../types.ts';
import { LocalCamera3D, type LocalCamState, localGridToWorld3D } from './LocalCamera3D.ts';
import { LocalTile3D } from './LocalTile3D.ts';
import { LocalAgent3D } from './LocalAgent3D.ts';
import { LocalPicker3D } from './LocalPicker3D.ts';

// ─── ADW types (Phase C) ─────────────────────────────────────────────────────
export type AdwNodeType = 'trigger' | 'engineer' | 'agent' | 'code' | 'sandbox' | 'artifact' | 'ship';
export type AdwEdgeKind = 'flow' | 'pass' | 'fail' | 'approve' | 'reject' | 'route';

export interface AdwNode3D {
  id: string;
  type: AdwNodeType;
  label: string;
  x: number;
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

// ─── Callbacks ────────────────────────────────────────────────────────────────
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

// ─── LocalScene3D (orchestrator) ──────────────────────────────────────────────
export class LocalScene3D {
  private canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  private scene: Scene;
  private cam3d: LocalCamera3D;
  private cam: LocalCamState = { x: 0, y: 0, zoom: 1, cx: 0, cy: 0 };

  private world: LocalWorld | null = null;
  private localUnits: LocalUnit[] = [];

  // Modules
  private tile3D: LocalTile3D;
  private agent3D: LocalAgent3D;
  private picker: LocalPicker3D;

  // ADW workflow (Phase C/D)
  private adwGroup: Group = new Group();
  private adwNodeMeshes: Map<string, Mesh> = new Map();
  private adwEdgeLines: Mesh[] = [];
  private adwGraph: { nodes: AdwNode3D[]; edges: AdwEdge3D[] } | null = null;

  // Multi-floor (Phase B)
  private currentFloor = 0;
  private floorHeight = 100;
  private floorTweenProgress = 1;
  private floorTweenFrom = 0;
  private floorTweenTo = 0;

  // Input state
  private inputActive = false;
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private camStart = { x: 0, y: 0 };

  // Transition state
  private transitionProgress = 0;
  private transitionDirection: 'none' | 'enter' | 'exit' = 'none';
  private lastTime = performance.now();

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

    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(w, h, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = 0x0001;

    this.scene = new Scene();
    this.scene.background = new Color(0x0d0f08);

    this.cam3d = new LocalCamera3D(w, h);
    this.cam.cx = w / 2;
    this.cam.cy = h / 2;

    // Lighting
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

    // Modules
    this.tile3D = new LocalTile3D();
    this.scene.add(this.tile3D.getGroup());
    this.agent3D = new LocalAgent3D();
    this.scene.add(this.agent3D.getGroup());
    this.picker = new LocalPicker3D();

    // ADW group at floor 1
    this.adwGroup.name = 'adw-workflow';
    this.adwGroup.position.y = this.floorHeight;
    this.scene.add(this.adwGroup);

    this.resize();
  }

  // ─── Public interface ─────────────────────────────────────────────────────────

  setCleanMode(_mode: boolean): void {}
  toggleWorkbenchLabels(): boolean { return false; }
  isWorkbenchLabelsVisible(): boolean { return false; }
  toggleDebugOverlay(): boolean { return false; }
  isDebugOverlay(): boolean { return false; }
  animateCameraToGrid(_x: number, _y: number): void {}

  setWorld(world: LocalWorld): void {
    this.world = world;
    this.tile3D.rebuild(world);
    this.cam.x = (world.width * 32) / 2;
    this.cam.y = (world.height * 16) / 2;
    this.syncCamera();
  }

  setupInput(): void {
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.inputActive || e.button !== 0) return;
      this.isDragging = false;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.camStart = { x: this.cam.x, y: this.cam.y };
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.inputActive) return;
      const rect = this.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (e.buttons & 1) {
        const dx = (e.clientX - this.dragStart.x) / this.cam.zoom;
        const dy = (e.clientY - this.dragStart.y) / this.cam.zoom;
        this.cam.x = this.camStart.x - dx;
        this.cam.y = this.camStart.y - dy;
        this.syncCamera();
        this.isDragging = true;
        return;
      }
      this.pickHover(sx, sy);
    });

    this.canvas.addEventListener('mouseup', (e) => {
      if (!this.inputActive) return;
      if (this.isDragging) { this.isDragging = false; return; }
      const rect = this.canvas.getBoundingClientRect();
      this.pickClick(e.clientX - rect.left, e.clientY - rect.top);
    });

    this.canvas.addEventListener('wheel', (e) => {
      if (!this.inputActive) return;
      e.preventDefault();
      this.cam.zoom = Math.max(0.3, Math.min(4, this.cam.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      this.syncCamera();
    });

    this.canvas.addEventListener('dblclick', (e) => {
      if (!this.inputActive) return;
      const rect = this.canvas.getBoundingClientRect();
      this.pickDblClick(e.clientX - rect.left, e.clientY - rect.top);
    });

    this.canvas.addEventListener('contextmenu', (e) => {
      if (this.inputActive) e.preventDefault();
    });

    this.canvas.addEventListener('keydown', (e) => {
      if (!this.inputActive) return;
      if (e.key === 'PageUp') { e.preventDefault(); this.switchFloor(this.currentFloor + 1); }
      else if (e.key === 'PageDown') { e.preventDefault(); this.switchFloor(this.currentFloor - 1); }
    });
  }

  setInputActive(active: boolean): void { this.inputActive = active; }

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

    // Floor tween
    if (this.floorTweenProgress < 1) {
      this.floorTweenProgress = Math.min(1, this.floorTweenProgress + dt * 3);
      this.syncCamera();
    }

    // Update agents
    this.agent3D.update(units);

    // Render
    this.renderer.render(this.scene, this.cam3d.getCamera());

    // Report units for HUD
    for (const unit of units) {
      const wp = localGridToWorld3D(unit.gridX, unit.gridY);
      const v = new Vector3(wp.x, wp.y, wp.z);
      v.project(this.cam3d.getCamera());
      const sx = (v.x * 0.5 + 0.5) * this.canvas.width;
      const sy = (-v.y * 0.5 + 0.5) * this.canvas.height;
      this.onUnitRendered?.(unit, sx, sy);
    }
  }

  startEnterTransition(): void { this.transitionDirection = 'enter'; this.transitionProgress = 0; }
  startExitTransition(): void { this.transitionDirection = 'exit'; this.transitionProgress = 1; }
  isTransitionComplete(): boolean { return this.transitionDirection === 'none'; }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width || window.innerWidth));
    const h = Math.max(1, Math.round(rect.height || window.innerHeight));
    this.canvas.width = w;
    this.canvas.height = h;
    this.renderer.setSize(w, h, false);
    this.cam.cx = w / 2;
    this.cam.cy = h / 2;
    this.cam3d.resize(w, h);
    this.syncCamera();
  }

  // ─── Floor switching (Phase B) ────────────────────────────────────────────────

  switchFloor(targetFloor: number): void {
    const clamped = Math.max(0, Math.min(1, targetFloor));
    if (clamped === this.currentFloor) return;
    this.floorTweenFrom = this.currentFloor;
    this.floorTweenTo = clamped;
    this.floorTweenProgress = 0;
    this.currentFloor = clamped;
  }

  getAdwGraph() { return this.adwGraph; }

  // ─── ADW (Phase C/D) ─────────────────────────────────────────────────────────

  setAdwNodeState(nodeId: string, state: 'idle' | 'running' | 'pass' | 'fail'): void {
    const mesh = this.adwNodeMeshes.get(nodeId);
    if (!mesh) return;
    const mat = mesh.material as MeshStandardMaterial;
    const baseColor = ADW_NODE_COLORS[(mesh.userData['adwNodeType'] as AdwNodeType) ?? 'code'] ?? 0x888888;
    switch (state) {
      case 'idle': mat.emissiveIntensity = 0.15; mat.emissive.setHex(baseColor); break;
      case 'running': mat.emissiveIntensity = 0.4; mat.emissive.setHex(0x4a8fb5); break;
      case 'pass': mat.emissiveIntensity = 0.6; mat.emissive.setHex(0x4a8f4a); break;
      case 'fail': mat.emissiveIntensity = 0.6; mat.emissive.setHex(0xb04a4a); break;
    }
  }

  spawnAdwArtifact(fromNodeId: string, toNodeId: string, onComplete?: () => void): void {
    const src = this.adwNodeMeshes.get(fromNodeId);
    const tgt = this.adwNodeMeshes.get(toNodeId);
    if (!src || !tgt) return;
    const geom = new PlaneGeometry(4, 5);
    const mat = new MeshStandardMaterial({ color: 0xfff5e0, emissive: 0xffd080, emissiveIntensity: 0.3, side: 2 });
    const artifact = new Mesh(geom, mat);
    artifact.position.copy(src.position);
    this.adwGroup.add(artifact);
    const start = src.position.clone();
    const end = tgt.position.clone();
    const t0 = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - t0) / 1500);
      const eased = 1 - Math.pow(1 - t, 2);
      artifact.position.lerpVectors(start, end, eased);
      artifact.position.y += Math.sin(t * Math.PI) * 15;
      if (t < 1) requestAnimationFrame(tick);
      else { this.adwGroup.remove(artifact); geom.dispose(); mat.dispose(); onComplete?.(); }
    };
    requestAnimationFrame(tick);
  }

  loadAdwGraph(nodes: AdwNode3D[], edges: AdwEdge3D[]): void {
    while (this.adwGroup.children.length > 0) {
      this.adwGroup.remove(this.adwGroup.children[0]!);
    }
    this.adwNodeMeshes.clear();
    this.adwEdgeLines = [];
    this.adwGraph = { nodes, edges };

    for (const node of nodes) {
      const mesh = this.createAdwNodeMesh(node);
      this.adwGroup.add(mesh);
      this.adwNodeMeshes.set(node.id, mesh);
    }

    for (const edge of edges) {
      const src = this.adwNodeMeshes.get(edge.source);
      const tgt = this.adwNodeMeshes.get(edge.target);
      if (!src || !tgt) continue;
      const pts = new Float32Array([src.position.x, src.position.y, src.position.z, tgt.position.x, tgt.position.y, tgt.position.z]);
      const geom = new BufferGeometry();
      geom.setAttribute('position', new Float32BufferAttribute(pts, 3));
      const mat = new LineBasicMaterial({ color: ADW_EDGE_COLORS[edge.kind] ?? 0x888888 });
      const line = new LineSegments(geom, mat);
      this.adwGroup.add(line);
      this.adwEdgeLines.push(line as unknown as Mesh);
    }
  }

  private createAdwNodeMesh(node: AdwNode3D): Mesh {
    const color = ADW_NODE_COLORS[node.type] ?? 0x888888;
    const mat = new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.15 });
    let geometry: BufferGeometry;
    switch (node.type) {
      case 'trigger': geometry = new ConeGeometry(8, 12, 3); break;
      case 'engineer': geometry = new BoxGeometry(12, 14, 12); break;
      case 'agent': geometry = new SphereGeometry(8, 16, 12); break;
      case 'code': geometry = new BoxGeometry(10, 10, 10); break;
      case 'sandbox': geometry = new BoxGeometry(16, 8, 16); break;
      case 'artifact': geometry = new PlaneGeometry(12, 12); break;
      case 'ship': geometry = new CylinderGeometry(6, 8, 12, 8); break;
      default: geometry = new BoxGeometry(10, 10, 10);
    }
    const mesh = new Mesh(geometry, mat);
    const wp = localGridToWorld3D(node.x, node.y);
    mesh.position.set(wp.x, 0, wp.z);
    mesh.castShadow = true;
    mesh.userData = { adwNodeId: node.id, adwNodeType: node.type, adwLabel: node.label };
    return mesh;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  private syncCamera(): void {
    const floorY = this.getFloorY();
    this.cam3d.syncCamera({ ...this.cam, y: this.cam.y + floorY });
  }

  private getFloorY(): number {
    if (this.floorTweenProgress >= 1) return this.currentFloor * this.floorHeight;
    const eased = 1 - Math.pow(1 - this.floorTweenProgress, 3);
    return (this.floorTweenFrom + (this.floorTweenTo - this.floorTweenFrom) * eased) * this.floorHeight;
  }

  private pickClick(sx: number, sy: number): void {
    if (!this.world) return;
    const result = this.picker.pick(sx, sy, this.canvas.width, this.canvas.height, this.cam3d.getCamera(), this.tile3D, this.agent3D, this.world, this.localUnits);
    if (result.unit) {
      this.onLocalUnitClick?.(result.unit, sx, sy);
    } else if (result.tile) {
      this.onTileClick?.(result.tileX, result.tileY, result.tile, sx, sy);
    } else {
      this.onTileClick?.(-1, -1, null, sx, sy);
    }
  }

  private pickHover(sx: number, sy: number): void {
    if (!this.world) return;
    const result = this.picker.pickHover(sx, sy, this.canvas.width, this.canvas.height, this.cam3d.getCamera(), this.tile3D, this.world);
    if (result) {
      this.onTileHover?.(result.x, result.y, result.tile);
    } else {
      this.onTileHover?.(-1, -1, null);
    }
  }

  private pickDblClick(sx: number, sy: number): void {
    if (!this.world) return;
    const result = this.picker.pick(sx, sy, this.canvas.width, this.canvas.height, this.cam3d.getCamera(), this.tile3D, this.agent3D, this.world, this.localUnits);
    if (result.tile) {
      this.onTileDblClick?.(result.tileX, result.tileY, result.tile);
    } else {
      this.onTileDblClick?.(-1, -1, null);
    }
  }

  dispose(): void {
    this.tile3D.dispose();
    this.agent3D.dispose();
    this.renderer.dispose();
  }
}