import type { Axial } from './hex.ts';

export interface ManualRepoEntry {
  repoPath: string;
  repoName: string;
  coord: Axial;
  addedAt: number;
  source: 'manual';
}

export interface ManualLayoutStore {
  version: 1;
  entries: ManualRepoEntry[];
}

const MANUAL_LAYOUT_STORAGE_KEY = 'repociv:manual-layout:v1';

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function loadManualLayout(): ManualLayoutStore {
  if (!canUseLocalStorage()) return { version: 1, entries: [] };
  try {
    const raw = window.localStorage.getItem(MANUAL_LAYOUT_STORAGE_KEY);
    if (!raw) return { version: 1, entries: [] };
    const parsed = JSON.parse(raw) as Partial<ManualLayoutStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    const entries = parsed.entries.filter(
      (entry): entry is ManualRepoEntry =>
        typeof entry?.repoPath === 'string' &&
        typeof entry?.repoName === 'string' &&
        typeof entry?.coord?.q === 'number' &&
        typeof entry?.coord?.r === 'number' &&
        entry?.source === 'manual',
    );
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function saveManualLayout(store: ManualLayoutStore): void {
  if (!canUseLocalStorage()) return;
  window.localStorage.setItem(MANUAL_LAYOUT_STORAGE_KEY, JSON.stringify(store));
}

export function upsertManualRepoEntry(entry: ManualRepoEntry): ManualLayoutStore {
  const store = loadManualLayout();
  const withoutSameRepo = store.entries.filter((item) => item.repoPath !== entry.repoPath);
  const withoutSameCoord = withoutSameRepo.filter(
    (item) => item.coord.q !== entry.coord.q || item.coord.r !== entry.coord.r,
  );
  const next: ManualLayoutStore = {
    version: 1,
    entries: [...withoutSameCoord, entry],
  };
  saveManualLayout(next);
  return next;
}

export function removeManualRepoEntry(repoPath: string): ManualLayoutStore {
  const store = loadManualLayout();
  const next: ManualLayoutStore = {
    version: 1,
    entries: store.entries.filter((entry) => entry.repoPath !== repoPath),
  };
  saveManualLayout(next);
  return next;
}

export function updateManualRepoCoord(repoPath: string, coord: Axial): ManualLayoutStore | null {
  const store = loadManualLayout();
  const idx = store.entries.findIndex((e) => e.repoPath === repoPath);
  if (idx === -1) return null;
  store.entries[idx] = { ...store.entries[idx], coord } as ManualRepoEntry;
  saveManualLayout(store);
  return store;
}

