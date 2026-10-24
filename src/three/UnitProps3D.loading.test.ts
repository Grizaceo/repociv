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
  return import('./UnitProps3D.ts');
}

function scene(meshes = 1): Group {
  const g = new Group();
  for (let i = 0; i < meshes; i++) {
    g.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
  }
  return g;
}

describe('knowledge-city unit overlay loading', () => {
  it('loads only Phase 5 figurines when VITE_MESHY_PREVIEW=0', async () => {
    const module = await fresh('0');
    const load = vi
      .spyOn(GLTFLoader.prototype, 'loadAsync')
      .mockResolvedValue({ scene: scene(2) } as never);
    const settled = vi.fn();
    module.ensureUnitPropsLoad(settled);
    await vi.waitFor(() => expect(module.areUnitPropsSettled()).toBe(true));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(load.mock.calls.some((c) => String(c[0]).includes('/knowledge-city/'))).toBe(false);
    expect(load.mock.calls.some((c) => String(c[0]).includes('/meshy/unit-'))).toBe(false);
    expect(load.mock.calls.some((c) => String(c[0]).includes('/units/unit-mage.glb'))).toBe(true);
    expect(module.getUnitRoleSource('unit-mage')).toBe('/assets/3d/props/units/unit-mage.glb');
  });

  it('overlays the four knowledge-city figurines when preview is enabled', async () => {
    const module = await fresh('1');
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation((url: string) => {
      const overlay = Object.values(module.KNOWLEDGE_CITY_UNIT_URLS).includes(url);
      return Promise.resolve({ scene: scene(overlay ? 1 : 2) } as never);
    });
    module.ensureUnitPropsLoad();
    await vi.waitFor(() => expect(module.areUnitPropsReady()).toBe(true));
    const urls = Object.values(module.KNOWLEDGE_CITY_UNIT_URLS);
    expect(urls).toHaveLength(4);
    for (const url of urls) {
      expect(
        load.mock.calls.some((c) => c[0] === url),
        url,
      ).toBe(true);
    }
    expect(module.getUnitPropPartsForType('hero')?.length).toBe(1);
    expect(module.getUnitPropPartsForType('worker')?.length).toBe(1);
    expect(module.getUnitPropPartsForType('scout')?.length).toBe(1);
    expect(module.getUnitPropPartsForType('praetorian')?.length).toBe(1);
    expect(module.getUnitRoleSource('unit-mage')).toBe(module.KNOWLEDGE_CITY_UNIT_URLS['unit-mage']);
    expect(module.getUnitRoleSource('unit-engineer')).toBe(
      module.KNOWLEDGE_CITY_UNIT_URLS['unit-engineer'],
    );
    expect(module.getUnitRoleSource('unit-rogue')).toBe(module.KNOWLEDGE_CITY_UNIT_URLS['unit-rogue']);
    expect(module.getUnitRoleSource('unit-knight')).toBe(
      module.KNOWLEDGE_CITY_UNIT_URLS['unit-knight'],
    );
  });

  it('keeps overlay even if a Phase 5 role GLB finishes after overlay would have', async () => {
    const module = await fresh('1');
    let releaseMage!: () => void;
    const mageGate = new Promise<void>((resolve) => {
      releaseMage = resolve;
    });
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation((url: string) => {
      const overlay = Object.values(module.KNOWLEDGE_CITY_UNIT_URLS).includes(url);
      const result = { scene: scene(overlay ? 1 : 2) } as never;
      if (url.includes('/units/unit-mage.glb')) {
        return mageGate.then(() => result);
      }
      return Promise.resolve(result);
    });
    module.ensureUnitPropsLoad();
    await Promise.resolve();
    const overlayUrls = Object.values(module.KNOWLEDGE_CITY_UNIT_URLS);
    expect(
      vi.mocked(GLTFLoader.prototype.loadAsync).mock.calls.some((c) => overlayUrls.includes(c[0])),
    ).toBe(false);
    releaseMage();
    await vi.waitFor(() => expect(module.areUnitPropsReady()).toBe(true));
    expect(module.getUnitPropPartsForType('hero')?.length).toBe(1);
  });

  it('keeps Phase 5 if a knowledge-city overlay is missing', async () => {
    const module = await fresh();
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation((url: string) => {
      if (url.includes('unit-coordinator-map.glb')) return Promise.reject(new Error('missing'));
      const overlay = Object.values(module.KNOWLEDGE_CITY_UNIT_URLS).includes(url);
      return Promise.resolve({ scene: scene(overlay ? 1 : 2) } as never);
    });
    module.ensureUnitPropsLoad();
    await vi.waitFor(() => expect(module.areUnitPropsReady()).toBe(true));
    expect(module.getUnitPropPartsForType('hero')?.length).toBe(2);
    expect(module.getUnitPropPartsForType('worker')?.length).toBe(1);
    expect(module.getUnitRoleSource('unit-mage')).toBe('/assets/3d/props/units/unit-mage.glb');
    expect(module.getUnitRoleSource('unit-engineer')).toBe(
      module.KNOWLEDGE_CITY_UNIT_URLS['unit-engineer'],
    );
  });
});
