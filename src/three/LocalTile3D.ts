// ─── RepoCiv — Local Tile 3D (InstancedMesh for floors, walls, workbenches) ──
// Renders all static local tiles as Three.js InstancedMesh objects.
// Uses the exact ISO constants from isoOfficeSprites for pixel-perfect parity.

import {
  BoxGeometry,
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
import type { LocalWorld, LocalTile, LocalTileType } from '../types.ts';
import { localGridToWorld3D, ISO_TILE_W, ISO_WALL_H } from './LocalCamera3D.ts';

// ─── Zone floor colors (matching isoLocalRenderer.ts ISO_FLOOR map) ──────────
const ZONE_FLOOR_COLORS: Record<string, number> = {
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

// Extension → color map (matching isoLocalRenderer.ts ext color system)
const EXT_COLORS: Record<string, number> = {
  ts: 0x4a8fb5, tsx: 0x4a8fb5, js: 0xd4b04a, jsx: 0xd4b04a,
  py: 0x4a9e5a, go: 0x4ab8c4, rs: 0xc45a4a, java: 0xb06a2a,
  md: 0x8a8a8a, json: 0x9a9a6a, yaml: 0x9a9a6a, yml: 0x9a9a6a,
  css: 0xc47ac4, html: 0xc44a4a, sh: 0x4a8f4a,
};

// ─── Tile type classification ─────────────────────────────────────────────────
type TileCategory = 'floor' | 'wall' | 'door' | 'workbench' | 'chair' | 'furniture';

function categorizeTile(tile: LocalTile): TileCategory {
  switch (tile.type) {
    case 'wall':
      return 'wall';
    case 'door':
      return 'door';
    case 'workbench':
    case 'standing_desk':
      return 'workbench';
    case 'chair':
      return 'chair';
    case 'cubicle_partition':
    case 'planter':
    case 'whiteboard':
    case 'server_rack':
    case 'sofa':
    case 'watercooler':
    case 'meeting_room':
    case 'phone_booth':
    case 'break_area':
    case 'reception':
    case 'stairs':
      return 'furniture';
    default:
      return 'floor';
  }
}

// ─── LocalTile3D class ────────────────────────────────────────────────────────
const _matrix = new Matrix4();
const _pos = new Vector3();
const _q = new Quaternion();
const _scale = new Vector3(1, 1, 1);

export class LocalTile3D {
  private group: Group;
  private floorMesh: InstancedMesh | null = null;
  private wallMesh: InstancedMesh | null = null;
  private workbenchMesh: InstancedMesh | null = null;
  private doorMesh: InstancedMesh | null = null;
  private furnitureMesh: InstancedMesh | null = null;
  private lastSignature = '';

  // Geometry/material cache (disposed on dispose())
  private geometries: BufferGeometry[] = [];
  private materials: Material[] = [];

  // Instance → tile mapping for picking
  instanceToTile: Map<number, { x: number; y: number }> = new Map();

  constructor() {
    this.group = new Group();
    this.group.name = 'local-tiles';
  }

  getGroup(): Group {
    return this.group;
  }

  /** Rebuild all InstancedMeshes if the world signature changed. */
  rebuild(world: LocalWorld): boolean {
    const sig = this.computeSignature(world);
    if (sig === this.lastSignature) return false;
    this.lastSignature = sig;

    this.disposeMeshes();
    this.instanceToTile.clear();
    this.buildFloorMesh(world);
    this.buildWallMesh(world);
    this.buildWorkbenchMesh(world);
    this.buildDoorMesh(world);
    this.buildFurnitureMesh(world);

    return true;
  }

  private computeSignature(world: LocalWorld): string {
    let tileHash = 0;
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (tile) tileHash = (tileHash * 31 + tile.type.charCodeAt(0)) | 0;
      }
    }
    return `${world.width}x${world.height}:${world.rooms.length}:${world.workbenches.length}:${tileHash}`;
  }

  // ─── Floor ──────────────────────────────────────────────────────────────────
  private buildFloorMesh(world: LocalWorld): void {
    const floorTiles: { x: number; y: number; color: number }[] = [];
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (!tile) continue;
        if (categorizeTile(tile) !== 'floor') continue;

        const room = tile.roomId ? world.rooms.find((r) => r.id === tile.roomId) : null;
        const color = room?.zoneType ? ZONE_FLOOR_COLORS[room.zoneType] ?? 0xb8b8b8 : 0xb8b8b8;
        floorTiles.push({ x, y, color });
      }
    }
    if (floorTiles.length === 0) return;

    const geom = new BoxGeometry(ISO_TILE_W, 2, ISO_TILE_W);
    const mat = new MeshStandardMaterial({ vertexColors: true });
    this.floorMesh = new InstancedMesh(geom, mat, floorTiles.length);
    this.floorMesh.receiveShadow = true;

    let instIdx = 0;
    for (const ft of floorTiles) {
      _pos.copy(localGridToWorld3D(ft.x, ft.y));
      _pos.y = 1; // floor surface at y=1 (half thickness of 2)
      _matrix.compose(_pos, _q, _scale);
      this.floorMesh.setMatrixAt(instIdx, _matrix);
      this.floorMesh.setColorAt(instIdx, new Color(ft.color));
      this.instanceToTile.set(instIdx, { x: ft.x, y: ft.y });
      instIdx++;
    }
    this.floorMesh.instanceMatrix.needsUpdate = true;
    if (this.floorMesh.instanceColor) this.floorMesh.instanceColor.needsUpdate = true;
    this.group.add(this.floorMesh);
    this.geometries.push(geom);
    this.materials.push(mat);
  }

  // ─── Walls ───────────────────────────────────────────────────────────────────
  private buildWallMesh(world: LocalWorld): void {
    const wallTiles: { x: number; y: number }[] = [];
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (!tile) continue;
        if (tile.type === 'wall') wallTiles.push({ x, y });
      }
    }
    if (wallTiles.length === 0) return;

    const geom = new BoxGeometry(ISO_TILE_W, ISO_WALL_H * 2, ISO_TILE_W);
    const mat = new MeshStandardMaterial({ color: 0xc8c8c8 });
    this.wallMesh = new InstancedMesh(geom, mat, wallTiles.length);
    this.wallMesh.castShadow = true;
    this.wallMesh.receiveShadow = true;

    wallTiles.forEach((wt, i) => {
      _pos.copy(localGridToWorld3D(wt.x, wt.y));
      _pos.y = ISO_WALL_H; // center at wall height
      _matrix.compose(_pos, _q, _scale);
      this.wallMesh!.setMatrixAt(i, _matrix);
    });
    this.wallMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.wallMesh);
    this.geometries.push(geom);
    this.materials.push(mat);
  }

  // ─── Workbenches ─────────────────────────────────────────────────────────────
  private buildWorkbenchMesh(world: LocalWorld): void {
    const wbTiles: { x: number; y: number; color: number }[] = [];
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (!tile || !tile.workbench) continue;
        const ext = tile.workbench.extension;
        const color = EXT_COLORS[ext] ?? 0x8a7a6a;
        wbTiles.push({ x, y, color });
      }
    }
    if (wbTiles.length === 0) return;

    const geom = new BoxGeometry(ISO_TILE_W * 0.7, 8, ISO_TILE_W * 0.7);
    const mat = new MeshStandardMaterial({ vertexColors: true });
    this.workbenchMesh = new InstancedMesh(geom, mat, wbTiles.length);
    this.workbenchMesh.castShadow = true;

    wbTiles.forEach((wb, i) => {
      _pos.copy(localGridToWorld3D(wb.x, wb.y));
      _pos.y = 4; // desk surface at y=4
      _matrix.compose(_pos, _q, _scale);
      this.workbenchMesh!.setMatrixAt(i, _matrix);
      this.workbenchMesh!.setColorAt(i, new Color(wb.color));
    });
    this.workbenchMesh.instanceMatrix.needsUpdate = true;
    if (this.workbenchMesh.instanceColor) this.workbenchMesh.instanceColor.needsUpdate = true;
    this.group.add(this.workbenchMesh);
    this.geometries.push(geom);
    this.materials.push(mat);
  }

  // ─── Doors ───────────────────────────────────────────────────────────────────
  private buildDoorMesh(world: LocalWorld): void {
    const doorTiles: { x: number; y: number }[] = [];
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (!tile) continue;
        if (tile.type === 'door') doorTiles.push({ x, y });
      }
    }
    if (doorTiles.length === 0) return;

    const geom = new BoxGeometry(ISO_TILE_W * 0.8, ISO_WALL_H * 1.5, ISO_TILE_W * 0.3);
    const mat = new MeshStandardMaterial({ color: 0xb89860 });
    this.doorMesh = new InstancedMesh(geom, mat, doorTiles.length);
    this.doorMesh.castShadow = true;

    doorTiles.forEach((dt, i) => {
      _pos.copy(localGridToWorld3D(dt.x, dt.y));
      _pos.y = ISO_WALL_H * 0.75;
      _matrix.compose(_pos, _q, _scale);
      this.doorMesh!.setMatrixAt(i, _matrix);
    });
    this.doorMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.doorMesh);
    this.geometries.push(geom);
    this.materials.push(mat);
  }

  // ─── Furniture (planter, whiteboard, server_rack, sofa, etc) ─────────────────
  private buildFurnitureMesh(world: LocalWorld): void {
    const furnitureTiles: { x: number; y: number; type: LocalTileType }[] = [];
    for (let y = 0; y < world.height; y++) {
      for (let x = 0; x < world.width; x++) {
        const tile = world.grid[y]?.[x];
        if (!tile) continue;
        if (categorizeTile(tile) === 'furniture') {
          furnitureTiles.push({ x, y, type: tile.type });
        }
      }
    }
    if (furnitureTiles.length === 0) return;

    // Use a single BoxGeometry as base, colored per-instance
    const geom = new BoxGeometry(ISO_TILE_W * 0.6, 16, ISO_TILE_W * 0.6);
    const mat = new MeshStandardMaterial({ vertexColors: true });
    this.furnitureMesh = new InstancedMesh(geom, mat, furnitureTiles.length);
    this.furnitureMesh.castShadow = true;

    const furnitureColors: Record<string, number> = {
      planter: 0x4a9e8e,
      whiteboard: 0xf0f0f0,
      server_rack: 0x7a8b9e,
      sofa: 0xc47a4a,
      watercooler: 0x5ba3d0,
      meeting_room: 0xd49b3a,
      phone_booth: 0x4a8f4a,
      break_area: 0xc47a4a,
      reception: 0xc4b8a0,
      stairs: 0xb0b0b0,
      cubicle_partition: 0xa8b0c0,
    };

    furnitureTiles.forEach((ft, i) => {
      _pos.copy(localGridToWorld3D(ft.x, ft.y));
      _pos.y = 8;
      _matrix.compose(_pos, _q, _scale);
      this.furnitureMesh!.setMatrixAt(i, _matrix);
      this.furnitureMesh!.setColorAt(i, new Color(furnitureColors[ft.type] ?? 0x888888));
    });
    this.furnitureMesh.instanceMatrix.needsUpdate = true;
    if (this.furnitureMesh.instanceColor) this.furnitureMesh.instanceColor.needsUpdate = true;
    this.group.add(this.furnitureMesh);
    this.geometries.push(geom);
    this.materials.push(mat);
  }

  // ─── Picking helpers ────────────────────────────────────────────────────────
  getFloorMesh(): InstancedMesh | null {
    return this.floorMesh;
  }

  resolveTileFromInstance(instanceId: number, world: LocalWorld): LocalTile | null {
    const pos = this.instanceToTile.get(instanceId);
    if (!pos) return null;
    return world.grid[pos.y]?.[pos.x] ?? null;
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────────
  private disposeMeshes(): void {
    while (this.group.children.length > 0) {
      const child = this.group.children[0]!;
      this.group.remove(child);
    }
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries = [];
    this.materials = [];
    this.floorMesh = null;
    this.wallMesh = null;
    this.workbenchMesh = null;
    this.doorMesh = null;
    this.furnitureMesh = null;
  }

  dispose(): void {
    this.disposeMeshes();
    this.lastSignature = '';
    this.instanceToTile.clear();
  }
}