import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fresh(flag = '1') {
  vi.resetModules();
  vi.stubEnv('VITE_MESHY_PREVIEW', flag);
  return import('./FamilyBuildings3D.ts');
}
function scene(): Group {
  const g = new Group();
  g.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
  return g;
}
describe('family asynchronous loading', () => {
  it('skips loading when explicitly disabled with VITE_MESHY_PREVIEW=0', async () => {
    const module = await fresh('0');
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync');
    module.ensureFamilyBuildingsLoad();
    expect(load).not.toHaveBeenCalled();
    expect(module.familyBuildingState('memory-archive')).toBe('idle');
  });
  it('requests each allowlisted runtime copy exactly once', async () => {
    const module = await fresh();
    const load = vi
      .spyOn(GLTFLoader.prototype, 'loadAsync')
      .mockResolvedValue({ scene: scene() } as never);
    module.ensureFamilyBuildingsLoad();
    module.ensureFamilyBuildingsLoad();
    const { FAMILY_BUILDING_IDS, familyBuildingUrl } = await import('./familyBuildingAssets.ts');
    await vi.waitFor(() => expect(module.familyBuildingsLoading()).toBe(false));
    expect(load).toHaveBeenCalledTimes(FAMILY_BUILDING_IDS.length);
    expect(load.mock.calls.map((c) => c[0]).sort()).toEqual(
      FAMILY_BUILDING_IDS.map(familyBuildingUrl).sort(),
    );
    expect(module.createFamilyBuilding('coordination-court')?.name).toBe(
      'wonder-coordination-court',
    );
  });
  it('settles one failure without hiding the others, keeping the ordinary wonder', async () => {
    const module = await fresh();
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation((url: string) =>
      url.includes('artifact-vault')
        ? Promise.reject(new Error('missing'))
        : Promise.resolve({ scene: scene() } as never),
    );
    const settled = vi.fn();
    module.ensureFamilyBuildingsLoad(settled);
    await vi.waitFor(() => expect(module.familyBuildingsLoading()).toBe(false));
    expect(module.familyBuildingState('artifact-vault')).toBe('failed');
    expect(module.familyBuildingState('memory-archive')).toBe('ready');
    expect(module.createFamilyBuilding('artifact-vault')).toBeNull();
    expect(module.createFamilyBuilding('memory-archive')?.name).toBe('wonder-memory-archive');
    expect(settled).toHaveBeenCalledTimes(8);
    expect(module.familyBuildingsSignature()).toContain('f');
  });
});
