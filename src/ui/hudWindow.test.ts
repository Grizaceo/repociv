import { describe, expect, it } from 'vitest';
import { clampHudWindowGeometry, hudWindowStorageKey } from './hudWindow.ts';

describe('hudWindow geometry', () => {
  it('keeps a resized window completely inside the viewport', () => {
    expect(
      clampHudWindowGeometry(
        { left: -120, top: 760, width: 1500, height: 900 },
        { width: 1200, height: 800 },
        { minWidth: 280, minHeight: 220 },
      ),
    ).toEqual({ left: 8, top: 8, width: 1184, height: 784 });
  });

  it('respects the configured minimums while dragging within a roomy viewport', () => {
    expect(
      clampHudWindowGeometry(
        { left: 90, top: 110, width: 100, height: 80 },
        { width: 900, height: 700 },
        { minWidth: 320, minHeight: 240 },
      ),
    ).toEqual({ left: 90, top: 110, width: 320, height: 240 });
  });

  it('names persisted layouts by panel id without colliding with other preferences', () => {
    expect(hudWindowStorageKey('agents-panel')).toBe('repociv:hud-window:v1:agents-panel');
  });
});
