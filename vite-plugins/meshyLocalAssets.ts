// ─── Local-only Meshy family assets ──────────────────────────────────────────
// The knowledge-city buildings are license-pending Meshy output kept in
// Git-ignored assets-src/. They must never be bundled into dist/ or public/.
// With VITE_MESHY_PREVIEW=1 this plugin serves exactly the runtime copies listed
// in src/three/familyBuildingAssets.ts to the dev server AND to `vite preview`,
// so a built bundle can be tested on loopback without copying binaries.
//
// Responses carry a content-hash ETag and `Cache-Control: no-cache`: the browser
// revalidates every load, so a regenerated GLB can never be served stale.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connect, Plugin } from 'vite';
import { FAMILY_BUILDING_ASSETS } from '../src/three/familyBuildingAssets.ts';

export function familyAssetPaths(): Set<string> {
  return new Set(Object.values(FAMILY_BUILDING_ASSETS).map((a) => `/${a.path}`));
}

export function meshyLocalAssetsMiddleware(root: string): Connect.NextHandleFunction {
  const allowed = familyAssetPaths();
  return (req, res, next) => {
    const path = (req.url ?? '').split('?')[0]!;
    if (!allowed.has(path) || (req.method !== 'GET' && req.method !== 'HEAD')) {
      next();
      return;
    }
    const rel = path.slice(1);
    readFile(join(root, 'public', rel))
      .catch(() => readFile(join(root, rel)))
      .then((body) => {
        const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'model/gltf-binary');
        res.setHeader('Content-Length', String(body.length));
        res.statusCode = 200;
        res.end(req.method === 'HEAD' ? undefined : body);
      })
      .catch(() => {
        // Missing local copy: the renderer keeps its ordinary wonder model.
        res.statusCode = 404;
        res.end();
      });
  };
}

export function meshyLocalAssets(root: string, enabled: boolean): Plugin {
  return {
    name: 'repociv-meshy-local-assets',
    apply: () => enabled,
    configureServer(server) {
      server.middlewares.use(meshyLocalAssetsMiddleware(root));
    },
    configurePreviewServer(server) {
      server.middlewares.use(meshyLocalAssetsMiddleware(root));
    },
  };
}
