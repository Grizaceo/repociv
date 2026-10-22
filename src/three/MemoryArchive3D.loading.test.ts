import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fresh() {
  vi.resetModules();
  vi.stubEnv('DEV', true);
  vi.stubEnv('VITE_MESHY_PREVIEW', '1');
  return import('./MemoryArchive3D.ts');
}
describe('archive asynchronous loading', () => {
  it('never requests preview assets in production even if enabled', async () => {
    const module = await fresh();
    vi.stubEnv('DEV', false);
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync');
    module.ensureMemoryArchiveLoad();
    expect(load).not.toHaveBeenCalled();
    expect(module.memoryArchiveState()).toBe('idle');
  });
  it('settles failure once, keeping the ordinary wonder available', async () => {
    const module = await fresh();
    const load = vi
      .spyOn(GLTFLoader.prototype, 'loadAsync')
      .mockRejectedValue(new Error('missing'));
    const settled = vi.fn();
    module.ensureMemoryArchiveLoad(settled);
    module.ensureMemoryArchiveLoad(settled);
    await vi.waitFor(() => expect(module.memoryArchiveState()).toBe('failed'));
    expect(load).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(module.createMemoryArchive('archive')).toBeNull();
  });
  it('loads once and publishes the model only for memory-family wonders', async () => {
    const module = await fresh();
    const scene = new Group();
    scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ scene } as never);
    module.ensureMemoryArchiveLoad();
    await vi.waitFor(() => expect(module.memoryArchiveState()).toBe('ready'));
    expect(load).toHaveBeenCalledTimes(1);
    expect(module.createMemoryArchive('archive')?.name).toBe('wonder-memory-archive');
    expect(module.createMemoryArchive('grafana')).toBeNull();
  });
});
