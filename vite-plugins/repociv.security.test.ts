import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveRepoPathFromId, resolveRepoRelativeFile, runGit } from './repociv.ts';
import { encodeRepoId } from './repoRootsState.ts';
import { resolveViteHost } from '../vite.config.ts';

describe('RepoCiv Vite filesystem security boundary', () => {
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

describe('Vite host boundary', () => {
  it('binds loopback by default', () => {
    expect(resolveViteHost({})).toBe('127.0.0.1');
  });

  it('requires an explicit remote opt-in for non-loopback binding', () => {
    expect(resolveViteHost({ REPOCIV_REMOTE: 'true' })).toBe('0.0.0.0');
    expect(resolveViteHost({ REPOCIV_REMOTE: 'false' })).toBe('127.0.0.1');
  });
});
