// ─── Local view: agent activity overlay ────────────────────────────────────
// The glyph logic is pure so it can be tested without a canvas. The draw call
// itself lives in isoLocalRenderer.ts (canvas-bound, covered by e2e).

import { describe, it, expect } from 'vitest';
import {
  ACTIVITY_TTL_MS,
  activityGlyphFor,
  isActivityActive,
  type LocalActivity,
} from './localActivity.ts';

const at = (toolName: string, t: number): LocalActivity => ({ toolName, at: t });

describe('isActivityActive', () => {
  it('is true within the TTL window', () => {
    expect(isActivityActive(at('read_file', 1000), 1000)).toBe(true);
    expect(isActivityActive(at('read_file', 1000), 1000 + ACTIVITY_TTL_MS - 1)).toBe(true);
  });

  it('is false once the TTL has elapsed', () => {
    expect(isActivityActive(at('read_file', 1000), 1000 + ACTIVITY_TTL_MS)).toBe(false);
    expect(isActivityActive(at('read_file', 1000), 5000)).toBe(false);
  });

  it('treats a missing activity as inactive', () => {
    expect(isActivityActive(null, 1000)).toBe(false);
    expect(isActivityActive(undefined, 1000)).toBe(false);
  });

  it('restarts on every new tool call (chained burst stays lit)', () => {
    // read at t=0, edit at t=1200 — the second call refreshes the window, so
    // the glyph is still lit at t=2500 even though the first call expired.
    let a = at('read_file', 0);
    expect(isActivityActive(a, 2500)).toBe(false);
    a = at('edit_file', 1200);
    expect(isActivityActive(a, 2500)).toBe(true);
  });
});

describe('activityGlyphFor', () => {
  it('returns a glyph for a known tool', () => {
    expect(activityGlyphFor('read_file').glyph).toBeTruthy();
  });

  it('falls back honestly for an unknown tool', () => {
    // The tool list is open-ended. An unknown tool must still get a glyph and
    // a colour — never undefined, and never a blank string that draws nothing.
    const g = activityGlyphFor('some_tool_from_2031');
    expect(g.glyph).toBeTruthy();
    expect(g.color).toBeTruthy();
  });

  it('handles an empty tool name', () => {
    expect(activityGlyphFor('').glyph).toBeTruthy();
  });

  it('gives the same glyph to every tool in slice 1', () => {
    // Slice 1 is deliberately one hardcoded glyph: the point is to prove the
    // whole path (bridge -> transport -> client -> pixel) end to end. The
    // per-tool vocabulary is slice 2 and hangs off this same function.
    expect(activityGlyphFor('read_file').glyph).toBe(activityGlyphFor('bash').glyph);
  });
});

// ─── Attribution policy ────────────────────────────────────────────────────
// The bridge attributes every tool call to the parent macro unit. These pin
// what the LOCAL VIEW does with that, and — just as important — what it
// refuses to do.

import { resolveActivityTarget } from './localActivity.ts';

const body = (id: string, macroUnitId: string, ephemeral = false) => ({
  id,
  macroUnitId,
  ephemeral,
});

describe('resolveActivityTarget', () => {
  it('lights the unit whose own id matches', () => {
    const main = body('MAIN', 'MAIN');
    expect(resolveActivityTarget([main], 'MAIN')).toBe(main);
  });

  it('lights the repo owner when the event is keyed by macro id', () => {
    const main = body('MAIN', 'HERMES');
    expect(resolveActivityTarget([main], 'HERMES')).toBe(main);
  });

  it('prefers the non-ephemeral owner over an ephemeral delegate', () => {
    const owner = body('MAIN', 'HERMES');
    const child = body('SCOUT-sub-1', 'HERMES', true);
    // Order reversed on purpose: the delegate is listed first.
    expect(resolveActivityTarget([child, owner], 'HERMES')).toBe(owner);
  });

  it('lights nobody when only delegates remain', () => {
    // The stream cannot tell us which child ran the tool. Lighting one anyway
    // would be a claim we cannot support.
    const child = body('SCOUT-sub-1', 'HERMES', true);
    expect(resolveActivityTarget([child], 'HERMES')).toBeNull();
  });

  it('lights nobody for a unit outside this office', () => {
    expect(resolveActivityTarget([body('MAIN', 'MAIN')], 'SOMEWHERE-ELSE')).toBeNull();
  });

  it('handles an empty office', () => {
    expect(resolveActivityTarget([], 'MAIN')).toBeNull();
  });

  it('treats a missing ephemeral flag as non-ephemeral', () => {
    const owner = { id: 'MAIN', macroUnitId: 'HERMES' };
    expect(resolveActivityTarget([owner], 'HERMES')).toBe(owner);
  });
});
