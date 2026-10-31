// ─── RepoCiv — construction pick-tile → foundRepoCity (C2) ───────────────────
// The pick-tile flow used to bypass the editor pipeline: it wrote a
// manualLayout entry and poked main.ts through _onCityAdded, skipping
// validation, undo history and placedCities persistence. It must go through
// renderer.foundRepoCity(repo, coord) like the map editor does, and only keep
// upsertSelection for repo-scan persistence.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScannedRepo } from '../map.ts';

const m = vi.hoisted(() => ({
  addSelectedRepoPath: vi.fn(async () => new Set<string>()),
  saveSelectedRepoPaths: vi.fn(),
  loadSelectedRepoPaths: vi.fn(() => null),
  removeSelectedRepoPath: vi.fn(async () => new Set<string>()),
  upsertManualRepoEntry: vi.fn(),
  removeManualRepoEntry: vi.fn(),
  loadManualLayout: vi.fn(() => ({ version: 1 as const, entries: [] })),
  showNotification: vi.fn(),
  trackPanelOpen: vi.fn(),
  resetTourState: vi.fn(),
  openMapEditor: vi.fn(),
}));

vi.mock('../map.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../map.ts')>();
  return {
    ...original,
    addSelectedRepoPath: m.addSelectedRepoPath,
    saveSelectedRepoPaths: m.saveSelectedRepoPaths,
    loadSelectedRepoPaths: m.loadSelectedRepoPaths,
    removeSelectedRepoPath: m.removeSelectedRepoPath,
  };
});
vi.mock('../manualLayout.ts', () => ({
  upsertManualRepoEntry: m.upsertManualRepoEntry,
  removeManualRepoEntry: m.removeManualRepoEntry,
  loadManualLayout: m.loadManualLayout,
}));
vi.mock('./notificationBanner.ts', () => ({ showNotification: m.showNotification }));
vi.mock('./analytics.ts', () => ({ trackPanelOpen: m.trackPanelOpen }));
vi.mock('./firstRunTour.ts', () => ({ resetTourState: m.resetTourState }));
vi.mock('./mapEditor.ts', () => ({ openMapEditor: m.openMapEditor }));

import { placePickedCity, setRendererRef } from './constructionPanel.ts';

const repo = {
  name: 'repociv',
  path: '/repos/repociv',
  repoPath: '/repos/repociv',
} as ScannedRepo;

function fakeRenderer() {
  return {
    setPlacingMode: vi.fn(),
    getPlacingMode: vi.fn(() => false),
    setCityRelocateMode: vi.fn(),
    getCityRelocateMode: vi.fn(() => false),
    foundRepoCity: vi.fn(() => true),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('document', { getElementById: vi.fn(() => null) });
});

describe('placePickedCity', () => {
  it('founds the city through the renderer pipeline', () => {
    const renderer = fakeRenderer();
    setRendererRef(renderer);
    const ok = placePickedCity(repo, { q: 2, r: -1 });
    expect(ok).toBe(true);
    expect(renderer.foundRepoCity).toHaveBeenCalledWith(repo, { q: 2, r: -1 });
    // The legacy write path must be gone.
    expect(m.upsertManualRepoEntry).not.toHaveBeenCalled();
    expect(renderer.setPlacingMode).toHaveBeenCalledWith(false);
  });

  it('keeps the repo-scan selection persisted', async () => {
    const renderer = fakeRenderer();
    setRendererRef(renderer);
    placePickedCity(repo, { q: 0, r: 0 });
    await vi.waitFor(() => expect(m.addSelectedRepoPath).toHaveBeenCalledWith(repo.path));
  });

  it('reports failure when the hex cannot host the city', () => {
    const renderer = fakeRenderer();
    renderer.foundRepoCity.mockReturnValue(false);
    setRendererRef(renderer);
    expect(placePickedCity(repo, { q: 9, r: 9 })).toBe(false);
    expect(m.addSelectedRepoPath).not.toHaveBeenCalled();
  });
});
