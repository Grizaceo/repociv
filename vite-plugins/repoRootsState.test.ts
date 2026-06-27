import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addRepoSelection,
  decodeRepoId,
  encodeRepoId,
  loadState,
  removeRepoSelection,
  saveState,
  setRootSelection,
  summarizeState,
} from './repoRootsState.ts';

describe('repoRootsState persistence', () => {
  let tempRoot: string;
  let statePath: string;
  let mapRoot: string;
  let repoA: string;
  let repoB: string;
  const prevStateFile = process.env['REPOCIV_STATE_FILE'];

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'repociv-state-test-'));
    statePath = join(tempRoot, 'state.json');
    mapRoot = join(tempRoot, 'workspace');
    repoA = join(mapRoot, 'repo-a');
    repoB = join(mapRoot, 'repo-b');
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    process.env['REPOCIV_STATE_FILE'] = statePath;
  });

  afterEach(() => {
    if (prevStateFile === undefined) delete process.env['REPOCIV_STATE_FILE'];
    else process.env['REPOCIV_STATE_FILE'] = prevStateFile;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('round-trips repo ids via base64url encoding', () => {
    const repoPath = resolve('/tmp/example/repo-a');
    const id = encodeRepoId(repoPath);
    expect(id.startsWith('repo:')).toBe(true);
    expect(decodeRepoId(id)).toBe(repoPath);
    expect(decodeRepoId('not-a-repo-id')).toBeNull();
  });

  it('persists active root and selections across save/load', () => {
    let state = loadState(mapRoot);
    state = setRootSelection(state, mapRoot, [repoA, repoB]);
    saveState(state);

    const reloaded = loadState(mapRoot);
    expect(reloaded.activeRoot).toBe(resolve(mapRoot));
    expect(reloaded.roots[resolve(mapRoot)]?.selectedRepoPaths.sort()).toEqual(
      [resolve(repoA), resolve(repoB)].sort(),
    );

    const onDisk = JSON.parse(readFileSync(statePath, 'utf8')) as {
      activeRoot: string;
      roots: Record<string, { selectedRepoPaths: string[] }>;
    };
    expect(onDisk.activeRoot).toBe(resolve(mapRoot));
    expect(onDisk.roots[resolve(mapRoot)]?.selectedRepoPaths.sort()).toEqual(
      [resolve(repoA), resolve(repoB)].sort(),
    );
  });

  it('add/remove selection mutations survive reload', () => {
    let state = loadState(mapRoot);
    state = addRepoSelection(state, repoA);
    state = addRepoSelection(state, repoB);
    state = removeRepoSelection(state, repoA);
    saveState(state);

    const summary = summarizeState(loadState(mapRoot));
    expect(summary.selectedRepoPaths).toEqual([resolve(repoB)]);
    expect(summary.selectedRepoIds).toEqual([encodeRepoId(resolve(repoB))]);
    expect(summary.hasSelections).toBe(true);
  });
});
