import { describe, expect, it, vi, afterEach } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture, Vector3 } from 'three';
import { HEX_SIZE } from '../constants.ts';
import {
  createMemoryArchive,
  ensureMemoryArchiveLoad,
  isMemoryArchiveType,
  memoryArchiveState,
  prepareMemoryArchive,
} from './MemoryArchive3D.ts';

function source(): Group {
  const g = new Group();
  const material = new MeshStandardMaterial({ map: new Texture(), roughness: 0.72 });
  const mesh = new Mesh(new BoxGeometry(4, 8, 3), material);
  mesh.position.set(6, -3, 2);
  g.add(mesh);
  return g;
}

afterEach(() => vi.unstubAllEnvs());
describe('local Meshy memory archive trial', () => {
  it('only matches explicit memory-family tokens, not all AI or unknown services', () => {
    for (const s of ['archive', 'MY-memory-service', 'bibliotheca', 'knowledge', 'wiki']) {
      expect(isMemoryArchiveType(s)).toBe(true);
    }
    for (const s of ['chat', 'ollama', 'prometheus', 'archiver', 'memoryless', '']) {
      expect(isMemoryArchiveType(s)).toBe(false);
    }
  });
  it('centers and grounds the building within the actual terrain footprint', () => {
    const normalized = prepareMemoryArchive(source());
    const b = new Box3().setFromObject(normalized);
    const size = b.getSize(new Vector3());
    expect(b.min.y).toBeCloseTo(0);
    expect(b.getCenter(new Vector3()).x).toBeCloseTo(0);
    expect(b.getCenter(new Vector3()).z).toBeCloseTo(0);
    expect(Math.hypot(size.x, size.z)).toBeLessThanOrEqual(HEX_SIZE * 0.50001);
    expect(size.y).toBeLessThanOrEqual(HEX_SIZE * 0.62001);
  });
  it('keeps authored textures but isolates disposable instance geometry and materials', () => {
    const original = source();
    const a = prepareMemoryArchive(original);
    const b = prepareMemoryArchive(original);
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
    expect(first.castShadow && first.receiveShadow).toBe(true);
    expect(original.children[0]!.position.y).toBe(-3);
  });
  it('rejects an empty scene', () => {
    expect(() => prepareMemoryArchive(new Group())).toThrow('finite volume');
  });
  it('does not load or override anything without explicit dev opt-in', () => {
    vi.stubEnv('VITE_MESHY_PREVIEW', '0');
    ensureMemoryArchiveLoad();
    expect(memoryArchiveState()).toBe('idle');
    expect(createMemoryArchive('memory')).toBeNull();
  });
});
