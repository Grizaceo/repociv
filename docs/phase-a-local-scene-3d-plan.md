# Phase A: Three.js Local View Renderer — Implementation Plan

## Goal

Create `LocalScene3D.ts` that renders the existing `LocalWorld` (rooms, workbenches, walls, agents) using Three.js with an `OrthographicCamera` in isometric view, achieving visual parity with the current Canvas 2D iso renderer (`isoLocalRenderer.ts`). Wire it into `renderer.ts` as the local view when `worldRenderMode === 'webgl'`.

---

## Architecture Overview

### Current State

```
renderer.ts (1952 lines)
  ├── macro view: ThreeMapRenderer → HexWorldScene (PerspectiveCamera, 3D hex grid)
  └── local view: LocalRenderer (Canvas 2D, isoLocalRenderer.ts 1660 lines)
        ├── isoOfficeSprites.ts (ISO_TILE_W=64, ISO_TILE_H=32, ISO_WALL_H=24)
        ├── isoProject(x, y, z) → { px: ((x-y)*32), py: ((x+y)*16) - z*24 }
        └── drawIsoTile, renderIso, drawIsoWorkbenchCluster, etc.
```

### Target State

```
renderer.ts (modified)
  ├── macro view: ThreeMapRenderer → HexWorldScene (unchanged)
  └── local view:
        ├── worldRenderMode === 'flat': LocalRenderer (Canvas 2D, unchanged)
        └── worldRenderMode === 'webgl': LocalScene3D (NEW, Three.js OrthographicCamera)
              ├── LocalScene3D.ts (NEW — main class)
              ├── LocalTile3D.ts (NEW — floor/wall/workbench InstancedMesh)
              ├── LocalAgent3D.ts (NEW — reuse UnitMesh3D GLB figurines)
              ├── LocalCamera3D.ts (NEW — OrthographicCamera iso setup)
              └── LocalPicker3D.ts (NEW — raycast picking on local grid)
```

### Coordinate Systems

The local view uses a **rectangular grid** (not hex axial). The 2D iso renderer maps grid (x, y) to screen via:

```typescript
// isoOfficeSprites.ts (lines 6-16)
ISO_TILE_W = 64;  // diamond width
ISO_TILE_H = 32;  // diamond height
ISO_WALL_H = 24;  // wall elevation

isoProject(x, y, z=0) → {
  px: ((x - y) * ISO_TILE_W) / 2,   // = (x - y) * 32
  py: ((x + y) * ISO_TILE_H) / 2 - z * ISO_WALL_H  // = (x + y) * 16 - z*24
}
```

For Three.js, we map grid (x, y) to 3D world (X, Y, Z):
- **X** = `(x - y) * (ISO_TILE_W / 2)` — preserves the iso horizontal axis
- **Z** = `(x + y) * (ISO_TILE_H / 2)` — preserves the iso depth axis
- **Y** = `z * ISO_WALL_H` — elevation (walls, multi-height props)

This keeps the 2D pixel coordinates numerically identical to 3D XZ, so the OrthographicCamera with a 30° tilt reproduces the iso projection exactly.

---

## Task 1: Create `src/three/LocalCamera3D.ts` — OrthographicCamera Setup

**File:** `src/three/LocalCamera3D.ts` (NEW)

**Purpose:** Isometric camera for the local view. Orthographic (no perspective distortion) with a fixed angle matching the 2D iso projection: looking down the X+Z diagonal at ~30° from horizontal.

### Interface

```typescript
import { OrthographicCamera, Vector3 } from 'three';

// Constants matching the 2D iso projection
const ISO_TILE_W = 64;
const ISO_TILE_H = 32;
const ISO_WALL_H = 24;

// Camera angle: the 2D iso projection has a 2:1 diamond (64:32),
// which corresponds to atan(1/2) ≈ 26.57° elevation. We use 30° as a
// close approximation that looks better in 3D without breaking parity.
const CAMERA_ELEVATION = Math.atan(ISO_TILE_H / ISO_TILE_W); // ≈ 26.57°
const CAMERA_AZIMUTH = Math.PI / 4; // 45° — looking down the X+Z diagonal

export interface LocalCamState {
  x: number;      // pan target X (world units)
  y: number;      // pan target Z (world units, mapped from 2D cam.y)
  zoom: number;   // zoom multiplier (1 = 1:1 with 2D)
  cx: number;     // canvas center X (pixels)
  cy: number;     // canvas center Y (pixels)
}

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
    const halfW = (this.width / 2) / cam.zoom;
    const halfH = (this.height / 2) / cam.zoom;
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

/** Convert a local grid (x, y, z) to 3D world coordinates. */
export function localGridToWorld3D(x: number, y: number, z: number = 0): Vector3 {
  return new Vector3(
    (x - y) * (ISO_TILE_W / 2),
    z * ISO_WALL_H,
    (x + y) * (ISO_TILE_H / 2),
  );
}

/** Inverse: 3D world XZ → grid (x, y) fractional. */
export function world3DToLocalGrid(wx: number, wz: number): { x: number; y: number } {
  // Invert: wx = (x - y) * 32, wz = (x + y) * 16
  // → x = wx/32 + wz/16) / 2, y = wz/16 - wx/32) / 2
  const a = wx / (ISO_TILE_W / 2);
  const b = wz / (ISO_TILE_H / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}
```

**Verification:** `npx vitest run src/three/LocalCamera3D.test.ts`

---

## Task 2: Create `src/three/LocalTile3D.ts` — Floor/Wall/Workbench InstancedMesh

**File:** `src/three/LocalTile3D.ts` (NEW)

**Purpose:** Render all static local tiles (floors, walls, doors, workbenches) as Three.js `InstancedMesh` objects. This mirrors the `CityCluster3D.ts` pattern (one InstancedMesh per tile type, rebuilt on a dirty signature).

### Tile Mapping Strategy

Each `LocalTileType` maps to a specific 3D geometry:

| Tile Type       | Geometry                      | Material                    | Height (Y)    |
|-----------------|-------------------------------|-----------------------------|---------------|
| `floor`         | BoxGeometry(ISO_TILE_W, 2, ISO_TILE_W) | MeshStandardMaterial (zone color) | 0             |
| `path`          | BoxGeometry(ISO_TILE_W, 2, ISO_TILE_W) | MeshStandardMaterial (#B8B8B8)     | 0             |
| `aisle`         | BoxGeometry(ISO_TILE_W, 2, ISO_TILE_W) | MeshStandardMaterial (#B8B8B8)     | 0             |
| `wall`          | BoxGeometry(ISO_TILE_W, ISO_WALL_H*2, ISO_TILE_W) | MeshStandardMaterial (#C8C8C8) | ISO_WALL_H |
| `door`          | BoxGeometry(ISO_TILE_W*0.8, ISO_WALL_H*1.5, ISO_TILE_W*0.3) | MeshStandardMaterial (#B89860) | ISO_WALL_H*0.75 |
| `window`        | BoxGeometry(ISO_TILE_W, ISO_WALL_H*2, ISO_TILE_W) — transparent | MeshStandardMaterial (glass) | ISO_WALL_H |
| `workbench`     | BoxGeometry(ISO_TILE_W*0.7, 8, ISO_TILE_W*0.7) | MeshStandardMaterial (ext color) | 4 |
| `chair`          | BoxGeometry(20, 6, 20)       | MeshStandardMaterial (#8B6B4A)     | 3             |
| `cubicle_partition` | BoxGeometry(ISO_TILE_W, ISO_WALL_H*0.5, 4) | MeshStandardMaterial (#A8B0C0) | ISO_WALL_H*0.25 |
| `planter`       | CylinderGeometry(16, 20, 24) | MeshStandardMaterial (#4A9E8E)     | 12            |
| `whiteboard`    | BoxGeometry(ISO_TILE_W*0.8, 20, 4) | MeshStandardMaterial (#F0F0F0) | 10            |
| `server_rack`   | BoxGeometry(24, 40, 24)      | MeshStandardMaterial (#7A8B9E)      | 20            |
| `sofa`          | BoxGeometry(40, 12, 20)      | MeshStandardMaterial (#C47A4A)      | 6             |
| `meeting_room`  | BoxGeometry(ISO_TILE_W, 6, ISO_TILE_W) — table | MeshStandardMaterial (#D49B3A) | 3 |
| `phone_booth`   | BoxGeometry(20, ISO_WALL_H*1.5, 20) | MeshStandardMaterial (#4A8F4A) | ISO_WALL_H*0.75 |
| `break_area`    | BoxGeometry(40, 12, 40)      | MeshStandardMaterial (#C47A4A)      | 6             |
| `reception`     | BoxGeometry(ISO_TILE_W*0.8, 12, ISO_TILE_W*0.5) | MeshStandardMaterial (#C4B8A0) | 6 |
| `stairs`        | custom step geometry          | MeshStandardMaterial (#B0B0B0)     | 0             |
| `watercooler`   | CylinderGeometry(8, 10, 20)  | MeshStandardMaterial (#5BA3D0)      | 10            |
| `standing_desk` | BoxGeometry(28, 16, 20)      | MeshStandardMaterial (#8B7355)      | 8             |

### Interface

```typescript
import {
  BoxGeometry, CylinderGeometry, InstancedMesh, Matrix4,
  MeshStandardMaterial, Group, Vector3, Quaternion, Color,
  type BufferGeometry, type Material,
} from 'three';
import type { LocalWorld, LocalTile, LocalTileType } from '../types.ts';
import { localGridToWorld3D, ISO_TILE_W, ISO_TILE_H, ISO_WALL_H } from './LocalCamera3D.ts';

// Zone floor colors (matching isoLocalRenderer.ts ISO_FLOOR map)
const ZONE_FLOOR_COLORS: Record<string, number> = {
  team_cluster: 0x6B8FB5,
  meeting: 0xD49B3A,
  focus: 0x4A8F4A,
  break: 0xC47A4A,
  infra: 0x7A8B9E,
  reception: 0xC4B8A0,
  biophilic: 0x4A9E8E,
  path: 0xB8B8B8,
  outside: 0xA8A8A8,
};

// Extension → color map (matching isoLocalRenderer.ts ext color system)
const EXT_COLORS: Record<string, number> = {
  ts: 0x4A8FB5, tsx: 0x4A8FB5, js: 0xD4B04A, jsx: 0xD4B04A,
  py: 0x4A9E5A, go: 0x4AB8C4, rs: 0xC45A4A, java: 0xB06A2A,
  md: 0x8A8A8A, json: 0x9A9A6A, yaml: 0x9A9A6A, yml: 0x9A9A6A,
  css: 0xC47AC4, html: 0xC44A4A, sh: 0x4A8F4A,
};

export interface LocalTile3DOptions {
  workbenchLabelOverlay: boolean;
  powerOverlay: boolean;
  temperatureOverlay: boolean;
}

const _matrix = new Matrix4();
const _pos = new Vector3();
const _q = new Quaternion();
const _scale = new Vector3(1, 1, 1);

/** Builds and manages all InstancedMesh groups for the local view tiles. */
export class LocalTile3D {
  private group: Group;
  private floorMesh: InstancedMesh | null = null;
  private wallMesh: InstancedMesh | null = null;
  private workbenchMesh: InstancedMesh | null = null;
  private doorMesh: InstancedMesh | null = null;
  private furnitureMesh: InstancedMesh | null = null;
  private lastSignature = '';

  // Geometry cache (shared, disposed on dispose())
  private geometries: BufferGeometry[] = [];
  private materials: Material[] = [];

  constructor() {
    this.group = new Group();
    this.group.name = 'local-tiles';
  }

  getGroup(): Group {
    return this.group;
  }

  /** Rebuild all InstancedMeshes if the world signature changed.
   *  Returns true if a rebuild happened, false if cached. */
  rebuild(world: LocalWorld, opts: LocalTile3DOptions): boolean {
    const sig = this.computeSignature(world, opts);
    if (sig === this.lastSignature) return false;
    this.lastSignature = sig;

    this.disposeMeshes();
    this.buildFloorMesh(world);
    this.buildWallMesh(world);
    this.buildWorkbenchMesh(world, opts);
    this.buildDoorMesh(world);
    this.buildFurnitureMesh(world);

    return true;
  }

  private computeSignature(world: LocalWorld, opts: LocalTile3DOptions): string {
    // Hash grid dimensions, room count, workbench count, tile types, and overlay flags
    let tileHash = 0;
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (tile) tileHash = (tileHash * 31 + tile.type.charCodeAt(0)) | 0;
      }
    }
    return [
      world.width, world.height, world.rooms.length,
      world.workbenches.length, tileHash,
      opts.workbenchLabelOverlay ? 1 : 0,
      opts.powerOverlay ? 1 : 0,
    ].join('#');
  }

  private buildFloorMesh(world: LocalWorld): void {
    // Collect all floor/path/aisle tiles
    const floorTiles: Array<{ x: number; y: number; color: number }> = [];
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (!tile) continue;
        if (tile.type !== 'floor' && tile.type !== 'path' && tile.type !== 'aisle') continue;
        // Determine zone color from room
        const room = tile.roomId ? world.rooms.find(r => r.id === tile.roomId) : null;
        const zoneType = room?.zoneType ?? 'path';
        const color = ZONE_FLOOR_COLORS[zoneType] ?? 0xB8B8B8;
        floorTiles.push({ x, y, color });
      }
    }
    if (floorTiles.length === 0) return;

    // Use a single flat box geometry; instance color per-tile via instanceColor
    const geom = new BoxGeometry(ISO_TILE_W, 2, ISO_TILE_W);
    const mat = new MeshStandardMaterial({ vertexColors: false, roughness: 0.85 });
    this.geometries.push(geom);
    this.materials.push(mat);

    this.floorMesh = new InstancedMesh(geom, mat, floorTiles.length);
    this.floorMesh.receiveShadow = true;
    this.floorMesh.castShadow = false;

    const color = new Color();
    for (let i = 0; i < floorTiles.length; i++) {
      const { x, y, color: c } = floorTiles[i];
      _pos.copy(localGridToWorld3D(x, y, 0));
      _pos.y = 0; // floor at ground
      _q.identity();
      _matrix.compose(_pos, _q, _scale);
      this.floorMesh.setMatrixAt(i, _matrix);
      color.setHex(c);
      this.floorMesh.setColorAt(i, color);
    }
    this.floorMesh.instanceMatrix.needsUpdate = true;
    if (this.floorMesh.instanceColor) this.floorMesh.instanceColor.needsUpdate = true;
    this.group.add(this.floorMesh);
  }

  private buildWallMesh(world: LocalWorld): void {
    // Collect wall/window/vent tiles (all extrude to ISO_WALL_H*2)
    const wallTiles: Array<{ x: number; y: number; type: LocalTileType }> = [];
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (!tile) continue;
        if (tile.type === 'wall' || tile.type === 'window' || tile.type === 'vent') {
          wallTiles.push({ x, y, type: tile.type });
        }
      }
    }
    if (wallTiles.length === 0) return;

    const geom = new BoxGeometry(ISO_TILE_W, ISO_WALL_H * 2, ISO_TILE_W);
    const mat = new MeshStandardMaterial({ color: 0xC8C8C8, roughness: 0.8 });
    this.geometries.push(geom);
    this.materials.push(mat);

    this.wallMesh = new InstancedMesh(geom, mat, wallTiles.length);
    this.wallMesh.castShadow = true;
    this.wallMesh.receiveShadow = true;

    for (let i = 0; i < wallTiles.length; i++) {
      const { x, y } = wallTiles[i];
      _pos.copy(localGridToWorld3D(x, y, 0));
      _pos.y = ISO_WALL_H; // center of the 2*ISO_WALL_H box
      _q.identity();
      _matrix.compose(_pos, _q, _scale);
      this.wallMesh.setMatrixAt(i, _matrix);
    }
    this.wallMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.wallMesh);
  }

  private buildWorkbenchMesh(world: LocalWorld, opts: LocalTile3DOptions): void {
    // Collect workbench tiles
    const wbTiles: Array<{ x: number; y: number; ext: string }> = [];
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (!tile || tile.type !== 'workbench' || !tile.workbench) continue;
        wbTiles.push({ x, y, ext: tile.workbench.extension });
      }
    }
    if (wbTiles.length === 0) return;

    const geom = new BoxGeometry(ISO_TILE_W * 0.7, 8, ISO_TILE_W * 0.7);
    const mat = new MeshStandardMaterial({ roughness: 0.6, vertexColors: false });
    this.geometries.push(geom);
    this.materials.push(mat);

    this.workbenchMesh = new InstancedMesh(geom, mat, wbTiles.length);
    this.workbenchMesh.castShadow = true;

    const color = new Color();
    for (let i = 0; i < wbTiles.length; i++) {
      const { x, y, ext } = wbTiles[i];
      _pos.copy(localGridToWorld3D(x, y, 0));
      _pos.y = 4; // center of the 8-unit tall box
      _q.identity();
      _matrix.compose(_pos, _q, _scale);
      this.workbenchMesh.setMatrixAt(i, _matrix);
      color.setHex(EXT_COLORS[ext] ?? 0x8A8A8A);
      this.workbenchMesh.setColorAt(i, color);
    }
    this.workbenchMesh.instanceMatrix.needsUpdate = true;
    if (this.workbenchMesh.instanceColor) this.workbenchMesh.instanceColor.needsUpdate = true;
    this.group.add(this.workbenchMesh);
  }

  private buildDoorMesh(world: LocalWorld): void {
    // Collect door tiles (shorter, wood-colored)
    const doors: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (!tile || tile.type !== 'door') continue;
        doors.push({ x, y });
      }
    }
    if (doors.length === 0) return;

    const geom = new BoxGeometry(ISO_TILE_W * 0.8, ISO_WALL_H * 1.5, ISO_TILE_W * 0.3);
    const mat = new MeshStandardMaterial({ color: 0xB89860, roughness: 0.7 });
    this.geometries.push(geom);
    this.materials.push(mat);

    this.doorMesh = new InstancedMesh(geom, mat, doors.length);
    this.doorMesh.castShadow = true;

    for (let i = 0; i < doors.length; i++) {
      const { x, y } = doors[i];
      _pos.copy(localGridToWorld3D(x, y, 0));
      _pos.y = ISO_WALL_H * 0.75;
      _q.identity();
      _matrix.compose(_pos, _q, _scale);
      this.doorMesh.setMatrixAt(i, _matrix);
    }
    this.doorMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.doorMesh);
  }

  private buildFurnitureMesh(world: LocalWorld): void {
    // Collect all furniture-type tiles (chair, planter, sofa, etc.)
    // Group by geometry category for efficient InstancedMesh usage.
    // ... (follows same pattern: collect, create InstancedMesh, set matrices)
  }

  private disposeMeshes(): void {
    if (this.floorMesh) { this.group.remove(this.floorMesh); this.floorMesh.dispose(); this.floorMesh = null; }
    if (this.wallMesh) { this.group.remove(this.wallMesh); this.wallMesh.dispose(); this.wallMesh = null; }
    if (this.workbenchMesh) { this.group.remove(this.workbenchMesh); this.workbenchMesh.dispose(); this.workbenchMesh = null; }
    if (this.doorMesh) { this.group.remove(this.doorMesh); this.doorMesh.dispose(); this.doorMesh = null; }
    if (this.furnitureMesh) { this.group.remove(this.furnitureMesh); this.furnitureMesh.dispose(); this.furnitureMesh = null; }
  }

  dispose(): void {
    this.disposeMeshes();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries = [];
    this.materials = [];
    this.lastSignature = '';
  }
}
```

**Reusable patterns from existing code:**
- `CityCluster3D.ts` (lines 32-48): InstancedMesh lifecycle (create, setMatrixAt, dispose, signature dirty-flag)
- `HexWorldScene.ts` (lines 191-219): Lighting setup (ambient + directional + hemisphere)
- `UnitMesh3D.ts` (lines 78-108): GLB figurine construction with per-unit tinted materials

**Verification:** `npx vitest run src/three/LocalTile3D.test.ts`

---

## Task 3: Create `src/three/LocalAgent3D.ts` — Agent Figurines

**File:** `src/three/LocalAgent3D.ts` (NEW)

**Purpose:** Render local agents (`LocalUnit`) as 3D figurines in the local view. Reuses the GLB worker figurine from `UnitProps3D.ts` and the `buildGlbFigurine` pattern from `UnitMesh3D.ts`.

### Interface

```typescript
import { Group, Color, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { LocalUnit, LocalNpc } from '../types.ts';
import { areUnitPropsReady, getUnitPropParts } from './UnitProps3D.ts';
import { localGridToWorld3D, ISO_TILE_W, ISO_WALL_H } from './LocalCamera3D.ts';
import { HEX_SIZE } from '../constants.ts';

const HERO_TYPES = new Set(['hero', 'lexo', 'claude', 'codex', 'cursor', 'openclaw']);

type AgentLifeState = 'spawning' | 'alive' | 'despawning';

interface AgentEntry {
  group: Group;
  unitId: string;
  lifeState: AgentLifeState;
  /** Tween progress 0→1 for spawn, 1→0 for despawn. */
  tween: number;
  /** Per-unit phase offset for idle pulse. */
  idlePhase: number;
  /** Current hop height (0 when grounded). */
  hopY: number;
  /** Whether this agent is currently moving (drives hop animation). */
  moving: boolean;
  /** Current interpolated world position. */
  currentPos: Vector3;
  /** Path for movement tween (grid coords). */
  path: Array<{ x: number; y: number }>;
  /** Current step in path. */
  pathIndex: number;
  /** Progress between path steps (0-1). */
  pathProgress: number;
  /** Despawn fade alpha (1.0 = visible, 0.0 = invisible). */
  fadeAlpha: number;
}

/** Manages all local agent figurines (LocalUnits + LocalNpcs).
 *  Reuses the UnitMesh3D pattern: incremental add/remove, spawn/despawn tweens,
 *  idle pulse, per-step walking hop. */
export class LocalAgent3D {
  private group: Group;
  private entries = new Map<string, AgentEntry>();
  private lastSignature = '';

  constructor() {
    this.group = new Group();
    this.group.name = 'local-agents';
  }

  getGroup(): Group {
    return this.group;
  }

  /** Incremental add/remove/update. Called from render() with dirty flag. */
  update(units: LocalUnit[], npcs: LocalNpc[] = [], dt: number): void {
    const sig = this.computeSignature(units, npcs);
    const dirty = sig !== this.lastSignature;
    this.lastSignature = sig;

    if (dirty) {
      this.reconcile(units, npcs);
    }

    // Per-frame animations (always run, independent of dirty flag)
    this.tickAnimations(units, npcs, dt);
  }

  private computeSignature(units: LocalUnit[], npcs: LocalNpc[]): string {
    return [
      units.length,
      npcs.length,
      units.map(u => `${u.id}:${u.gridX},${u.gridY}:${u.state}:${u.despawning ? 'd' : 'a'}`).join('|'),
      npcs.map(n => `${n.id}:${n.gridX},${n.gridY}`).join('|'),
    ].join('#');
  }

  private reconcile(units: LocalUnit[], npcs: LocalNpc[]): void {
    // Build set of current IDs
    const currentIds = new Set<string>();
    for (const u of units) currentIds.add(u.id);
    for (const n of npcs) currentIds.add(n.id);

    // Despawn removed units (start despawn tween, remove when complete)
    for (const [id, entry] of this.entries) {
      if (!currentIds.has(id) && entry.lifeState !== 'despawning') {
        entry.lifeState = 'despawning';
        entry.tween = 1.0;
      }
    }

    // Spawn new units
    for (const unit of units) {
      if (!this.entries.has(unit.id)) {
        this.spawnAgent(unit.id, unit.color, HERO_TYPES.has(unit.unitType));
      }
    }
    for (const npc of npcs) {
      if (!this.entries.has(npc.id)) {
        this.spawnAgent(npc.id, npc.color, false);
      }
    }
  }

  private spawnAgent(id: string, color: string, isHero: boolean): void {
    const group = this.buildFigurine(isHero, new Color(color));
    group.castShadow = true;
    const entry: AgentEntry = {
      group,
      unitId: id,
      lifeState: 'spawning',
      tween: 0,
      idlePhase: Math.random() * Math.PI * 2,
      hopY: 0,
      moving: false,
      currentPos: new Vector3(),
      path: [],
      pathIndex: 0,
      pathProgress: 0,
      fadeAlpha: 1.0,
    };
    this.entries.set(id, entry);
    this.group.add(group);
  }

  /** Build a figurine: GLB if loaded, procedural fallback otherwise.
   *  Reuses the exact pattern from UnitMesh3D.buildGlbFigurine (lines 78-108). */
  private buildFigurine(isHero: boolean, col: Color): Group {
    if (areUnitPropsReady()) {
      // Reuse GLB worker figurine with per-agent tinted shirt
      const group = new Group();
      const parts = getUnitPropParts()!;
      parts.forEach((part, i) => {
        const mat = (part.material as MeshStandardMaterial).clone();
        if (i === 1) { // shirt/torso → tint with agent color
          mat.color.lerp(col, 0.55);
          mat.emissive.copy(col);
          mat.emissiveIntensity = isHero ? 0.4 : 0.22;
        }
        const mesh = new Mesh(part.geometry, mat);
        mesh.applyMatrix4(part.matrix);
        mesh.userData.sharedGeometry = true;
        mesh.castShadow = true;
        group.add(mesh);
      });
      // Scale to be visible in local view (ISO_TILE_W=64, so ~0.38*HEX_SIZE ≈ 20 units)
      const s = HEX_SIZE * (isHero ? 0.44 : 0.38);
      group.scale.setScalar(s);
      const wrapper = new Group();
      wrapper.add(group);
      return wrapper;
    }

    // Procedural fallback: cone + sphere (same as UnitMesh3D lines 151-188)
    const group = new Group();
    const bodyMat = new MeshStandardMaterial({
      color: col,
      emissive: col,
      emissiveIntensity: isHero ? 0.45 : 0.25,
      roughness: 0.55,
      metalness: isHero ? 0.35 : 0.1,
    });
    const base = new Mesh(new CylinderGeometry(HEX_SIZE * 0.1, HEX_SIZE * 0.13, HEX_SIZE * 0.04, 8), bodyMat);
    base.position.y = HEX_SIZE * 0.02;
    base.castShadow = true;
    group.add(base);
    const body = new Mesh(new ConeGeometry(HEX_SIZE * 0.065, HEX_SIZE * 0.22, 8), bodyMat);
    body.position.y = HEX_SIZE * 0.15;
    body.castShadow = true;
    group.add(body);
    const headR = HEX_SIZE * (isHero ? 0.072 : 0.058);
    const head = new Mesh(new SphereGeometry(headR, 8, 6), bodyMat);
    head.position.y = HEX_SIZE * 0.04 + HEX_SIZE * 0.22 + headR;
    head.castShadow = true;
    group.add(head);
    return group;
  }

  /** Per-frame: advance spawn/despawn tweens, idle pulse, walking hop, position interpolation.
   *  Mirrors UnitMesh3D.tickUnits (lines 300-499). */
  private tickAnimations(units: LocalUnit[], npcs: LocalNpc[], dt: number): void {
    const allAgents = [
      ...units.map(u => ({ id: u.id, gridX: u.gridX, gridY: u.gridY, path: u.path, pathIndex: u.pathIndex, pathProgress: u.pathProgress, moving: u.state === 'walking_to_workbench' || u.state === 'walking_to_room', fadeAlpha: u.fadeAlpha ?? 1.0, despawning: u.despawning })),
      ...npcs.map(n => ({ id: n.id, gridX: n.gridX, gridY: n.gridY, path: [], pathIndex: 0, pathProgress: 0, moving: false, fadeAlpha: 1.0, despawning: false })),
    ];

    for (const agent of allAgents) {
      const entry = this.entries.get(agent.id);
      if (!entry) continue;

      // Interpolated position
      let gx = agent.gridX, gy = agent.gridY;
      if (agent.path.length > 0 && agent.pathIndex < agent.path.length) {
        const from = agent.path[agent.pathIndex]!;
        const to = agent.path[Math.min(agent.pathIndex + 1, agent.path.length - 1)]!;
        const t = agent.pathProgress;
        gx = from.x + (to.x - from.x) * t;
        gy = from.y + (to.y - from.y) * t;
      }
      const targetPos = localGridToWorld3D(gx, gy, 0);
      entry.currentPos.lerp(targetPos, Math.min(1, dt * 8));
      entry.group.position.copy(entry.currentPos);

      // Spawn tween (scale 0→1)
      if (entry.lifeState === 'spawning') {
        entry.tween += dt * 3.3; // 300ms spawn
        if (entry.tween >= 1) { entry.tween = 1; entry.lifeState = 'alive'; }
        entry.group.scale.setScalar(entry.tween);
      }

      // Despawn tween (scale 1→0, then remove)
      if (entry.lifeState === 'despawning') {
        entry.tween -= dt * 5; // 200ms despawn
        if (entry.tween <= 0) {
          this.group.remove(entry.group);
          this.entries.delete(agent.id);
          continue;
        }
        entry.group.scale.setScalar(entry.tween);
      }

      // Idle pulse (breathing)
      if (entry.lifeState === 'alive' && !entry.moving) {
        const pulse = 1 + Math.sin(performance.now() * 0.003 + entry.idlePhase) * 0.02;
        entry.group.scale.setScalar(pulse);
      }

      // Walking hop
      if (agent.moving) {
        entry.hopY = Math.abs(Math.sin(performance.now() * 0.012)) * HEX_SIZE * 0.06;
        entry.group.position.y = entry.currentPos.y + entry.hopY;
      } else {
        entry.hopY = 0;
      }

      // Fade alpha for despawning units
      if (agent.despawning && agent.fadeAlpha < 1.0) {
        entry.group.traverse((obj) => {
          const m = obj as Mesh;
          if (m.isMesh && m.material instanceof MeshStandardMaterial) {
            m.material.transparent = true;
            m.material.opacity = agent.fadeAlpha;
          }
        });
      }
    }
  }

  dispose(): void {
    for (const [, entry] of this.entries) {
      // Dispose non-shared geometries and materials
      entry.group.traverse((obj) => {
        const m = obj as Mesh;
        if (m.isMesh) {
          if (!m.userData.sharedGeometry) m.geometry.dispose();
          if (Array.isArray(m.material)) m.material.forEach(mt => mt.dispose());
          else m.material.dispose();
        }
      });
    }
    this.entries.clear();
    this.group.clear();
    this.lastSignature = '';
  }
}
```

**Reusable patterns:**
- `UnitMesh3D.ts` lines 78-108: `buildGlbFigurine` — GLB with per-unit shirt tint
- `UnitMesh3D.ts` lines 141-188: `buildUnitFigurine` — procedural fallback
- `UnitMesh3D.ts` lines 300-499: `tickUnits` — spawn/despawn tweens, idle pulse, walking hop
- `UnitProps3D.ts`: `areUnitPropsReady()`, `getUnitPropParts()` — GLB loading state

**Verification:** `npx vitest run src/three/LocalAgent3D.test.ts`

---

## Task 4: Create `src/three/LocalPicker3D.ts` — Raycast Picking

**File:** `src/three/LocalPicker3D.ts` (NEW)

**Purpose:** Convert screen clicks to local grid (x, y) via raycast against the floor InstancedMesh. Reuses the `HexPicker` pattern.

### Interface

```typescript
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

    // Get the world position of the hit point
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
```

**Reusable pattern:** `HexPicker.ts` (69 lines) — same Raycaster + NDC + instanceId approach.

---

## Task 5: Create `src/three/LocalScene3D.ts` — Main Scene Orchestrator

**File:** `src/three/LocalScene3D.ts` (NEW)

**Purpose:** Top-level class that owns the Three.js `Scene`, `WebGLRenderer`, `OrthographicCamera` (via `LocalCamera3D`), tile meshes (via `LocalTile3D`), agent figurines (via `LocalAgent3D`), and lighting. Mirrors `ThreeMapRenderer.ts` structure but for the local view.

### Interface

```typescript
import {
  ACESFilmicToneMapping, PCFSoftShadowMap, WebGLRenderer,
  AmbientLight, DirectionalLight, HemisphereLight, Scene,
  Group, Color, type OrthographicCamera,
} from 'three';
import type { LocalWorld, LocalUnit, LocalNpc, LocalTile } from '../types.ts';
import { LocalCamera3D, type LocalCamState } from './LocalCamera3D.ts';
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
  private lastSignature = '';
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
    // Ambient base + directional (window light from upper-left) + hemisphere
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

    // Point lights for focus zones (subtle warm pools over team clusters)
    // Added dynamically based on room zone types — see addFocusLights()

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
    this.lastSignature = ''; // force rebuild
    // Center camera on world center
    const centerX = (world.width / 2) * 32; // approximate grid center in world units
    const centerY = (world.height / 2) * 16;
    // Use LocalCamState
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

    // Fire onUnitRendered callbacks for overlay sync
    // (project each unit position to screen, fire callback)
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

  resize(): void {
    this.handleResize();
  }

  private setupInput(): void {
    // Click handler: pick tile, determine if it's a unit/workbench/floor, fire callback
    // Right-click: exit local view (onRequestExit)
    // Hover: pick tile, find unit at tile, fire onLocalUnitHover
    // ... (mirrors LocalRenderer.setupInput pattern)
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.tile3D.dispose();
    this.agent3D.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
```

---

## Task 6: Modify `src/three/renderMode.ts` — Add Local3D Load Helper

**File:** `src/three/renderMode.ts` (MODIFY — append at end)

**Purpose:** Add a lazy-load helper for `LocalScene3D`, matching the existing `loadThreeMapRenderer()` pattern.

### Changes

Append after line 68 (end of file):

```typescript
export async function loadLocalScene3D(): Promise<
  typeof import('./LocalScene3D.ts').LocalScene3D
> {
  const mod = await import('./LocalScene3D.ts');
  return mod.LocalScene3D;
}
```

---

## Task 7: Modify `src/renderer.ts` — Integrate LocalScene3D

**File:** `src/renderer.ts` (MODIFY)

**Purpose:** When `worldRenderMode === 'webgl'` and `viewMode === 'local'`, use `LocalScene3D` instead of `LocalRenderer` (Canvas 2D).

### Changes

#### 7a. Add new fields (after line 119, near `private _previousViewMode`)

```typescript
// Phase A: 3D local view
private localScene3D: LocalScene3DType | null = null;
private localScene3DLoadPromise: Promise<void> | null = null;
private localScene3DContainer: HTMLElement | null = null;
```

Add type import at top of file (after existing `ThreeMapRendererType` import):

```typescript
import type { LocalScene3D as LocalScene3DType } from './three/LocalScene3D.ts';
import { loadLocalScene3D } from './three/renderMode.ts';
```

#### 7b. Add `ensureLocalScene3D()` method (after `ensureThreeMap()`, ~line 291)

```typescript
private async ensureLocalScene3D(): Promise<void> {
  if (this.localScene3D) return;
  if (!this.localScene3DLoadPromise) {
    this.localScene3DLoadPromise = (async () => {
      // Reuse the #three-container element (same DOM container as macro 3D)
      // OR create a dedicated #local-scene-container
      this.localScene3DContainer =
        document.getElementById('local-scene-container') ??
        document.getElementById('three-container');
      if (!this.localScene3DContainer) {
        throw new Error('#local-scene-container or #three-container not found');
      }
      const LocalScene3D = await loadLocalScene3D();
      this.localScene3D = new LocalScene3D(this.localScene3DContainer);
      // Wire callbacks (same as LocalRenderer wiring, lines 1122-1131)
      this.localScene3D.callbacks.onTileClick = (x, y, tile, sx, sy) =>
        this.localTileClickCb?.(x, y, tile, sx, sy);
      this.localScene3D.callbacks.onLocalUnitClick = this.localUnitClickCb;
      this.localScene3D.callbacks.onWorkbenchClick = this.localWorkbenchClickCb;
      this.localScene3D.callbacks.onLocalUnitHover = (unit, sx, sy) =>
        this.localUnitHoverCb?.(unit, sx, sy);
      this.localScene3D.callbacks.onNpcClick = this.localNpcClickCb;
      this.localScene3D.callbacks.onUnitRendered = (unit, sx, sy) =>
        this.localUnitRenderedCb?.(unit, sx, sy);
      this.localScene3D.callbacks.onDragAssign = (unitId, tile) =>
        this.localDragAssignCb?.(unitId, tile);
      this.localScene3D.callbacks.onRequestExit = () => this.state.enterMacroView();
    })();
  }
  try {
    await this.localScene3DLoadPromise;
  } catch (err) {
    this.localScene3DLoadPromise = null;
    throw err;
  }
}
```

#### 7c. Modify `render()` method (lines 1100-1178)

In the local view branch (line 1154 onwards), add a check for `worldRenderMode === 'webgl'`:

```typescript
if (currentViewMode === 'local') {
  this.threeMap?.setActive(false);

  // ── 3D local view (Phase A) ──────────────────────────────────────────
  if (this.worldRenderMode === 'webgl') {
    if (!this.localScene3D && !this.localScene3DLoadPromise) {
      void this.ensureLocalScene3D().catch((err) => {
        logger.error('[Renderer] Local 3D init failed, falling back to 2D', err);
      });
    }
    if (this.localScene3D && this.state.localWorld) {
      if (this.state.localWorld.repoId !== this.localWorldId) {
        this.localScene3D.setWorld(this.state.localWorld);
        this.localWorldId = this.state.localWorld.repoId;
      }
      this.localScene3D.setActive(true);
      // Build LocalCamState from the 2D local renderer's camera (or default)
      const cam = this.localR?.getCam?.() ?? { x: 0, y: 0, zoom: 1, cx: 0, cy: 0 };
      this.localScene3D.render(
        cam,
        this.state.getLocalUnits(),
        this.state.localWorld.npcs ?? [],
        {
          dt: this._dt,
          workbenchLabelOverlay: this.localR?.isWorkbenchLabelOverlay?.() ?? false,
          powerOverlay: this.localR?.isPowerOverlay?.() ?? false,
          temperatureOverlay: this.localR?.isTemperatureOverlay?.() ?? false,
        },
      );
      // Still need the Canvas 2D for overlays (tooltips, bubbles, labels)
      // — the 3D renders the world, 2D renders overlays on top
    }
    // If localScene3D not ready yet, fall through to 2D as a transient
  }

  // ── 2D local view (flat mode or 3D fallback) ──────────────────────────
  this.localR?.setInputActive(this.worldRenderMode !== 'webgl' || !this.localScene3D);
  // ... existing 2D code (lines 1157-1178) stays as fallback
```

#### 7d. Modify exit transition (line 1182-1197)

When exiting local view while in 3D mode, deactivate the 3D scene:

```typescript
if (this._localExitInProgress && this.localR && !this.localR.isTransitionComplete()) {
  this.localR.render(this.state.getLocalUnits());
  return;
}
// Phase A: deactivate 3D local scene on exit
this.localScene3D?.setActive(false);
```

#### 7e. Modify `setWorldRenderMode()` (line 233-258)

When toggling to flat mode, deactivate 3D local:

```typescript
// In the 'flat' branch of setWorldRenderMode:
this.localScene3D?.setActive(false);
```

---

## Task 8: Add `getFloorMesh()` accessor to `LocalTile3D`

**File:** `src/three/LocalTile3D.ts` (MODIFY — add method to class)

```typescript
/** Expose the floor InstancedMesh for raycast picking. */
getFloorMesh(): InstancedMesh | null {
  return this.floorMesh;
}
```

---

## Task 9: Add `getCam()`, `isWorkbenchLabelOverlay()`, `isPowerOverlay()`, `isTemperatureOverlay()` accessors to `LocalRenderer`

**File:** `src/localRenderer.ts` (MODIFY — add after line 219)

```typescript
getCam(): { x: number; y: number; zoom: number; cx: number; cy: number } {
  return this.cam;
}
isWorkbenchLabelOverlay(): boolean {
  return this._workbenchLabelOverlay;
}
isPowerOverlay(): boolean {
  return this._powerOverlay;
}
isTemperatureOverlay(): boolean {
  return this._temperatureOverlay;
}
```

---

## Task 10: Tests — `src/three/LocalScene3D.test.ts`

**File:** `src/three/LocalScene3D.test.ts` (NEW)

### Test Suite

```typescript
import { describe, it, expect } from 'vitest';
import { LocalScene3D } from './LocalScene3D.ts';
import { LocalCamera3D, localGridToWorld3D, world3DToLocalGrid } from './LocalCamera3D.ts';
import { LocalTile3D } from './LocalTile3D.ts';
import { LocalAgent3D } from './LocalAgent3D.ts';
import { LocalPicker3D } from './LocalPicker3D.ts';
import type { LocalWorld, LocalTile, LocalUnit, LocalRoom } from '../types.ts';

// ── Test factory: minimal LocalWorld ──────────────────────────────────────────
function makeMockWorld(w = 8, h = 8): LocalWorld {
  const grid: LocalTile[][] = [];
  for (let y = 0; y < h; y++) {
    grid[y] = [];
    for (let x = 0; x < w; x++) {
      const isBorder = x === 0 || x === w - 1 || y === 0 || y === h - 1;
      grid[y][x] = {
        x, y,
        type: isBorder ? 'wall' : 'floor',
        roomId: null,
        workbench: null,
      };
    }
  }
  return {
    repoId: 'test-repo',
    grid,
    rooms: [],
    width: w,
    height: h,
    workbenches: [],
    deskAssignments: new Map(),
  };
}

function makeMockUnit(id: string, x: number, y: number): LocalUnit {
  return {
    id, name: id, unitType: 'worker', color: '#4af',
    gridX: x, gridY: y, targetX: null, targetY: null,
    path: [], pathIndex: 0, pathProgress: 0,
    state: 'idle_in_room', mission: null, workProgress: 0,
    macroUnitId: id, currentWorkbenchId: null,
  };
}

// ── LocalCamera3D tests ──────────────────────────────────────────────────────
describe('LocalCamera3D', () => {
  it('constructs an OrthographicCamera with correct frustum', () => {
    const cam = new LocalCamera3D(800, 600);
    const camera = cam.getCamera();
    expect(camera.isOrthographicCamera).toBe(true);
    expect(camera.left).toBe(-400);
    expect(camera.right).toBe(400);
    expect(camera.top).toBe(300);
    expect(camera.bottom).toBe(-300);
  });

  it('applies zoom by dividing frustum size', () => {
    const cam = new LocalCamera3D(800, 600);
    cam.syncCamera({ x: 0, y: 0, zoom: 2, cx: 400, cy: 300 });
    const camera = cam.getCamera();
    expect(camera.left).toBe(-200);
    expect(camera.right).toBe(200);
    expect(camera.top).toBe(150);
    expect(camera.bottom).toBe(-150);
  });

  it('positions camera along the iso viewing direction', () => {
    const cam = new LocalCamera3D(800, 600);
    cam.syncCamera({ x: 100, y: 50, zoom: 1, cx: 400, cy: 300 });
    const camera = cam.getCamera();
    // Camera should be offset from target along the iso direction
    expect(camera.position.x).toBeGreaterThan(100); // ahead of target.x
    expect(camera.position.y).toBeGreaterThan(0);    // above ground
    expect(camera.position.z).toBeGreaterThan(50);  // ahead of target.z
  });

  it('resize updates frustum dimensions', () => {
    const cam = new LocalCamera3D(800, 600);
    cam.resize(1024, 768);
    cam.syncCamera({ x: 0, y: 0, zoom: 1, cx: 512, cy: 384 });
    const camera = cam.getCamera();
    expect(camera.right).toBe(512);
    expect(camera.top).toBe(384);
  });
});

// ── Coordinate conversion tests ──────────────────────────────────────────────
describe('localGridToWorld3D / world3DToLocalGrid', () => {
  it('round-trips grid coordinates through 3D and back', () => {
    const x = 5, y = 3;
    const world = localGridToWorld3D(x, y, 0);
    const back = world3DToLocalGrid(world.x, world.z);
    expect(Math.abs(back.x - x)).toBeLessThan(0.01);
    expect(Math.abs(back.y - y)).toBeLessThan(0.01);
  });

  it('maps origin to origin', () => {
    const world = localGridToWorld3D(0, 0, 0);
    expect(world.x).toBe(0);
    expect(world.y).toBe(0);
    expect(world.z).toBe(0);
  });

  it('applies elevation offset along Y axis', () => {
    const world = localGridToWorld3D(0, 0, 2); // z=2 (wall height)
    expect(world.y).toBe(2 * 24); // ISO_WALL_H = 24
  });
});

// ── LocalTile3D tests ─────────────────────────────────────────────────────────
describe('LocalTile3D', () => {
  it('builds floor and wall meshes from a LocalWorld', () => {
    const world = makeMockWorld(6, 6);
    const tile3D = new LocalTile3D();
    const dirty = tile3D.rebuild(world, {
      workbenchLabelOverlay: false,
      powerOverlay: false,
      temperatureOverlay: false,
    });
    expect(dirty).toBe(true);
    const group = tile3D.getGroup();
    expect(group.children.length).toBeGreaterThan(0);
  });

  it('returns false on rebuild when world has not changed', () => {
    const world = makeMockWorld(6, 6);
    const tile3D = new LocalTile3D();
    tile3D.rebuild(world, { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false });
    const dirty2 = tile3D.rebuild(world, { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false });
    expect(dirty2).toBe(false);
  });

  it('returns a floor mesh for picking', () => {
    const world = makeMockWorld(4, 4);
    const tile3D = new LocalTile3D();
    tile3D.rebuild(world, { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false });
    expect(tile3D.getFloorMesh()).not.toBeNull();
  });

  it('disposes meshes cleanly', () => {
    const world = makeMockWorld(4, 4);
    const tile3D = new LocalTile3D();
    tile3D.rebuild(world, { workbenchLabelOverlay: false, powerOverlay: false, temperatureOverlay: false });
    tile3D.dispose();
    expect(tile3D.getFloorMesh()).toBeNull();
  });
});

// ── LocalAgent3D tests ────────────────────────────────────────────────────────
describe('LocalAgent3D', () => {
  it('spawns agent figurines for new LocalUnits', () => {
    const agent3D = new LocalAgent3D();
    const units = [makeMockUnit('u1', 2, 2), makeMockUnit('u2', 4, 3)];
    agent3D.update(units, [], 0.016);
    const group = agent3D.getGroup();
    expect(group.children.length).toBe(2);
  });

  it('starts despawning when a unit is removed', () => {
    const agent3D = new LocalAgent3D();
    agent3D.update([makeMockUnit('u1', 2, 2)], [], 0.016);
    // Remove u1 — should start despawn
    agent3D.update([], [], 0.016);
    // After 0.3s of despawn, should be removed
    agent3D.update([], [], 0.3);
    // Still despawning at this point (200ms tween)
    agent3D.update([], [], 0.1);
    expect(agent3D.getGroup().children.length).toBe(0);
  });

  it('updates agent positions based on grid coords', () => {
    const agent3D = new LocalAgent3D();
    agent3D.update([makeMockUnit('u1', 2, 2)], [], 0.016);
    // Move unit
    agent3D.update([{
      ...makeMockUnit('u1', 5, 5),
      state: 'walking_to_workbench',
    }], [], 1.0);
    // Agent should have moved toward (5,5)
    const group = agent3D.getGroup();
    expect(group.children.length).toBe(1);
  });

  it('disposes all entries cleanly', () => {
    const agent3D = new LocalAgent3D();
    agent3D.update([makeMockUnit('u1', 2, 2)], [], 0.016);
    agent3D.dispose();
    expect(agent3D.getGroup().children.length).toBe(0);
  });
});

// ── LocalPicker3D tests ───────────────────────────────────────────────────────
describe('LocalPicker3D', () => {
  it('returns null when no floor mesh exists', () => {
    const picker = new LocalPicker3D();
    // Cannot easily test raycast without a real mesh + camera;
    // this is a structural test ensuring the class is constructable
    expect(picker).toBeDefined();
  });
});
```

---

## Task 11: Verification Steps

### 11a. TypeScript Type Check

```bash
npx tsc --noEmit
```

Must pass with zero errors. Key things to verify:
- All imports resolve (`.ts` extensions required)
- No unused locals/parameters (tsconfig has `noUnusedLocals: true`)
- `exactOptionalPropertyTypes: false` — optional properties can be omitted
- Three.js types match `@types/three@0.175.0`

### 11b. Unit Tests

```bash
npx vitest run src/three/LocalCamera3D.test.ts
npx vitest run src/three/LocalTile3D.test.ts
npx vitest run src/three/LocalAgent3D.test.ts
npx vitest run src/three/LocalPicker3D.test.ts
```

All must pass. If any test uses `three` modules that require a canvas/WebGL context, ensure vitest config has `environment: 'jsdom'` or the test stubs out the WebGL context.

Check vitest config:

```bash
cat vitest.config.ts 2>/dev/null || cat vite.config.ts | grep -A10 'test:'
```

If no test environment is configured, add to `vite.config.ts`:

```typescript
test: {
  environment: 'jsdom',
  // ... existing config
}
```

### 11c. Full Build

```bash
npm run build
```

Runs `tsc && vite build`. Must succeed with zero errors and produce a production bundle.

### 11d. Full Test Suite

```bash
npm run test
```

All existing tests must still pass — no regressions in `HexWorldScene.test.ts`, `ThreeMapRenderer.test.ts`, `UnitMesh3D.test.ts`, etc.

### 11e. Visual Screenshot Comparison

```bash
# 1. Start dev server
npm run dev

# 2. Open browser at http://localhost:5273
# 3. Enter local view (click a city)
# 4. Toggle to WebGL mode (press '0' hotkey)
# 5. Compare:
#    - Floor tiles visible with correct zone colors
#    - Walls visible with correct height
#    - Workbenches visible with extension-based colors
#    - Agent figurines visible, moving on paths
#    - Doors visible, shorter than walls
#    - Camera angle matches 2D iso projection
#    - Clicking a tile fires the same callbacks as 2D

# 6. Use Playwright screenshot automation (if available):
npx playwright test --grep "local.*3d" 2>/dev/null || true
```

---

## Reusable Three.js Patterns from Existing Code

| Pattern | Source File | Lines | Reuse In |
|---------|-------------|-------|----------|
| InstancedMesh lifecycle (create, setMatrixAt, dispose, signature) | `CityCluster3D.ts` | 32-48 | `LocalTile3D` |
| Lighting setup (ambient + directional + hemisphere) | `HexWorldScene.ts` | 191-219 | `LocalScene3D` |
| GLB figurine with per-unit tinted shirt | `UnitMesh3D.ts` | 78-108 | `LocalAgent3D` |
| Procedural figurine fallback (cone + sphere) | `UnitMesh3D.ts` | 141-188 | `LocalAgent3D` |
| Spawn/despawn tweens (300ms spawn, 200ms despawn) | `UnitMesh3D.ts` | 33-59 | `LocalAgent3D` |
| Idle pulse + walking hop | `UnitMesh3D.ts` | 300-499 | `LocalAgent3D` |
| Raycast picking (NDC → instanceId) | `HexPicker.ts` | 1-69 | `LocalPicker3D` |
| Dirty-flag signature for rebuilds | `ThreeMapRenderer.ts` | 200-220 | `LocalScene3D` |
| ResizeObserver + handleResize | `ThreeMapRenderer.ts` | 94-136 | `LocalScene3D` |
| WebGLRenderer setup (tone mapping, shadows) | `ThreeMapRenderer.ts` | 71-87 | `LocalScene3D` |
| Camera sync from 2D camera struct | `ThreeMapRenderer.ts` | 140-158 | `LocalCamera3D` |
| GLB loader (async load, fallback) | `UnitProps3D.ts` | 36-66 | `LocalAgent3D` (via existing loader) |
| Screen-to-map-space projection | `ThreeMapRenderer.ts` | 266-272 | `LocalScene3D` (for overlay sync) |
| `setActive()` / `resize()` / `dispose()` pattern | `ThreeMapRenderer.ts` | 334-351 | `LocalScene3D` |
| `computeWorldSignature` pattern | `ThreeMapRenderer.ts` | 369-399 | `LocalScene3D.computeSignature` |

---

## File Summary

### New Files

| File | Purpose | Est. Lines |
|------|---------|------------|
| `src/three/LocalCamera3D.ts` | OrthographicCamera + coordinate conversion | ~90 |
| `src/three/LocalTile3D.ts` | InstancedMesh for floors/walls/workbenches/furniture | ~250 |
| `src/three/LocalAgent3D.ts` | Agent figurines (GLB reuse + spawn/despawn/pulse/hop) | ~220 |
| `src/three/LocalPicker3D.ts` | Raycast picking on local grid | ~50 |
| `src/three/LocalScene3D.ts` | Main orchestrator (scene, renderer, lighting, input) | ~200 |
| `src/three/LocalScene3D.test.ts` | Unit tests for all components | ~180 |

### Modified Files

| File | Lines Changed | Change |
|------|---------------|--------|
| `src/three/renderMode.ts` | +5 (append) | Add `loadLocalScene3D()` helper |
| `src/renderer.ts` | ~1119 (add fields), ~291 (add method), ~1154-1178 (modify render) | Integrate LocalScene3D into render loop |
| `src/localRenderer.ts` | +15 (after line 219) | Add `getCam()`, overlay accessor methods |

### Key Design Decisions

1. **OrthographicCamera (not PerspectiveCamera):** The 2D iso renderer has no perspective distortion — orthographic is the exact match. The macro view uses PerspectiveCamera because hex terrain has elevation; the local view is flat-grid.

2. **Separate `#local-scene-container` preferred:** Avoids DOM conflicts with the macro `#three-container`. If not present, falls back to `#three-container` (same pattern as `ensureThreeMap`).

3. **2D Canvas stays for overlays:** Even in 3D mode, the Canvas 2D layer renders on top for tooltips, bubbles, zone painting preview, and workbench labels. The 3D scene renders the world; 2D renders UI overlays. This matches how the macro view works (ThreeMapRenderer renders the world, Canvas 2D renders highlights/outlines on top — see `renderer.ts` lines 381-394).

4. **Dirty-flag pattern:** `LocalTile3D.rebuild()` uses a signature hash (grid dimensions + tile types + overlay flags) to skip rebuilds when nothing changed — same pattern as `HexWorldScene` and `CityCluster3D`.

5. **GLB reuse without re-loading:** `LocalAgent3D` calls `areUnitPropsReady()` and `getUnitPropParts()` from the existing `UnitProps3D.ts` module. The GLB is loaded once globally (when the macro scene initializes) and shared. No duplicate load needed.

6. **Camera state sharing:** The 3D local renderer reads the 2D local renderer's camera state (`localR.getCam()`) to keep pan/zoom synchronized. If the 2D renderer isn't instantiated yet, it falls back to a centered default.