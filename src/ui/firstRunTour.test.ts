import { describe, it, expect, afterEach, vi } from 'vitest';
import { shouldShowTour, markTourSeen, TOUR_STEPS } from './firstRunTour.ts';

function stubStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  });
  return store;
}

describe('firstRunTour', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows on a fresh run', () => {
    stubStorage();
    expect(shouldShowTour()).toBe(true);
  });

  it('is hidden after being marked seen (persists once)', () => {
    const store = stubStorage();
    markTourSeen();
    expect(store['repociv:tour-seen:v1']).toBe('1');
    expect(shouldShowTour()).toBe(false);
  });

  it('teaches the F8 agents panel instead of the removed session launcher', () => {
    expect(TOUR_STEPS).toEqual(
      expect.arrayContaining([expect.objectContaining({ selector: '#btn-agents' })]),
    );
    expect(TOUR_STEPS.some((step) => step.selector === '.session-launcher')).toBe(false);
    expect(TOUR_STEPS.some((step) => step.selector === '.hero-bar-spawn')).toBe(false);
  });

  it('has a non-empty, well-formed step list (the core loop)', () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(3);
    for (const s of TOUR_STEPS) {
      expect(s.selector).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(s.body).toBeTruthy();
    }
  });
});
