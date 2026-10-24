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
  return import('./CityWalls3D.ts');
}

function scene(): Group {
  const g = new Group();
  g.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
  return g;
}

describe('knowledge-city wall overlay loading', () => {
  it('loads only KayKit when VITE_MESHY_PREVIEW=0', async () => {
    const module = await fresh('0');
    const load = vi
      .spyOn(GLTFLoader.prototype, 'loadAsync')
      .mockResolvedValue({ scene: scene() } as never);
    const settled = vi.fn();
    module.ensureCityWallsLoad(settled);
    await vi.waitFor(() => expect(module.areCityWallsSettled()).toBe(true));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(load.mock.calls.every((c) => String(c[0]).includes('/kaykit/'))).toBe(true);
    expect(load.mock.calls.some((c) => String(c[0]).includes('/knowledge-city/'))).toBe(false);
  });

  it('overlays the four knowledge-city GLBs when preview is enabled', async () => {
    const module = await fresh('1');
    const load = vi
      .spyOn(GLTFLoader.prototype, 'loadAsync')
      .mockResolvedValue({ scene: scene() } as never);
    module.ensureCityWallsLoad();
    await vi.waitFor(() => expect(module.areCityWallsReady()).toBe(true));
    const urls = Object.values(module.KNOWLEDGE_CITY_WALL_URLS);
    expect(urls).toHaveLength(4);
    for (const url of urls) {
      expect(
        load.mock.calls.some((c) => c[0] === url),
        url,
      ).toBe(true);
    }
    expect(load.mock.calls.filter((c) => String(c[0]).includes('/kaykit/')).length).toBe(6);
  });

  it('keeps KayKit if a knowledge-city overlay is missing', async () => {
    const module = await fresh();
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation((url: string) => {
      if (url.includes('wall-gate.glb')) return Promise.reject(new Error('missing'));
      return Promise.resolve({ scene: scene() } as never);
    });
    module.ensureCityWallsLoad();
    await vi.waitFor(() => expect(module.areCityWallsReady()).toBe(true));
  });
});
