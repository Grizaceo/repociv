import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface RepoRootEntry {
  label?: string;
  selectedRepoPaths: string[];
  addedAt: string;
  lastSeen: string;
}

export interface RepoRootsState {
  version: 1;
  activeRoot: string;
  roots: Record<string, RepoRootEntry>;
}

export interface RepoSelectionRootState {
  path: string;
  label?: string;
  selectedRepoIds: string[];
  selectedRepoPaths: string[];
}

export interface RepoSelectionState {
  activeRoot: string;
  roots: RepoSelectionRootState[];
  selectedRepoIds: string[];
  selectedRepoPaths: string[];
  hasSelections: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function stateFilePath(): string {
  const explicit = process.env['REPOCIV_STATE_FILE']?.trim();
  if (explicit) return resolve(explicit);
  const xdg = process.env['XDG_STATE_HOME']?.trim();
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'repociv', 'state.json');
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

export function encodeRepoId(repoPath: string): string {
  return `repo:${Buffer.from(repoPath, 'utf8').toString('base64url')}`;
}

export function decodeRepoId(repoId: string): string | null {
  if (!repoId.startsWith('repo:')) return null;
  const encoded = repoId.slice('repo:'.length);
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function defaultState(defaultRoot: string): RepoRootsState {
  return {
    version: 1,
    activeRoot: defaultRoot,
    roots: defaultRoot
      ? {
          [defaultRoot]: {
            selectedRepoPaths: [],
            addedAt: nowIso(),
            lastSeen: nowIso(),
          },
        }
      : {},
  };
}

export function loadState(defaultRoot: string): RepoRootsState {
  const path = stateFilePath();
  if (!existsSync(path)) return defaultState(defaultRoot);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RepoRootsState>;
    const roots = typeof raw.roots === 'object' && raw.roots ? raw.roots : {};
    const normalized: Record<string, RepoRootEntry> = {};
    for (const [rootPath, entry] of Object.entries(roots)) {
      if (!rootPath || typeof rootPath !== 'string') continue;
      normalized[rootPath] = {
        label: typeof entry?.label === 'string' ? entry.label : undefined,
        selectedRepoPaths: Array.isArray(entry?.selectedRepoPaths)
          ? entry.selectedRepoPaths.filter((item): item is string => typeof item === 'string' && item.length > 0)
          : [],
        addedAt: typeof entry?.addedAt === 'string' ? entry.addedAt : nowIso(),
        lastSeen: typeof entry?.lastSeen === 'string' ? entry.lastSeen : nowIso(),
      };
    }
    const activeRoot =
      typeof raw.activeRoot === 'string' && raw.activeRoot.length > 0
        ? raw.activeRoot
        : defaultRoot;
    if (activeRoot && !normalized[activeRoot]) {
      normalized[activeRoot] = {
        selectedRepoPaths: [],
        addedAt: nowIso(),
        lastSeen: nowIso(),
      };
    }
    return { version: 1, activeRoot, roots: normalized };
  } catch {
    return defaultState(defaultRoot);
  }
}

export function saveState(state: RepoRootsState): RepoRootsState {
  atomicWrite(stateFilePath(), JSON.stringify(state, null, 2));
  return state;
}

export function ensureRoot(state: RepoRootsState, rootPath: string, label?: string): RepoRootsState {
  const resolved = resolve(rootPath);
  const existing = state.roots[resolved];
  state.activeRoot = resolved;
  state.roots[resolved] = {
    label: label ?? existing?.label,
    selectedRepoPaths: existing?.selectedRepoPaths ?? [],
    addedAt: existing?.addedAt ?? nowIso(),
    lastSeen: nowIso(),
  };
  return state;
}

export function summarizeState(state: RepoRootsState): RepoSelectionState {
  const roots = Object.entries(state.roots).map(([path, entry]) => ({
    path,
    label: entry.label,
    selectedRepoIds: entry.selectedRepoPaths.map(encodeRepoId),
    selectedRepoPaths: [...entry.selectedRepoPaths],
  }));
  const allPaths = Array.from(
    new Set(roots.flatMap((root) => root.selectedRepoPaths.filter((item) => item.length > 0))),
  );
  return {
    activeRoot: state.activeRoot,
    roots,
    selectedRepoIds: allPaths.map(encodeRepoId),
    selectedRepoPaths: allPaths,
    hasSelections: allPaths.length > 0,
  };
}

export function setRootSelection(
  state: RepoRootsState,
  rootPath: string,
  repoPaths: string[],
): RepoRootsState {
  ensureRoot(state, rootPath);
  const root = state.roots[resolve(rootPath)]!;
  root.selectedRepoPaths = Array.from(new Set(repoPaths.map((item) => resolve(item)).filter((item) => item.length > 0)));
  root.lastSeen = nowIso();
  return state;
}

export function addRepoSelection(state: RepoRootsState, repoPath: string): RepoRootsState {
  const resolvedRepoPath = resolve(repoPath);
  const rootPath = dirname(resolvedRepoPath);
  ensureRoot(state, rootPath);
  const root = state.roots[rootPath]!;
  if (!root.selectedRepoPaths.includes(resolvedRepoPath)) {
    root.selectedRepoPaths.push(resolvedRepoPath);
  }
  root.lastSeen = nowIso();
  return state;
}

export function removeRepoSelection(state: RepoRootsState, repoPath: string): RepoRootsState {
  const resolvedRepoPath = resolve(repoPath);
  for (const root of Object.values(state.roots)) {
    root.selectedRepoPaths = root.selectedRepoPaths.filter((item) => resolve(item) !== resolvedRepoPath);
  }
  return state;
}

export function repoExists(repoPath: string): boolean {
  return existsSync(repoPath) && statSync(repoPath).isDirectory();
}
