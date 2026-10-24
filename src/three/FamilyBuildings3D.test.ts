import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture, Vector3 } from 'three';
import { HEX_SIZE } from '../constants.ts';
import {
  createFamilyBuilding,
  ensureFamilyBuildingsLoad,
  familyBuildingState,
  familyBuildingsSignature,
  isMemoryArchiveType,
  prepareFamilyBuilding,
} from './FamilyBuildings3D.ts';
import { FAMILY_BUILDING_ASSETS, FAMILY_BUILDING_IDS } from './familyBuildingAssets.ts';
import { familyBuildingForType, wonderModelForType } from './WonderProps3D.ts';

function source(): Group {
  const g = new Group();
  const material = new MeshStandardMaterial({ map: new Texture(), roughness: 0.72 });
  const mesh = new Mesh(new BoxGeometry(4, 8, 3), material);
  mesh.position.set(6, -3, 2);
  g.add(mesh);
  return g;
}

afterEach(() => vi.unstubAllEnvs());
describe('local Meshy family trial', () => {
  it('only matches explicit memory-family tokens, not all AI or unknown services', () => {
    for (const s of ['archive', 'MY-memory-service', 'bibliotheca', 'knowledge', 'wiki']) {
      expect(isMemoryArchiveType(s)).toBe(true);
    }
    for (const s of ['chat', 'ollama', 'prometheus', 'archiver', 'memoryless', '']) {
      expect(isMemoryArchiveType(s)).toBe(false);
    }
  });
  it('maps buildings only onto the existing wonder keyword buckets', () => {
    expect(familyBuildingForType('memory-archive')).toBe('memory-archive');
    expect(familyBuildingForType('grafana')).toBe('observatory');
    expect(familyBuildingForType('prometheus-local')).toBe('observatory');
    expect(familyBuildingForType('ml-lab')).toBe('research-laboratory');
    expect(familyBuildingForType('duckdb')).toBe('artifact-vault');
    expect(familyBuildingForType('airflow')).toBe('coordination-court');
    expect(familyBuildingForType('ghostdesk')).toBe('connection-gateway');
    for (const s of ['docker', 'ci', 'gpu-worker']) {
      expect(familyBuildingForType(s)).toBe('execution-workshop');
    }
    // AI services keep their Kenney wizard-tower model.
    for (const s of ['ollama', 'claude']) {
      expect(familyBuildingForType(s)).toBeNull();
      expect(wonderModelForType(s)).toBe('building-wizard-tower');
    }
    expect(familyBuildingForType('gitlab')).toBe('connection-gateway');
  });
  it('lists all eight approved family buildings and verifies public GLBs exist on disk', () => {
    expect(FAMILY_BUILDING_IDS).toContain('execution-workshop');
    expect(FAMILY_BUILDING_IDS).toContain('civic-plaza');
    expect([...FAMILY_BUILDING_IDS].sort()).toEqual(Object.keys(FAMILY_BUILDING_ASSETS).sort());
    for (const { path, materials } of Object.values(FAMILY_BUILDING_ASSETS)) {
      expect(path.startsWith('assets/3d/props/meshy/')).toBe(true);
      expect(path).toMatch(/-map\.glb$/);
      expect(materials).toBe('approved');
      expect(existsSync(`public/${path}`), `public/${path}`).toBe(true);
    }
  });
  it('centers and grounds the building within the actual terrain footprint', () => {
    const normalized = prepareFamilyBuilding(source(), 'observatory');
    const b = new Box3().setFromObject(normalized);
    const size = b.getSize(new Vector3());
    expect(normalized.name).toBe('wonder-observatory');
    expect(b.min.y).toBeCloseTo(0);
    expect(b.getCenter(new Vector3()).x).toBeCloseTo(0);
    expect(b.getCenter(new Vector3()).z).toBeCloseTo(0);
    expect(Math.hypot(size.x, size.z)).toBeLessThanOrEqual(HEX_SIZE * 0.50001);
    expect(size.y).toBeLessThanOrEqual(HEX_SIZE * 0.62001);
  });
  it('keeps authored textures but isolates disposable instance geometry and materials', () => {
    const original = source();
    const a = prepareFamilyBuilding(original, 'memory-archive');
    const b = prepareFamilyBuilding(original, 'memory-archive');
    const meshes: Mesh[] = [];
    a.traverse((o) => {
      if (o instanceof Mesh) meshes.push(o);
    });
    b.traverse((o) => {
      if (o instanceof Mesh) meshes.push(o);
    });
    const first = meshes[0]!;
    const second = meshes[1]!;
    expect(first.geometry).not.toBe(second.geometry);
    expect(first.material).not.toBe(second.material);
    expect((first.material as MeshStandardMaterial).map).toBe(
      (second.material as MeshStandardMaterial).map,
    );
    // No tint: the authored material values survive the clone untouched.
    expect((first.material as MeshStandardMaterial).color.getHex()).toBe(0xffffff);
    expect((first.material as MeshStandardMaterial).roughness).toBe(0.72);
    expect(first.castShadow && first.receiveShadow).toBe(true);
    expect(original.children[0]!.position.y).toBe(-3);
  });
  it('rejects an empty scene', () => {
    expect(() => prepareFamilyBuilding(new Group(), 'artifact-vault')).toThrow('finite volume');
  });
  it('does not load or override anything without explicit opt-in', () => {
    vi.stubEnv('VITE_MESHY_PREVIEW', '0');
    ensureFamilyBuildingsLoad();
    for (const id of FAMILY_BUILDING_IDS) expect(familyBuildingState(id)).toBe('idle');
    expect(familyBuildingsSignature()).toBe('i'.repeat(FAMILY_BUILDING_IDS.length));
    expect(createFamilyBuilding('memory-archive')).toBeNull();
    expect(createFamilyBuilding(null)).toBeNull();
  });
});
