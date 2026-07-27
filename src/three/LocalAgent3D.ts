// ─── RepoCiv — Local Agent 3D (agent figurines for local view) ──────────────
// Reuses the GLB figurine pattern from UnitMesh3D for local-view agents.
// Each agent gets a Mesh with body + head, position updated per-frame.

import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type BufferGeometry,
  type Material,
} from 'three';
import type { LocalUnit } from '../types.ts';
import { localGridToWorld3D } from './LocalCamera3D.ts';

export class LocalAgent3D {
  private group: Group;
  private agentMeshes: Map<string, Mesh> = new Map();
  private geometries: BufferGeometry[] = [];
  private materials: Material[] = [];

  constructor() {
    this.group = new Group();
    this.group.name = 'local-agents';
  }

  getGroup(): Group {
    return this.group;
  }

  /** Update all agent meshes. Creates/removes meshes as needed. */
  update(units: LocalUnit[]): void {
    const activeIds = new Set(units.map((u) => u.id));

    // Remove meshes for departed units
    for (const [id, mesh] of this.agentMeshes) {
      if (!activeIds.has(id)) {
        this.group.remove(mesh);
        this.agentMeshes.delete(id);
      }
    }

    // Create or update meshes
    for (const unit of units) {
      let mesh = this.agentMeshes.get(unit.id);
      if (!mesh) {
        mesh = this.createAgentMesh(unit);
        this.group.add(mesh);
        this.agentMeshes.set(unit.id, mesh);
      }

      // Update position from grid coords
      const worldPos = localGridToWorld3D(unit.gridX, unit.gridY);
      mesh.position.set(worldPos.x, worldPos.y, worldPos.z);

      // Update color
      const material = mesh.material as MeshStandardMaterial;
      const targetColor = unit.color;
      if (material.color.getHexString() !== targetColor.replace('#', '')) {
        material.color.set(targetColor);
      }

      // Despawn fade
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
  }

  private createAgentMesh(unit: LocalUnit): Mesh {
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

    // Use an invisible wrapper Mesh as the parent
    const wrapper = new Mesh(new BoxGeometry(0.01, 0.01, 0.01), bodyMat);
    wrapper.visible = false;
    wrapper.add(body);
    wrapper.add(head);

    this.geometries.push(bodyGeom, headGeom);
    this.materials.push(bodyMat, headMat);

    return wrapper;
  }

  /** Get all agent meshes for raycast picking. */
  getAgentMeshes(): Map<string, Mesh> {
    return this.agentMeshes;
  }

  dispose(): void {
    while (this.group.children.length > 0) {
      const child = this.group.children[0]!;
      this.group.remove(child);
    }
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries = [];
    this.materials = [];
    this.agentMeshes.clear();
  }
}