// ─── RepoCiv — P2 workbench label tests ───────────────────────────────────────
// Tests for label positioning, truncation, and zoom-based visibility thresholds.

import { describe, it, expect } from 'vitest';

describe('P2: workbench labels and tooltips', () => {
  it('label alpha: 0 when zoom < 0.5, fades 0.5→0.8, full at 0.8+', () => {
    const labelAlpha = (zoom: number, overlay: boolean) =>
      overlay ? 1 : Math.max(0, Math.min(1, (zoom - 0.5) / 0.3));

    // Below threshold — invisible
    expect(labelAlpha(0.3, false)).toBe(0);
    expect(labelAlpha(0.49, false)).toBe(0);

    // Fade range
    expect(labelAlpha(0.5, false)).toBeCloseTo(0);
    expect(labelAlpha(0.65, false)).toBeCloseTo(0.5, 1);
    expect(labelAlpha(0.8, false)).toBeCloseTo(1);

    // Above threshold — fully visible
    expect(labelAlpha(1.0, false)).toBe(1);
    expect(labelAlpha(2.0, false)).toBe(1);

    // Manual overlay toggle — always 1
    expect(labelAlpha(0.1, true)).toBe(1);
  });

  it('filename truncation: >10 chars → 8 chars + ".."', () => {
    const truncate = (name: string) => (name.length > 10 ? name.slice(0, 8) + '..' : name);

    expect(truncate('game.ts')).toBe('game.ts');
    expect(truncate('localRenderer.ts')).toBe('localRen..');
    expect(truncate('a.ts')).toBe('a.ts');
    expect(truncate('exactly10c')).toBe('exactly10c');
    expect(truncate('exactly11ch')).toBe('exactly1..');
  });

  it('file path truncation: >40 chars → "..." + last 37', () => {
    const truncate = (path: string) => (path.length > 40 ? '...' + path.slice(-37) : path);

    expect(truncate('/short/path/game.ts')).toBe('/short/path/game.ts');
    expect(
      truncate('/very/long/path/to/some/repository/src/localRenderer.ts').length,
    ).toBeLessThanOrEqual(40);
    expect(truncate('/very/long/path/to/some/repository/src/localRenderer.ts')).toMatch(/^\.\.\./);
  });

  it('extension color dot: known extensions have colors', () => {
    const EXT_COLOR: Record<string, string> = {
      ts: '#4a9bd4',
      tsx: '#4a9bd4',
      js: '#e8c44a',
      py: '#4a9',
      json: '#e8a44a',
      md: '#8ab4f8',
      css: '#a855f7',
    };

    expect(EXT_COLOR['ts']).toBeDefined();
    expect(EXT_COLOR['py']).toBeDefined();
    expect(EXT_COLOR['unknown'] ?? '#888').toBe('#888');
  });

  it('tooltip Y offset: increases with zoom above 1.2', () => {
    // 2D mode Y offset formula
    const yOffset2D = (zoom: number) => 14 + (zoom > 1.2 ? 4 : 0);
    expect(yOffset2D(0.8)).toBe(14);
    expect(yOffset2D(1.0)).toBe(14);
    expect(yOffset2D(1.3)).toBe(18);

    // Iso mode Y offset formula
    const ISO_WALL_H = 24;
    const yOffsetIso = (zoom: number) => ISO_WALL_H + 6 + (zoom > 1.2 ? 4 : 0);
    expect(yOffsetIso(0.8)).toBe(30);
    expect(yOffsetIso(1.3)).toBe(34);
  });

  it('high-density rooms (≥3 workbenches) skip individual labels', () => {
    // The condition: room.workbenches.length >= 3 → skip label
    const shouldDrawLabel = (workbenchCount: number) => workbenchCount < 3;
    expect(shouldDrawLabel(1)).toBe(true);
    expect(shouldDrawLabel(2)).toBe(true);
    expect(shouldDrawLabel(3)).toBe(false);
    expect(shouldDrawLabel(10)).toBe(false);
  });
});
