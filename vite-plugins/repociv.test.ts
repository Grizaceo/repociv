import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { decodeRepoId, encodeRepoId } from './repoRootsState.ts';

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

function mockRequest(method: string, url: string, body?: string): Connect.IncomingMessage {
  const req = new EventEmitter() as Connect.IncomingMessage;
  req.method = method;
  req.url = url;
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
): Promise<MockResponse> {
  const req = mockRequest(method, url, body);
  const res = mockResponse();
  let nextCalled = false;
  await handler(req, res as unknown as Connect.ServerResponse, () => {
    nextCalled = true;
  });
  expect(nextCalled).toBe(false);
  return res;
}

describe('shell execution boundary', () => {
  // The /git endpoint interpolates a caller-supplied `file` query parameter into
  // its git invocation. While that ran through a shell string, the value could
  // close the quoting and append commands. Everything now goes through
  // execFileSync with an argv array, and this locks it in: a single execSync
  // reintroduced anywhere in the plugin fails the suite.
  it('never executes shell command strings', () => {
    const source = readFileSync(new URL('./repociv.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('execSync(');
  });
});

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
    expect(resolveRepoPathFromId(encodeRepoId(fixture.repoA), mapRoot)).toBe(resolve(fixture.repoA));
    expect(resolveRepoPathFromId('repo-a', mapRoot)).toBe(resolve(fixture.repoA));
  });

  it('resolveRepoPathFromId does not escape map root via legacy join', () => {
    const mapRoot = resolve(fixture.mapRoot);
    expect(resolveRepoPathFromId('outside', mapRoot)).toBeNull();
    expect(resolveRepoPathFromId(encodeRepoId(fixture.outside), mapRoot)).toBe(resolve(fixture.outside));
  });
});

describe('/api/map-root handlers', () => {
  let fixture: ReturnType<typeof makeFixture>;
  let handler: Connect.NextHandleFunction;
  const prevStateFile = process.env['REPOCIV_STATE_FILE'];

  beforeEach(() => {
    fixture = makeFixture();
    process.env['REPOCIV_STATE_FILE'] = join(fixture.root, 'state.json');
    const plugin = repocivPlugin(fixture.mapRoot);
    let captured: Connect.NextHandleFunction | undefined;
    plugin.configureServer!({
      middlewares: { use: (fn: Connect.NextHandleFunction) => { captured = fn; } },
      ws: { send: () => {} },
    } as never);
    if (!captured) throw new Error('middleware not registered');
    handler = captured;
  });

  afterEach(() => {
    if (prevStateFile === undefined) delete process.env['REPOCIV_STATE_FILE'];
    else process.env['REPOCIV_STATE_FILE'] = prevStateFile;
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('GET returns the active map root', async () => {
    const res = await invokeHandler(handler, 'GET', '/api/map-root');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ path: resolve(fixture.mapRoot) });
  });

  it('POST rejects empty, missing, and non-directory paths', async () => {
    const empty = await invokeHandler(handler, 'POST', '/api/map-root', JSON.stringify({ path: '  ' }));
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
});

// Regression lock for the onboarding harness bug: `/api/config/default-harness`
// is a bridge route, but it was fetched bare, so it landed here, fell through to
// Vite's SPA fallback, and came back as index.html with a 200. The GET read that
// as success and threw parsing HTML as JSON inside a bare catch (the saved
// harness was discarded on every visit); the POST 404'd and blocked onboarding.
// The handler now terminates unmatched /api/* itself so the mistake is loud.
describe('unmatched /api/* routing guard', () => {
  let fixture: ReturnType<typeof makeFixture>;
  let handler: Connect.NextHandleFunction;
  const prevStateFile = process.env['REPOCIV_STATE_FILE'];

  beforeEach(() => {
    fixture = makeFixture();
    process.env['REPOCIV_STATE_FILE'] = join(fixture.root, 'state.json');
    const plugin = repocivPlugin(fixture.mapRoot);
    let captured: Connect.NextHandleFunction | undefined;
    plugin.configureServer!({
      middlewares: { use: (fn: Connect.NextHandleFunction) => { captured = fn; } },
      ws: { send: () => {} },
    } as never);
    if (!captured) throw new Error('middleware not registered');
    handler = captured;
  });

  afterEach(() => {
    if (prevStateFile === undefined) delete process.env['REPOCIV_STATE_FILE'];
    else process.env['REPOCIV_STATE_FILE'] = prevStateFile;
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('answers an unknown /api route with 404 JSON instead of falling through to the SPA', async () => {
    const res = await invokeHandler(handler, 'GET', '/api/config/default-harness');
    expect(res.statusCode).toBe(404);
    expect(res.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(res.body) as { error: string };
    // The message must name the fix, not just report the miss.
    expect(body.error).toContain('bridgeUrl');
    expect(body.error).toContain('/api/config/default-harness');
  });

  it('guards every method, so a bare POST cannot be mistaken for a bridge write', async () => {
    const res = await invokeHandler(
      handler,
      'POST',
      '/api/config/default-harness',
      JSON.stringify({ harness: 'hermes' }),
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toContain('bridgeUrl');
  });

  it('still hands non-API requests to Vite so the SPA and assets keep working', async () => {
    for (const url of ['/', '/index.html', '/src/main.ts', '/assets/logo.png']) {
      const req = mockRequest('GET', url);
      const res = mockResponse();
      let nextCalled = false;
      await handler(req, res as unknown as Connect.ServerResponse, () => {
        nextCalled = true;
      });
      expect(nextCalled, `${url} must fall through to Vite`).toBe(true);
      expect(res.body).toBe('');
    }
  });
});
