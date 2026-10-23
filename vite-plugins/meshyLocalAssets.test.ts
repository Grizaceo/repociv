import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  familyAssetPaths,
  meshyLocalAssets,
  meshyLocalAssetsMiddleware,
} from './meshyLocalAssets.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function call(root: string, url: string, headers: Record<string, string> = {}) {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as Buffer | undefined,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
    end(b?: Buffer) {
      this.body = b;
      done();
    },
  };
  let done = () => {};
  let passed = false;
  const finished = new Promise<void>((resolve) => (done = resolve));
  meshyLocalAssetsMiddleware(root)({ url, method: 'GET', headers } as never, res as never, () => {
    passed = true;
    done();
  });
  await finished;
  return { res, passed };
}

describe('meshyLocalAssets', () => {
  it('is inactive unless explicitly enabled', () => {
    const off = meshyLocalAssets('/x', false);
    const on = meshyLocalAssets('/x', true);
    expect((off.apply as () => boolean)()).toBe(false);
    expect((on.apply as () => boolean)()).toBe(true);
  });
  it('serves only allowlisted runtime copies with a revalidating content hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meshy-assets-'));
    roots.push(root);
    const [path] = [...familyAssetPaths()];
    await mkdir(join(root, path!.slice(1), '..'), { recursive: true });
    await writeFile(join(root, path!.slice(1)), Buffer.from('glTF-local'));
    const ok = await call(root, `${path}?v=1`);
    expect(ok.res.statusCode).toBe(200);
    expect(ok.res.headers['cache-control']).toBe('no-cache');
    expect(ok.res.headers['content-type']).toBe('model/gltf-binary');
    expect(ok.res.body?.toString()).toBe('glTF-local');
    const cached = await call(root, path!, { 'if-none-match': ok.res.headers['etag']! });
    expect(cached.res.statusCode).toBe(304);
    await writeFile(join(root, path!.slice(1)), Buffer.from('glTF-regenerated'));
    const changed = await call(root, path!, { 'if-none-match': ok.res.headers['etag']! });
    expect(changed.res.statusCode).toBe(200);
  });
  it('passes through non-allowlisted paths, including sibling Meshy sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meshy-assets-'));
    roots.push(root);
    for (const url of [
      '/assets-src/meshy/execution-workshop/geometry/preview.glb',
      '/assets-src/meshy/civic-plaza/texture-v001/textured.glb',
      '/assets-src/meshy/memory-archive/textured/archive-map.glb/../../spec.json',
      '/index.html',
    ]) {
      expect((await call(root, url)).passed).toBe(true);
    }
  });
  it('answers 404 for a missing allowlisted copy so the renderer falls back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meshy-assets-'));
    roots.push(root);
    const [path] = [...familyAssetPaths()];
    expect((await call(root, path!)).res.statusCode).toBe(404);
  });
});
