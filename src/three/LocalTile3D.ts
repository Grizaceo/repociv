// ─── Local view: floor/wall/workbench InstancedMesh tiles ─────────────────
// Renders all static local tiles as Three.js InstancedMesh groups, mirroring
// the 2D iso renderer (isoLocalRenderer.ts). One InstancedMesh per tile
// category, rebuilt on a dirty signature (same pattern as CityCluster3D).

import {
  BoxGeometry,
  CylinderGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';

import type { LocalWorld, LocalTileType } from '../types.ts';
import { localGridToWorld3D, ISO_TILE_W, ISO_WALL_H } from './LocalCamera3D.ts';

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

// Reusable temporaries (avoid per-frame allocations)
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
  private furnitureMeshes: Map<string, InstancedMesh> = new Map();
  private lastSignature = '';

  // Geometry/material cache (disposed on dispose())
  private geometries: BufferGeometry[] = [];
  private materials: Material[] = [];

  constructor() {
    this.group = new Group();
    this.group.name = 'local-tiles';
  }

  getGroup(): Group {
    return this.group;
  }

  /** Expose floor InstancedMesh for raycast picking. */
  getFloorMesh(): InstancedMesh | null {
    return this.floorMesh;
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
    this.buildFurnitureMeshes(world);

    return true;
  }

  private computeSignature(world: LocalWorld, opts: LocalTile3DOptions): string {
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
      opts.temperatureOverlay ? 1 : 0,
    ].join('#');
  }

  private buildFloorMesh(world: LocalWorld): void {
    const floorTiles: Array<{ x: number; y: number; color: number }> = [];
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (!tile) continue;
        if (tile.type !== 'floor' && tile.type !== 'path' && tile.type !== 'aisle') continue;
        const room = tile.roomId ? world.rooms.find(r => r.id === tile.roomId) : null;
        const zoneType = room?.zoneType ?? 'path';
        const color = ZONE_FLOOR_COLORS[zoneType] ?? 0xB8B8B8;
        floorTiles.push({ x, y, color });
      }
    }
    if (floorTiles.length === 0) return;

    const geom = new BoxGeometry(ISO_TILE_W, 2, ISO_TILE_W);
    const mat = new MeshStandardMaterial({ roughness: 0.85 });
    this.geometries.push(geom);
    this.materials.push(mat);

    this.floorMesh = new InstancedMesh(geom, mat, floorTiles.length);
    this.floorMesh.receiveShadow = true;
    this.floorMesh.castShadow = false;

    const color = new Color();
    for (let i = 0; i < floorTiles.length; i++) {
      const ft = floorTiles[i]!;
      _pos.copy(localGridToWorld3D(ft.x, ft.y, 0));
      _pos.y = 0;
      _q.identity();
      _matrix.compose(_pos, _q, _scale);
      this.floorMesh.setMatrixAt(i, _matrix);
      color.setHex(ft.color);
      this.floorMesh.setColorAt(i, color);
    }
    this.floorMesh.instanceMatrix.needsUpdate = true;
    if (this.floorMesh.instanceColor) this.floorMesh.instanceColor.needsUpdate = true;
    this.group.add(this.floorMesh);
  }

  private buildWallMesh(world: LocalWorld): void {
    const wallTiles: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (!tile) continue;
        if (tile.type === 'wall' || tile.type === 'window' || tile.type === 'vent') {
          wallTiles.push({ x, y });
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
      const wt = wallTiles[i]!;
      _pos.copy(localGridToWorld3D(wt.x, wt.y, 0));
      _pos.y = ISO_WALL_H;
      _q.identity();
      _matrix.compose(_pos, _q, _scale);
      this.wallMesh.setMatrixAt(i, _matrix);
    }
    this.wallMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.wallMesh);
  }

  private buildWorkbenchMesh(world: LocalWorld, _opts: LocalTile3DOptions): void {
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
    const mat = new MeshStandardMaterial({ roughness: 0.6 });
    this.geometries.push(geom);
    this.materials.push(mat);

    this.workbenchMesh = new InstancedMesh(geom, mat, wbTiles.length);
    this.workbenchMesh.castShadow = true;

    const color = new Color();
    for (let i = 0; i < wbTiles.length; i++) {
      const wb = wbTiles[i]!;
      _pos.copy(localGridToWorld3D(wb.x, wb.y, 0));
      _pos.y = 4;
      _q.identity();
      _matrix.compose(_pos, _q, _scale);
      this.workbenchMesh.setMatrixAt(i, _matrix);
      color.setHex(EXT_COLORS[wb.ext] ?? 0x8A8A8A);
      this.workbenchMesh.setColorAt(i, color);
    }
    this.workbenchMesh.instanceMatrix.needsUpdate = true;
    if (this.workbenchMesh.instanceColor) this.workbenchMesh.instanceColor.needsUpdate = true;
    this.group.add(this.workbenchMesh);
  }

  private buildDoorMesh(world: LocalWorld): void {
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
      const d = doors[i]!;
      _pos.copy(localGridToWorld3D(d.x, d.y, 0));
      _pos.y = ISO_WALL_H * 0.75;
      _q.identity();
      _matrix.compose(_pos, _q, _scale);
      this.doorMesh.setMatrixAt(i, _matrix);
    }
    this.doorMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.doorMesh);
  }

  // Furniture types that share box geometry — grouped for efficiency
  private static FURNITURE_SPECS: Array<{
    types: Set<LocalTileType>;
    w: number; h: number; d: number;
    y: number;
    color: number;
    geom: 'box' | 'cylinder';
    key: string;
  }> = [
    { types: new Set(['chair']), w: 20, h: 6, d: 20, y: 3, color: 0x8B6B4A, geom: 'box', key: 'chair' },
    { types: new Set(['planter']), w: 16, h: 24, d: 16, y: 12, color: 0x4A9E8E, geom: 'cylinder', key: 'planter' },
    { types: new Set(['whiteboard']), w: ISO_TILE_W * 0.8, h: 20, d: 4, y: 10, color: 0xF0F0F0, geom: 'box', key: 'whiteboard' },
    { types: new Set(['server_rack']), w: 24, h: 40, d: 24, y: 20, color: 0x7A8B9E, geom: 'box', key: 'server_rack' },
    { types: new Set(['sofa']), w: 40, h: 12, d: 20, y: 6, color: 0xC47A4A, geom: 'box', key: 'sofa' },
    { types: new Set(['meeting_room']), w: ISO_TILE_W, h: 6, d: ISO_TILE_W, y: 3, color: 0xD49B3A, geom: 'box', key: 'meeting_room' },
    { types: new Set(['phone_booth']), w: 20, h: ISO_WALL_H * 1.5, d: 20, y: ISO_WALL_H * 0.75, color: 0x4A8F4A, geom: 'box', key: 'phone_booth' },
    { types: new Set(['break_area']), w: 40, h: 12, d: 40, y: 6, color: 0xC47A4A, geom: 'box', key: 'break_area' },
    { types: new Set(['reception']), w: ISO_TILE_W * 0.8, h: 12, d: ISO_TILE_W * 0.5, y: 6, color: 0xC4B8A0, geom: 'box', key: 'reception' },
    { types: new Set(['standing_desk']), w: 28, h: 16, d: 20, y: 8, color: 0x8B7355, geom: 'box', key: 'standing_desk' },
    { types: new Set(['watercooler']), w: 8, h: 20, d: 8, y: 10, color: 0x5BA3D0, geom: 'cylinder', key: 'watercooler' },
    { types: new Set(['cubicle_partition']), w: ISO_TILE_W, h: ISO_WALL_H * 0.5, d: 4, y: ISO_WALL_H * 0.25, color: 0xA8B0C0, geom: 'box', key: 'cubicle_partition' },
    { types: new Set(['research_bench']), w: ISO_TILE_W * 0.7, h: 8, d: ISO_TILE_W * 0.7, y: 4, color: 0x9A8FC4, geom: 'box', key: 'research_bench' },
  ];

  private buildFurnitureMeshes(world: LocalWorld): void {
    for (const spec of LocalTile3D.FURNITURE_SPECS) {
      const tiles: Array<{ x: number; y: number }> = [];
      for (let y = 0; y < world.height; y++) {
        for (let x = 0; x < world.width; x++) {
          const tile = world.grid[y]?.[x];
          if (!tile) continue;
          if (spec.types.has(tile.type)) tiles.push({ x, y });
        }
      }
      if (tiles.length === 0) continue;

      const geom: BufferGeometry = spec.geom === 'cylinder'
        ? new CylinderGeometry(spec.w, spec.w * 1.25, spec.h)
        : new BoxGeometry(spec.w, spec.h, spec.d);
      const mat = new MeshStandardMaterial({ color: spec.color, roughness: 0.7 });
      this.geometries.push(geom);
      this.materials.push(mat);

      const mesh = new InstancedMesh(geom, mat, tiles.length);
      mesh.castShadow = true;
      mesh.receiveShadow = spec.geom === 'box';

      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i]!;
        _pos.copy(localGridToWorld3D(t.x, t.y, 0));
        _pos.y = spec.y;
        _q.identity();
        _matrix.compose(_pos, _q, _scale);
        mesh.setMatrixAt(i, _matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      this.furnitureMeshes.set(spec.key, mesh);
      this.group.add(mesh);
    }
  }

  private disposeMeshes(): void {
    if (this.floorMesh) { this.group.remove(this.floorMesh); this.floorMesh.dispose(); this.floorMesh = null; }
    if (this.wallMesh) { this.group.remove(this.wallMesh); this.wallMesh.dispose(); this.wallMesh = null; }
    if (this.workbenchMesh) { this.group.remove(this.workbenchMesh); this.workbenchMesh.dispose(); this.workbenchMesh = null; }
    if (this.doorMesh) { this.group.remove(this.doorMesh); this.doorMesh.dispose(); this.doorMesh = null; }
    for (const mesh of this.furnitureMeshes.values()) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.furnitureMeshes.clear();
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
