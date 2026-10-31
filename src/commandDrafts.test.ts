// ─── RepoCiv — commandDrafts (A1) ────────────────────────────────────────────
// Legacy BridgeEvents.send() callers shipped {type, ...payload} over the WS
// command channel without a `target`, so bridge.py rejected them with
// "Missing required fields". These builders produce valid CommandDrafts.

import { describe, expect, it } from 'vitest';
import { COMMAND_RISK, type CommandDraft } from './commandSchema.ts';
import { openFileCommand, tileInspectedCommand } from './commandDrafts.ts';

function assertValidDraft(draft: CommandDraft): void {
  expect(typeof draft.type).toBe('string');
  expect(draft.type.length).toBeGreaterThan(0);
  expect(typeof draft.target).toBe('string');
  expect(draft.target.length).toBeGreaterThan(0);
  // The type must be registered in the shared schema (mirror of server).
  expect(Object.keys(COMMAND_RISK)).toContain(draft.type);
}

describe('commandDrafts', () => {
  it('openFileCommand targets the file path', () => {
    const draft = openFileCommand('/repos/a/file.ts');
    assertValidDraft(draft);
    expect(draft.type).toBe('open_file');
    expect(draft.target).toBe('/repos/a/file.ts');
    expect(draft.payload?.['filePath']).toBe('/repos/a/file.ts');
    expect(draft.created_by).toBe('user');
  });

  it('tileInspectedCommand targets the inspected city', () => {
    const draft = tileInspectedCommand('repociv', { q: 3, r: -1 }, '/repos/repociv');
    assertValidDraft(draft);
    expect(draft.type).toBe('tile_inspected');
    expect(draft.target).toBe('repociv');
    expect(draft.payload).toMatchObject({
      cityName: 'repociv',
      coord: { q: 3, r: -1 },
      repoPath: '/repos/repociv',
    });
  });
});
