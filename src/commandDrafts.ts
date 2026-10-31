// ─── RepoCiv — Command draft builders ────────────────────────────────────────
// Central place for CommandDraft construction from UI gestures. Every draft
// carries a valid `type` and `target` so bridge.py validation never rejects
// with "Missing required fields" (the failure mode of the old
// BridgeEvents.send(type, payload) callers, which shipped no target over WS).

import type { CommandDraft } from './commandSchema.ts';
import type { Axial } from './hex.ts';

/** Open a file or folder in the OS editor (server `open_file` executor). */
export function openFileCommand(filePath: string): CommandDraft {
  return {
    type: 'open_file',
    target: filePath,
    payload: { filePath },
    created_by: 'user',
  };
}

/** Log that the user inspected a city tile (server `tile_inspected`). */
export function tileInspectedCommand(
  cityName: string,
  coord: Axial,
  repoPath: string | null | undefined,
): CommandDraft {
  return {
    type: 'tile_inspected',
    target: cityName,
    payload: { cityName, coord, repoPath },
    created_by: 'user',
  };
}
