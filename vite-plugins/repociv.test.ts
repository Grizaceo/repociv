import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Connect } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SKIP_DIRS,
  countFiles,
  expandUser,
  repocivPlugin,
  resolveRepoPathFromId,
  scanRepoPath,
} from './repociv.ts';
import { decodeRepoId, encodeRepoId, type RepoRootsState } from './repoRootsState.ts';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'repociv-vite-plugin-'));
  const mapRoot = join(root, 'workspace');
  const repoA = join(mapRoot, 'repo-a');
  const outside = join(root, 'outside');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(repoA, 'main.ts'), 'export {};\n');
  mkdirSync(join(repoA, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(repoA, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(repoA, '.hidden.ts'), 'export {};\n');
  return { root, mapRoot, repoA, outside };
}

type MockResponse = {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  setHeader: (name: string, value: string) => void;
  end: (body: string) => void;
};

function mockRequest(
  method: string,
  url: string,
  body?: string,
  headers: Record<string, string> = {},
): Connect.IncomingMessage {
  const req = new EventEmitter() as Connect.IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers =
    method === 'POST'
      ? {
          host: '127.0.0.1:5273',
          origin: 'http://127.0.0.1:5273',
          'content-type': 'application/json',
          ...headers,
        }
      : { host: '127.0.0.1:5273', ...headers };
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: '',
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    },
  };
  return res;
}

async function invokeHandler(
  handler: Connect.NextHandleFunction,
  method: string,
  url: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<MockResponse> {
  const req = mockRequest(method, url, body, headers);
  const res = mockResponse();
  let nextCalled = false;
  await handler(req, res as unknown as Connect.ServerResponse, () => {
    nextCalled = true;
  });
  expect(nextCalled).toBe(false);
  return res;
}

function createPluginHandler(
  mapRoot: string,
  saveStateOverride?: (state: RepoRootsState) => RepoRootsState,
): Connect.NextHandleFunction {
  const plugin = repocivPlugin(
    mapRoot,
    saveStateOverride ? { saveState: saveStateOverride } : undefined,
  );
  let captured: Connect.NextHandleFunction | undefined;
  plugin.configureServer!({
    middlewares: {
      use: (fn: Connect.NextHandleFunction) => {
        captured = fn;
      },
    },
    ws: { send: () => {} },
  } as never);
  if (!captured) throw new Error('middleware not registered');
  return captured;
}

describe('repociv path helpers', () => {
  let fixture: ReturnType<typeof makeFixture>;
  const prevStateFile = process.env['REPOCIV_STATE_FILE'];

  beforeEach(() => {
    fixture = makeFixture();
    process.env['REPOCIV_STATE_FILE'] = join(fixture.root, 'state.json');
  });

  afterEach(() => {
    if (prevStateFile === undefined) delete process.env['REPOCIV_STATE_FILE'];
    else process.env['REPOCIV_STATE_FILE'] = prevStateFile;
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('expands tilde paths', () => {
    expect(expandUser('~')).toBe(homedir());
    expect(expandUser('~/projects')).toBe(join(homedir(), 'projects'));
  });

  it('scanRepoPath encodes absolute repo paths as repo ids', () => {
    const scanned = scanRepoPath(fixture.repoA, fixture.mapRoot);
    expect(scanned.path).toBe(encodeRepoId(resolve(fixture.repoA)));
    expect(decodeRepoId(scanned.path)).toBe(resolve(fixture.repoA));
    expect(scanned.name).toBe('repo-a');
    expect(scanned.rootPath).toBe(resolve(fixture.mapRoot));
  });

  it('countFiles skips configured dirs, dot entries, and deep trees', () => {
    const exts: Record<string, number> = {};
    const total = countFiles(fixture.repoA, exts);
    expect(total).toBe(1);
    expect(exts.ts).toBe(1);
    expect(SKIP_DIRS.has('node_modules')).toBe(true);
  });

  it('resolveRepoPathFromId rejects traversal in plain repo names', () => {
    const mapRoot = resolve(fixture.mapRoot);
    expect(resolveRepoPathFromId('../outside', mapRoot)).toBeNull();
    expect(resolveRepoPathFromId('..\\outside', mapRoot)).toBeNull();
    expect(resolveRepoPathFromId('nested/repo', mapRoot)).toBeNull();
    expect(resolveRepoPathFromId(encodeURIComponent('../outside'), mapRoot)).toBeNull();
  });

  it('resolveRepoPathFromId resolves encoded ids and plain folder names under map root', () => {
    const mapRoot = resolve(fixture.mapRoot);
    expect(resolveRepoPathFromId(encodeRepoId(fixture.repoA), mapRoot)).toBe(
      resolve(fixture.repoA),
    );
    expect(resolveRepoPathFromId('repo-a', mapRoot)).toBe(resolve(fixture.repoA));
  });

  it('resolveRepoPathFromId never accepts an encoded repo outside configured roots', () => {
    const mapRoot = resolve(fixture.mapRoot);
    expect(resolveRepoPathFromId('outside', mapRoot)).toBeNull();
    expect(resolveRepoPathFromId(encodeRepoId(fixture.outside), mapRoot)).toBeNull();
  });
});

describe('repociv API handlers', () => {
  let fixture: ReturnType<typeof makeFixture>;
  let handler: Connect.NextHandleFunction;
  const prevStateFile = process.env['REPOCIV_STATE_FILE'];
  const prevTokens = {
    REPOCIV_TOKEN: process.env['REPOCIV_TOKEN'],
    VITE_REPOCIV_TOKEN: process.env['VITE_REPOCIV_TOKEN'],
    VITE_BRIDGE_TOKEN: process.env['VITE_BRIDGE_TOKEN'],
  };

  beforeEach(() => {
    fixture = makeFixture();
    process.env['REPOCIV_STATE_FILE'] = join(fixture.root, 'state.json');
    delete process.env['REPOCIV_TOKEN'];
    delete process.env['VITE_REPOCIV_TOKEN'];
    delete process.env['VITE_BRIDGE_TOKEN'];
    handler = createPluginHandler(fixture.mapRoot);
  });

  afterEach(() => {
    if (prevStateFile === undefined) delete process.env['REPOCIV_STATE_FILE'];
    else process.env['REPOCIV_STATE_FILE'] = prevStateFile;
    for (const [name, value] of Object.entries(prevTokens)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('GET returns the active map root', async () => {
    const res = await invokeHandler(handler, 'GET', '/api/map-root');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ path: resolve(fixture.mapRoot) });
  });

  it('POST rejects empty, missing, and non-directory paths', async () => {
    const empty = await invokeHandler(
      handler,
      'POST',
      '/api/map-root',
      JSON.stringify({ path: '  ' }),
    );
    expect(empty.statusCode).toBe(400);
    expect(JSON.parse(empty.body).error).toBe('path requerido');

    const missing = await invokeHandler(
      handler,
      'POST',
      '/api/map-root',
      JSON.stringify({ path: join(fixture.root, 'missing-dir') }),
    );
    expect(missing.statusCode).toBe(400);
    expect(JSON.parse(missing.body).error).toBe('path no es carpeta valida');

    const filePath = join(fixture.mapRoot, 'not-a-dir.txt');
    writeFileSync(filePath, 'nope');
    const notDir = await invokeHandler(
      handler,
      'POST',
      '/api/map-root',
      JSON.stringify({ path: filePath }),
    );
    expect(notDir.statusCode).toBe(400);
    expect(JSON.parse(notDir.body).error).toBe('path no es carpeta valida');
  });

  it('POST /event relays same-origin JSON without wildcard CORS', async () => {
    const res = await invokeHandler(
      handler,
      'POST',
      '/event',
      JSON.stringify({ type: 'mission_start', missionId: 'm-1' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('POST accepts a valid directory and persists it as active root', async () => {
    const res = await invokeHandler(
      handler,
      'POST',
      '/api/map-root',
      JSON.stringify({ path: fixture.outside }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe(resolve(fixture.outside));

    const getRes = await invokeHandler(handler, 'GET', '/api/map-root');
    expect(JSON.parse(getRes.body).path).toBe(resolve(fixture.outside));
  });

  it('POST /api/repo/inspect previews eligible siblings under the parent folder', async () => {
    const repoB = join(fixture.mapRoot, 'repo-b');
    mkdirSync(repoB, { recursive: true });
    mkdirSync(join(fixture.mapRoot, 'node_modules'), { recursive: true });
    mkdirSync(join(fixture.mapRoot, 'dist'), { recursive: true });
    mkdirSync(join(fixture.mapRoot, 'coverage'), { recursive: true });
    mkdirSync(join(fixture.mapRoot, '.hidden-repo'), { recursive: true });
    const outside = join(fixture.root, 'outside-repo');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(fixture.mapRoot, 'linked-outside'), 'dir');

    const res = await invokeHandler(
      handler,
      'POST',
      '/api/repo/inspect',
      JSON.stringify({ path: fixture.repoA }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      repo: { repoPath: string };
      parentMap: { rootPath: string; repos: Array<{ name: string; repoPath: string }> };
    };
    expect(body.repo.repoPath).toBe(resolve(fixture.repoA));
    expect(body.parentMap.rootPath).toBe(resolve(fixture.mapRoot));
    expect(body.parentMap.repos.map((repo) => repo.name).sort()).toEqual(['repo-a', 'repo-b']);
  });

  it('requires the configured token for the parent-map mutation', async () => {
    const previousToken = process.env['REPOCIV_TOKEN'];
    const token = `test-${'x'.repeat(32)}`;
    process.env['REPOCIV_TOKEN'] = token;
    try {
      const tokenHandler = createPluginHandler(fixture.mapRoot);
      const body = JSON.stringify({ path: fixture.repoA });

      const missing = await invokeHandler(tokenHandler, 'POST', '/api/map-from-parent', body);
      expect(missing.statusCode).toBe(401);

      const invalid = await invokeHandler(tokenHandler, 'POST', '/api/map-from-parent', body, {
        'x-repociv-token': 'wrong-token',
      });
      expect(invalid.statusCode).toBe(401);

      const valid = await invokeHandler(tokenHandler, 'POST', '/api/map-from-parent', body, {
        'x-repociv-token': token,
      });
      expect(valid.statusCode).toBe(200);
    } finally {
      if (previousToken === undefined) delete process.env['REPOCIV_TOKEN'];
      else process.env['REPOCIV_TOKEN'] = previousToken;
    }
  });

  it.each(['/api/repo/inspect', '/api/map-from-parent'])(
    'rejects malformed JSON and non-string paths on %s',
    async (endpoint) => {
      const malformed = await invokeHandler(handler, 'POST', endpoint, '{');
      expect(malformed.statusCode).toBe(400);
      expect(JSON.parse(malformed.body).error).toBe('JSON invalido');

      const wrongType = await invokeHandler(
        handler,
        'POST',
        endpoint,
        JSON.stringify({ path: 42 }),
      );
      expect(wrongType.statusCode).toBe(400);
      expect(JSON.parse(wrongType.body).error).toBe('path debe ser string');
    },
  );

  it('POST /api/map-from-parent atomically activates the parent and selects its children', async () => {
    const seeded = await invokeHandler(
      handler,
      'POST',
      '/api/repo-selections',
      JSON.stringify({ rootPath: fixture.mapRoot, selectedRepoPaths: [fixture.repoA] }),
    );
    expect(seeded.statusCode).toBe(200);

    const collectionRoot = join(fixture.root, 'collection');
    const repoOne = join(collectionRoot, 'one');
    const repoTwo = join(collectionRoot, 'two');
    mkdirSync(repoOne, { recursive: true });
    mkdirSync(repoTwo, { recursive: true });
    mkdirSync(join(collectionRoot, 'node_modules'), { recursive: true });

    const res = await invokeHandler(
      handler,
      'POST',
      '/api/map-from-parent',
      JSON.stringify({ path: repoOne }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      rootPath: string;
      selectedRepoIds: string[];
      selectedRepoPaths: string[];
    };
    expect(body.rootPath).toBe(resolve(collectionRoot));
    expect(body.selectedRepoPaths.sort()).toEqual([resolve(repoOne), resolve(repoTwo)].sort());
    expect(body.selectedRepoIds.sort()).toEqual(
      [encodeRepoId(resolve(repoOne)), encodeRepoId(resolve(repoTwo))].sort(),
    );

    const stateRes = await invokeHandler(handler, 'GET', '/api/repo-selections');
    const state = JSON.parse(stateRes.body) as {
      activeRoot: string;
      roots: Array<{ path: string; selectedRepoPaths: string[] }>;
      selectedRepoPaths: string[];
    };
    expect(state.activeRoot).toBe(resolve(collectionRoot));
    expect(
      state.roots.find((root) => root.path === resolve(collectionRoot))?.selectedRepoPaths.sort(),
    ).toEqual([resolve(repoOne), resolve(repoTwo)].sort());
    expect(
      state.roots.find((root) => root.path === resolve(fixture.mapRoot))?.selectedRepoPaths,
    ).toEqual([]);
    expect(state.selectedRepoPaths.sort()).toEqual([resolve(repoOne), resolve(repoTwo)].sort());
  });

  it('keeps live state unchanged when exclusive persistence fails', async () => {
    let failPersistence = false;
    const transactionHandler = createPluginHandler(fixture.mapRoot, (state) => {
      if (failPersistence) throw new Error('simulated persistence failure');
      return state;
    });
    const seeded = await invokeHandler(
      transactionHandler,
      'POST',
      '/api/repo-selections',
      JSON.stringify({ rootPath: fixture.mapRoot, selectedRepoPaths: [fixture.repoA] }),
    );
    expect(seeded.statusCode).toBe(200);
    const beforeRes = await invokeHandler(transactionHandler, 'GET', '/api/repo-selections');
    const before = JSON.parse(beforeRes.body);

    const collectionRoot = join(fixture.root, 'persistence-target');
    const repo = join(collectionRoot, 'repo');
    mkdirSync(repo, { recursive: true });
    failPersistence = true;
    const result = await invokeHandler(
      transactionHandler,
      'POST',
      '/api/map-from-parent',
      JSON.stringify({ path: repo }),
    );
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toContain('simulated persistence failure');

    const afterRes = await invokeHandler(transactionHandler, 'GET', '/api/repo-selections');
    expect(JSON.parse(afterRes.body)).toEqual(before);
  });

  it('POST /api/map-from-parent rejects an empty eligible parent without changing state', async () => {
    const beforeRes = await invokeHandler(handler, 'GET', '/api/repo-selections');
    const before = JSON.parse(beforeRes.body);
    const technicalRoot = join(fixture.root, 'technical-only');
    const nodeModules = join(technicalRoot, 'node_modules');
    mkdirSync(nodeModules, { recursive: true });

    const res = await invokeHandler(
      handler,
      'POST',
      '/api/map-from-parent',
      JSON.stringify({ path: nodeModules }),
    );

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error).toBe('carpeta madre sin subcarpetas elegibles');

    const stateRes = await invokeHandler(handler, 'GET', '/api/repo-selections');
    expect(JSON.parse(stateRes.body)).toEqual(before);
  });
});
