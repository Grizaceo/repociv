import { describe, expect, it } from 'vitest';
import { clampHudWindowGeometry, hudWindowStorageKey, placeHudWindow } from './hudWindow.ts';

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

  it('keeps an unoccupied preferred position next to the Gaceta', () => {
    const preferred = { left: 340, top: 50, width: 260, height: 500 };
    expect(
      placeHudWindow(preferred, { width: 1600, height: 900 }, [
        { left: 12, top: 50, width: 320, height: 420 },
      ]),
    ).toEqual(preferred);
  });

  it('finds a hole between occupied windows rather than only trying screen corners', () => {
    expect(
      placeHudWindow({ left: 8, top: 50, width: 240, height: 200 }, { width: 1000, height: 700 }, [
        { left: 8, top: 8, width: 300, height: 684 },
        { left: 600, top: 8, width: 392, height: 684 },
      ]),
    ).toEqual({ left: 316, top: 50, width: 240, height: 200 });
  });

  it('ignores obstacles entirely outside the usable viewport', () => {
    const preferred = { left: 8, top: 50, width: 260, height: 200 };
    expect(
      placeHudWindow(preferred, { width: 1000, height: 700 }, [
        { left: 1100, top: 0, width: 200, height: 200 },
      ]),
    ).toEqual(preferred);
  });

  it('falls back to a reachable clamped window when there is no room', () => {
    expect(
      placeHudWindow({ left: 340, top: 50, width: 260, height: 800 }, { width: 320, height: 480 }, [
        { left: 0, top: 0, width: 320, height: 480 },
      ]),
    ).toEqual({ left: 52, top: 8, width: 260, height: 464 });
  });
});
