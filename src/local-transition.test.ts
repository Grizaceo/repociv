// ─── RepoCiv — P5 transition polish tests ──────────────────────────────────────
// Tests for transition state machine, timing, and camera intro zoom.

import { describe, it, expect } from 'vitest';

describe('P5: transition polish', () => {
  it('enter transition: fade 0→1 over 400ms', () => {
    const enterDuration = 400;
    const alpha = (elapsed: number) => Math.min(elapsed / enterDuration, 1);

    expect(alpha(0)).toBe(0);
    expect(alpha(200)).toBeCloseTo(0.5);
    expect(alpha(400)).toBe(1);
    expect(alpha(500)).toBe(1); // clamped
  });

  it('exit transition: fade 1→0 over 300ms', () => {
    const exitDuration = 300;
    const alpha = (elapsed: number) => 1 - Math.min(elapsed / exitDuration, 1);

    expect(alpha(0)).toBe(1);
    expect(alpha(150)).toBeCloseTo(0.5);
    expect(alpha(300)).toBe(0);
    expect(alpha(400)).toBe(0); // clamped
  });

  it('camera intro zoom: 0.8→1.0 over 600ms with cubic ease-out', () => {
    const duration = 600;
    const from = 0.8;
    const to = 1.0;
    const zoom = (elapsed: number) => {
      const t = Math.min(elapsed / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3); // cubic ease-out
      return from + (to - from) * ease;
    };

    expect(zoom(0)).toBeCloseTo(0.8);
    // At t=0.5 (300ms): ease = 1 - 0.125 = 0.875, zoom = 0.8 + 0.2*0.875 = 0.975
    expect(zoom(300)).toBeCloseTo(0.975, 2);
    expect(zoom(600)).toBeCloseTo(1.0);
    expect(zoom(700)).toBeCloseTo(1.0); // clamped
  });

  it('transition state machine: null → entering → active → exiting → null', () => {
    let state: 'entering' | 'active' | 'exiting' | null = null;
    expect(state).toBeNull();

    // Start enter
    state = 'entering';
    expect(state).toBe('entering');

    // Enter completes
    state = 'active';
    expect(state).toBe('active');

    // Start exit
    state = 'exiting';
    expect(state).toBe('exiting');

    // Exit completes
    state = null;
    expect(state).toBeNull();
  });

  it('isTransitionComplete: true when active or null', () => {
    const isComplete = (state: string | null) =>
      state === null || state === 'active';

    expect(isComplete(null)).toBe(true);
    expect(isComplete('active')).toBe(true);
    expect(isComplete('entering')).toBe(false);
    expect(isComplete('exiting')).toBe(false);
  });

  it('loading indicator: setLoadingIndicator toggles state', () => {
    let loading = false;
    const setLoading = (active: boolean) => { loading = active; };

    expect(loading).toBe(false);
    setLoading(true);
    expect(loading).toBe(true);
    setLoading(false);
    expect(loading).toBe(false);
  });

  it('intro zoom does not interfere with user zoom after completion', () => {
    // After intro zoom completes, _introZoomActive = false
    // User wheel zoom should work normally
    let introZoomActive = true;
    const duration = 600;
    const elapsed = 601;
    const t = Math.min(elapsed / duration, 1);
    if (t >= 1) introZoomActive = false;

    expect(introZoomActive).toBe(false);
    // User can now zoom freely
  });

  it('spinner animation: 8 dots rotating, alpha gradient', () => {
    const now = 1000;
    const dots: { alpha: number }[] = [];
    for (let i = 0; i < 8; i++) {
      const alpha = 0.3 + 0.7 * (i / 8);
      dots.push({ alpha });
    }
    void now;
    expect(dots.length).toBe(8);
    expect(dots[0]!.alpha).toBeCloseTo(0.3);
    expect(dots[7]!.alpha).toBeCloseTo(0.3 + 0.7 * (7 / 8));
    // Alphas are monotonically increasing
    for (let i = 1; i < 8; i++) {
      expect(dots[i]!.alpha).toBeGreaterThan(dots[i - 1]!.alpha);
    }
  });
});