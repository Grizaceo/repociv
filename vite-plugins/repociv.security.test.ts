import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchBridgeFileTree,
  isTrustedJsonMutation,
  resolveRepoPathFromId,
  resolveRepoRelativeFile,
  resolveSelectedRepoPath,
  runGit,
} from './repociv.ts';
import { encodeRepoId, type RepoRootsState } from './repoRootsState.ts';
import { resolveViteHost } from '../vite.config.ts';

describe('RepoCiv Vite filesystem security boundary', () => {
  it('never executes shell command strings', () => {
    const source = readFileSync(new URL('./repociv.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('execSync(');
  });

  let fixtureRoot: string;
  let selectedRoot: string;
  let repo: string;
  let outsideRepo: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'repociv-vite-security-'));
    selectedRoot = join(fixtureRoot, 'selected');
    repo = join(selectedRoot, 'repo-a');
    outsideRepo = join(fixtureRoot, 'outside', 'repo-b');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(outsideRepo, '.git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('rejects an encoded repo outside every configured root', () => {
    expect(
      resolveRepoPathFromId(encodeRepoId(outsideRepo), selectedRoot, [selectedRoot]),
    ).toBeNull();
  });

  it('rejects a symlinked repo that resolves outside the configured root', () => {
    const linkedRepo = join(selectedRoot, 'linked-outside');
    symlinkSync(outsideRepo, linkedRepo, 'dir');
    expect(
      resolveRepoPathFromId(encodeRepoId(linkedRepo), selectedRoot, [selectedRoot]),
    ).toBeNull();
  });

  it('accepts an encoded real repo contained by a configured root', () => {
    expect(resolveRepoPathFromId(encodeRepoId(repo), selectedRoot, [selectedRoot])).toBe(
      realpathSync(repo),
    );
  });

  it('requires canonical selection membership, not mere root containment', () => {
    const state: RepoRootsState = {
      version: 1,
      activeRoot: selectedRoot,
      roots: {
        [selectedRoot]: {
          selectedRepoPaths: [],
          addedAt: '2026-07-12T00:00:00Z',
          lastSeen: '2026-07-12T00:00:00Z',
        },
      },
    };
    expect(resolveSelectedRepoPath(encodeRepoId(repo), state)).toBeNull();

    state.roots[selectedRoot]!.selectedRepoPaths = [repo];
    expect(resolveSelectedRepoPath(encodeRepoId(repo), state)).toBe(realpathSync(repo));
  });

  it('supports selected repositories from multiple roots and rejects symlink escape', () => {
    const secondRoot = join(fixtureRoot, 'second-root');
    const secondRepo = join(secondRoot, 'repo-c');
    const linkedRepo = join(selectedRoot, 'linked-outside');
    mkdirSync(join(secondRepo, '.git'), { recursive: true });
    symlinkSync(outsideRepo, linkedRepo, 'dir');
    const state: RepoRootsState = {
      version: 1,
      activeRoot: selectedRoot,
      roots: {
        [selectedRoot]: {
          selectedRepoPaths: [linkedRepo],
          addedAt: '2026-07-12T00:00:00Z',
          lastSeen: '2026-07-12T00:00:00Z',
        },
        [secondRoot]: {
          selectedRepoPaths: [secondRepo],
          addedAt: '2026-07-12T00:00:00Z',
          lastSeen: '2026-07-12T00:00:00Z',
        },
      },
    };
    expect(resolveSelectedRepoPath(encodeRepoId(secondRepo), state)).toBe(realpathSync(secondRepo));
    expect(resolveSelectedRepoPath(encodeRepoId(linkedRepo), state)).toBeNull();
  });

  it('rejects absolute, traversal, NUL and symlink-escape file paths', () => {
    const outsideFile = join(fixtureRoot, 'outside', 'secret.txt');
    const linkedFile = join(repo, 'linked-secret.txt');
    symlinkSync(outsideFile, linkedFile, 'file');

    expect(resolveRepoRelativeFile(repo, '/etc/passwd')).toBeNull();
    expect(resolveRepoRelativeFile(repo, '../outside.txt')).toBeNull();
    expect(resolveRepoRelativeFile(repo, 'nested/../../outside.txt')).toBeNull();
    expect(resolveRepoRelativeFile(repo, 'bad\0name')).toBeNull();
    expect(resolveRepoRelativeFile(repo, 'linked-secret.txt')).toBeNull();
  });

  it('accepts valid relative git paths without interpreting metacharacters', () => {
    expect(resolveRepoRelativeFile(repo, 'src/main.ts')).toBe('src/main.ts');
    expect(resolveRepoRelativeFile(repo, 'src/"; touch SHOULD_NOT_RUN; #.ts')).toBe(
      'src/"; touch SHOULD_NOT_RUN; #.ts',
    );
  });

  it('keeps shell metacharacters as one literal git argv element', () => {
    const execute = vi.fn(() => Buffer.from('ok\n'));
    const literalFile = 'src/"; touch SHOULD_NOT_RUN; #.ts';

    const output = runGit(repo, ['log', '--oneline', '--', literalFile], execute);

    expect(output).toBe('ok');
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toBe('git');
    expect(execute.mock.calls[0]?.[1]).toEqual([
      '-C',
      resolve(repo),
      'log',
      '--oneline',
      '--',
      literalFile,
    ]);
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ encoding: 'utf8' });
  });
});

describe('Vite mutation authentication boundary', () => {
  const baseHeaders = {
    host: '127.0.0.1:5273',
    'content-type': 'application/json',
  };

  it('accepts same-origin JSON and rejects a foreign browser Origin', () => {
    expect(isTrustedJsonMutation({ ...baseHeaders, origin: 'http://127.0.0.1:5273' }, '')).toBe(
      true,
    );
    expect(isTrustedJsonMutation({ ...baseHeaders, origin: 'https://evil.example' }, '')).toBe(
      false,
    );
  });

  it('accepts a configured token for non-browser clients but rejects empty-token requests', () => {
    expect(isTrustedJsonMutation(baseHeaders, '')).toBe(false);
    expect(
      isTrustedJsonMutation(
        { ...baseHeaders, 'x-repociv-token': 'test-token-32-characters-minimum' },
        'test-token-32-characters-minimum',
      ),
    ).toBe(true);
    expect(
      isTrustedJsonMutation(
        { ...baseHeaders, 'x-repociv-token': 'wrong' },
        'test-token-32-characters-minimum',
      ),
    ).toBe(false);
  });

  it('rejects text/plain even when Origin is same-host', () => {
    expect(
      isTrustedJsonMutation(
        {
          host: '127.0.0.1:5273',
          origin: 'http://127.0.0.1:5273',
          'content-type': 'text/plain',
        },
        '',
      ),
    ).toBe(false);
  });
});

describe('Vite file API bridge ownership', () => {
  it('proxies the exact file route with the configured token', async () => {
    const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({ files: ['src/main.ts'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const response = await fetchBridgeFileTree(
      '/api/files/repo%3Aabc',
      'http://127.0.0.1:5274',
      'test-token',
      fakeFetch,
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      [
        'http://127.0.0.1:5274/api/files/repo%3Aabc',
        { headers: { 'X-RepoCiv-Token': 'test-token' } },
      ],
    ]);
  });
});

describe('Vite host boundary', () => {
  it('binds loopback by default', () => {
    expect(resolveViteHost({})).toBe('127.0.0.1');
  });

  it('requires an explicit remote opt-in for non-loopback binding', () => {
    expect(resolveViteHost({ REPOCIV_REMOTE: 'true' })).toBe('0.0.0.0');
    expect(resolveViteHost({ REPOCIV_REMOTE: 'false' })).toBe('127.0.0.1');
  });
});
