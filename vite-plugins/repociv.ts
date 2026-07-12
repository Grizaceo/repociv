// ─── RepoCiv — Vite Plugin ───────────────────────────────────────────────────
// Extracted from vite.config.ts to keep the config file lean.
// Provides:
//   - /api/repos          — workspace scan
//   - /api/repos/refresh  — cache invalidation
//   - /api/map-root       — GET/POST map root
//   - /api/map-root/pick  — system folder dialog
//   - /api/repo/pick      — pick individual repo
//   - /api/repo/inspect   — inspect arbitrary path
//   - /api/git/:name      — git status
//   - /api/files/:name    — file listing
//   - /api/skill-health/  — skill metadata freshness
//   - /api/session-tint/  — session recency tint
//   - /event POST         — bridge event relay → Vite HMR WS

import type { Plugin, Connect } from 'vite';
import { execFileSync, execSync } from 'node:child_process';
import { readdirSync, statSync, lstatSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, basename, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir, platform } from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import type { ScannedRepo } from '../src/map.ts';
import {
  addRepoSelection,
  decodeRepoId,
  encodeRepoId,
  ensureRoot,
  loadState,
  removeRepoSelection,
  repoExists,
  saveState,
  setRootSelection,
  summarizeState,
  type RepoRootsState,
} from './repoRootsState.ts';
import skipDirsJson from '../shared/skip-dirs.json' with { type: 'json' };

// ─── Types ───────────────────────────────────────────────────────────────────

// ─── Path helpers ─────────────────────────────────────────────────────────────

export const SKIP_DIRS = new Set(skipDirsJson);

export function expandUser(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

type GitExecutor = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; stdio: ['ignore', 'pipe', 'ignore'] },
) => string | Buffer;

export function runGit(
  repoPath: string,
  args: string[],
  execute: GitExecutor = execFileSync,
): string {
  const output = execute('git', ['-C', resolve(repoPath), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return String(output).trim();
}

function tryRunGit(repoPath: string, args: string[]): string {
  try {
    return runGit(repoPath, args);
  } catch {
    return '';
  }
}

function isContainedPath(candidatePath: string, rootPath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function realContainedPath(candidatePath: string, roots: string[]): string | null {
  try {
    const candidateReal = realpathSync(candidatePath);
    for (const root of roots) {
      try {
        const rootReal = realpathSync(root);
        if (isContainedPath(candidateReal, rootReal)) return candidateReal;
      } catch {
        // Ignore stale configured roots.
      }
    }
  } catch {
    // Missing or unreadable candidates are not selectable repos.
  }
  return null;
}

export function resolveSelectedRepoPath(
  repoIdOrName: string,
  state: RepoRootsState,
): string | null {
  let decoded: string | null;
  try {
    const raw = decodeURIComponent(repoIdOrName);
    decoded = decodeRepoId(raw);
    if (!decoded && !raw.includes('/') && !raw.includes('\\') && raw !== '.' && raw !== '..') {
      const matches = Object.values(state.roots)
        .flatMap((entry) => entry.selectedRepoPaths)
        .filter((repoPath) => basename(repoPath) === raw);
      if (matches.length === 1) decoded = matches[0] ?? null;
    }
  } catch {
    return null;
  }
  if (!decoded) return null;

  const resolvedDecoded = resolve(expandUser(decoded));
  for (const [rootPath, entry] of Object.entries(state.roots)) {
    const selected = entry.selectedRepoPaths.find(
      (repoPath) => resolve(expandUser(repoPath)) === resolvedDecoded,
    );
    if (!selected) continue;
    const candidate = realContainedPath(selected, [rootPath]);
    return candidate && repoExists(candidate) ? candidate : null;
  }
  return null;
}

type MutationHeaders = Record<string, string | string[] | undefined>;

function firstHeader(headers: MutationHeaders, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function tokenMatches(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function isTrustedJsonMutation(headers: MutationHeaders, expectedToken: string): boolean {
  const contentType = firstHeader(headers, 'content-type').split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return false;

  if (tokenMatches(firstHeader(headers, 'x-repociv-token'), expectedToken)) return true;

  const host = firstHeader(headers, 'host').trim().toLowerCase();
  const origin = firstHeader(headers, 'origin').trim();
  if (!host || !origin) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.host.toLowerCase() === host
    );
  } catch {
    return false;
  }
}

export function resolveRepoRelativeFile(repoPath: string, filePath: string): string | null {
  if (!filePath || filePath.includes('\0') || filePath.includes('\\')) return null;
  if (isAbsolute(filePath) || /^[A-Za-z]:[\\/]/.test(filePath)) return null;

  let repoReal: string;
  try {
    repoReal = realpathSync(repoPath);
  } catch {
    return null;
  }

  const candidate = resolve(repoReal, filePath);
  if (!isContainedPath(candidate, repoReal)) return null;

  // Walk existing path segments with lstat so broken symlinks are visible and
  // symlinked directories cannot redirect a later missing file outside.
  let cursor = repoReal;
  for (const segment of relative(repoReal, candidate).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        const resolvedLink = realpathSync(cursor);
        if (!isContainedPath(resolvedLink, repoReal)) return null;
      }
    } catch {
      // Missing regular paths are valid for historical git queries, but a
      // broken symlink is not: lstat succeeds and realpath throws above.
      try {
        if (lstatSync(cursor).isSymbolicLink()) return null;
      } catch {
        break;
      }
    }
  }

  // Resolve the closest existing ancestor as a second containment check.
  let existing = candidate;
  while (!existsSync(existing) && existing !== repoReal) existing = dirname(existing);
  try {
    if (!isContainedPath(realpathSync(existing), repoReal)) return null;
  } catch {
    return null;
  }

  return relative(repoReal, candidate).split(sep).join('/');
}

// ─── Repo scanning ────────────────────────────────────────────────────────────

export function scanRepoPath(repoPath: string, rootPath?: string): ScannedRepo {
  const resolvedRepoPath = resolve(repoPath);
  const exts: Record<string, number> = {};
  const population = countFiles(resolvedRepoPath, exts);
  const { commits, days, hasGit } = gitStats(resolvedRepoPath);
  return {
    name: basename(resolvedRepoPath),
    path: encodeRepoId(resolvedRepoPath),
    repoPath: resolvedRepoPath,
    rootPath: rootPath ? resolve(rootPath) : undefined,
    population,
    extensions: exts,
    gold: commits,
    lastCommitDays: days,
    isLegacy: days > 180,
    hasGit,
  };
}

export function countFiles(dir: string, exts: Record<string, number>, depth = 0): number {
  if (depth > 6) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        total += countFiles(full, exts, depth + 1);
      } else if (st.isFile()) {
        total++;
        const dot = entry.lastIndexOf('.');
        if (dot > 0) {
          const ext = entry.slice(dot + 1).toLowerCase();
          if (ext.length <= 6) exts[ext] = (exts[ext] ?? 0) + 1;
        }
      }
    }
  } catch {
    /* unreadable */
  }
  return total;
}

export function gitStats(repo: string): { commits: number; days: number; hasGit: boolean } {
  if (!existsSync(join(repo, '.git'))) return { commits: 0, days: 999, hasGit: false };
  try {
    const commits = parseInt(tryRunGit(repo, ['rev-list', '--count', 'HEAD']), 10) || 0;
    const lastTs = parseInt(tryRunGit(repo, ['log', '-1', '--format=%ct']), 10) || 0;
    const days = lastTs === 0 ? 999 : Math.floor((Date.now() / 1000 - lastTs) / 86400);
    return { commits, days, hasGit: true };
  } catch {
    return { commits: 0, days: 999, hasGit: true };
  }
}

export function makeScanWorkspace(getMapRoot: () => string, getMapRoots?: () => string[]) {
  let cachedRepos: ScannedRepo[] | null = null;
  let cachedRootsKey: string | null = null;
  let cwdReal: string | null = null;
  try {
    cwdReal = realpathSync(process.cwd());
  } catch {
    cwdReal = resolve(process.cwd());
  }

  function scanSingleRoot(mapRoot: string): ScannedRepo[] {
    const repos: ScannedRepo[] = [];
    if (!existsSync(mapRoot)) return repos;
    for (const entry of readdirSync(mapRoot)) {
      const full = join(mapRoot, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (entry.startsWith('.')) continue;
      try {
        if (cwdReal && realpathSync(full) === cwdReal) continue;
      } catch {
        /* skip compare */
      }
      if (entry === 'repociv') continue;
      const repo = scanRepoPath(full, mapRoot);
      repos.push(repo);
    }
    return repos;
  }

  function scanWorkspace(): ScannedRepo[] {
    // Multi-root: scan all roots and deduplicate by resolved path
    const roots = getMapRoots ? getMapRoots() : [getMapRoot()];
    const rootsKey = roots.slice().sort().join('\0');
    if (cachedRepos && cachedRootsKey === rootsKey) return cachedRepos;

    const seen = new Set<string>();
    const repos: ScannedRepo[] = [];
    for (const root of roots) {
      for (const repo of scanSingleRoot(root)) {
        const key = repo.repoPath ?? repo.path;
        if (!seen.has(key)) {
          seen.add(key);
          repos.push(repo);
        }
      }
    }
    cachedRootsKey = rootsKey;
    cachedRepos = repos;
    return repos;
  }

  return {
    scanWorkspace,
    clearCache: () => {
      cachedRepos = null;
      cachedRootsKey = null;
    },
  };
}

// ─── Request body helper ──────────────────────────────────────────────────────

export function readRequestBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolveBody(body));
  });
}

// ─── System folder dialog ─────────────────────────────────────────────────────

function convertWindowsPathToWsl(path: string): string {
  const normalized = path.replace(/\r/g, '').trim();
  try {
    return execSync(`wslpath -u "${normalized.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
  } catch {
    const driveMatch = /^([a-zA-Z]):[\\/](.*)$/.exec(normalized);
    if (!driveMatch) return normalized;
    const drive = driveMatch[1].toLowerCase();
    const tail = driveMatch[2].replace(/\\/g, '/');
    return `/mnt/${drive}/${tail}`;
  }
}

function tryPickWithCommand(command: string): string | null {
  try {
    const output = execSync(command, { encoding: 'utf8' }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function canRunCommand(binary: string): boolean {
  try {
    execSync(`command -v "${binary}"`, { stdio: 'ignore' });
    return true;
  } catch {
    if (binary.endsWith('.exe')) {
      try {
        execSync(`"${binary}" -NoProfile -Command exit`, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function buildEncodedPowershellCommand(executable: string, script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `${executable} -NoProfile -STA -EncodedCommand ${encoded}`;
}

function tryPickWithWindowsDialog(executable: string): string | null {
  const commands = [
    buildEncodedPowershellCommand(
      executable,
      [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public static class WinFg { [DllImport(\\"user32.dll\\")] public static extern bool AllowSetForegroundWindow(uint pid); [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr h); }"',
        '$hostForm = New-Object System.Windows.Forms.Form',
        '$hostForm.TopMost = $true',
        '$hostForm.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
        '$hostForm.Width = 1',
        '$hostForm.Height = 1',
        '$hostForm.Show()',
        '[WinFg]::AllowSetForegroundWindow([uint]0xFFFFFFFF)',
        '[WinFg]::SetForegroundWindow($hostForm.Handle)',
        '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$f.UseDescriptionForTitle = $true',
        '$f.Description = "Selecciona una carpeta"',
        '$picked = $null',
        'if ($f.ShowDialog($hostForm) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $f.SelectedPath }',
        '$hostForm.Close()',
        '$hostForm.Dispose()',
        'if ($picked -ne $null) { $picked }',
      ].join('; '),
    ),
    buildEncodedPowershellCommand(
      executable,
      [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$shell = New-Object -ComObject Shell.Application',
        '$folder = $shell.BrowseForFolder(0, "Selecciona la carpeta raiz del mapa", 0, 0)',
        'if ($folder -ne $null) { $folder.Self.Path }',
      ].join('; '),
    ),
  ];
  for (const command of commands) {
    const picked = tryPickWithCommand(command);
    if (picked) return picked;
  }
  return null;
}

export function pickFolderWithSystemDialog(): string {
  const os = platform();
  if (os === 'darwin') {
    const output = execSync(
      `osascript -e 'POSIX path of (choose folder with prompt "Selecciona la carpeta raiz del mapa")'`,
      { encoding: 'utf8' },
    ).trim();
    if (!output) throw new Error('Dialogo cancelado');
    return output;
  }

  if (os === 'win32') {
    const output = tryPickWithWindowsDialog('powershell');
    if (!output) throw new Error('Dialogo cancelado');
    return output;
  }

  // In WSL, prefer native Windows folder picker first for faster UX.
  if (canRunCommand('powershell.exe')) {
    const windowsPicked = tryPickWithWindowsDialog('powershell.exe');
    if (windowsPicked) return convertWindowsPathToWsl(windowsPicked);
  }

  const linuxCandidateCommands: string[] = [];
  if (canRunCommand('zenity')) {
    linuxCandidateCommands.push(
      `zenity --file-selection --directory --title="Selecciona la carpeta raiz del mapa"`,
    );
  }
  if (canRunCommand('kdialog')) {
    linuxCandidateCommands.push(
      `kdialog --getexistingdirectory "${homedir()}" "Selecciona la carpeta raiz del mapa"`,
    );
  }

  for (const command of linuxCandidateCommands) {
    const picked = tryPickWithCommand(command);
    if (picked) return picked;
  }

  if (canRunCommand('powershell.exe')) {
    const windowsPicked = tryPickWithWindowsDialog('powershell.exe');
    if (windowsPicked) return convertWindowsPathToWsl(windowsPicked);
  }

  throw new Error(
    'No hay dialogo de carpetas disponible. Instala zenity/kdialog o usa WSL con powershell.exe.',
  );
}

export function resolveRepoPathFromId(
  repoIdOrPath: string,
  currentMapRoot: string,
  allowedRoots: string[] = [currentMapRoot],
): string | null {
  let decodedRaw: string;
  try {
    decodedRaw = decodeURIComponent(repoIdOrPath);
  } catch {
    return null;
  }
  const decodedId = decodeRepoId(decodedRaw);
  if (decodedId) return realContainedPath(decodedId, allowedRoots);

  // Plain ids are single folder names under the active root — reject traversal
  // and never accept direct absolute paths from an HTTP route.
  if (
    decodedRaw.startsWith('/') ||
    decodedRaw.startsWith('~') ||
    decodedRaw.includes('/') ||
    decodedRaw.includes('\\') ||
    decodedRaw.includes('..') ||
    decodedRaw.includes('\0')
  ) {
    return null;
  }
  return realContainedPath(join(currentMapRoot, decodedRaw), allowedRoots);
}

function scanSelectedRepos(state: ReturnType<typeof loadState>): ScannedRepo[] {
  const seen = new Set<string>();
  const repos: ScannedRepo[] = [];
  for (const [rootPath, entry] of Object.entries(state.roots)) {
    for (const repoPath of entry.selectedRepoPaths) {
      const resolvedRepoPath = resolve(repoPath);
      if (seen.has(resolvedRepoPath) || !repoExists(resolvedRepoPath)) continue;
      seen.add(resolvedRepoPath);
      repos.push(scanRepoPath(resolvedRepoPath, rootPath));
    }
  }
  return repos;
}

function respondJson(
  res: { setHeader: (name: string, value: string) => void; end: (body: string) => void },
  body: unknown,
): void {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// ─── Main plugin factory ──────────────────────────────────────────────────────

export function repocivPlugin(mapRoot: string): Plugin {
  let server: { ws: { send: (msg: object) => void } } | undefined;
  const expectedToken =
    process.env['REPOCIV_TOKEN']?.trim() ??
    process.env['VITE_REPOCIV_TOKEN']?.trim() ??
    process.env['VITE_BRIDGE_TOKEN']?.trim() ??
    '';
  const rootsState = ensureRoot(loadState(resolve(mapRoot)), resolve(mapRoot));
  saveState(rootsState);
  const getCurrentMapRoot = () => rootsState.activeRoot;
  const getAllMapRoots = () => Object.keys(rootsState.roots).filter((r) => existsSync(r));
  const { scanWorkspace, clearCache } = makeScanWorkspace(getCurrentMapRoot, getAllMapRoots);
  const persistState = () => {
    saveState(rootsState);
    clearCache();
  };

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const rawUrl = req.url ?? '';
    const path = rawUrl.split('?')[0] ?? rawUrl;

    const protectedMutation =
      req.method === 'POST' && (path === '/event' || path.startsWith('/api/'));
    if (
      protectedMutation &&
      !isTrustedJsonMutation((req.headers ?? {}) as MutationHeaders, expectedToken)
    ) {
      const contentType = firstHeader((req.headers ?? {}) as MutationHeaders, 'content-type')
        .split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      res.statusCode = contentType === 'application/json' ? 403 : 415;
      respondJson(res, {
        error:
          res.statusCode === 415 ? 'application/json required' : 'trusted Origin or token required',
      });
      return;
    }

    // Bridge events from bridge.py → frontend HMR websocket
    if (path === '/event' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const event = JSON.parse(body);
          server?.ws.send({ type: 'custom', event: 'bridge:event', data: event });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (path === '/api/repos' && req.method === 'GET') {
      respondJson(res, scanWorkspace());
      return;
    }

    if (path === '/api/repos/selected' && req.method === 'GET') {
      respondJson(res, scanSelectedRepos(rootsState));
      return;
    }

    if (path === '/api/repos/refresh' && req.method === 'POST') {
      clearCache();
      respondJson(res, {
        ok: true,
        count: scanWorkspace().length,
        selectedCount: scanSelectedRepos(rootsState).length,
      });
      return;
    }

    if (path === '/api/repo-selections' && req.method === 'GET') {
      respondJson(res, summarizeState(rootsState));
      return;
    }

    if (path === '/api/repo-selections' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body) as {
          rootPath?: string;
          selectedRepoIds?: string[];
          selectedRepoPaths?: string[];
        };
        const rootPath = resolve(
          expandUser(String(payload.rootPath ?? rootsState.activeRoot ?? '').trim()),
        );
        if (!rootPath || !repoExists(rootPath)) {
          res.statusCode = 400;
          respondJson(res, { error: 'rootPath no es carpeta valida' });
          return;
        }
        const repoPaths = [
          ...(payload.selectedRepoIds ?? []).map((item) => decodeRepoId(String(item)) ?? ''),
          ...(payload.selectedRepoPaths ?? []).map((item) => String(item)),
        ]
          .map((item) => item.trim())
          .filter((item) => item.length > 0 && repoExists(item));
        setRootSelection(rootsState, rootPath, repoPaths);
        persistState();
        respondJson(res, summarizeState(rootsState));
      } catch (e) {
        res.statusCode = 500;
        respondJson(res, { error: String(e) });
      }
      return;
    }

    if (path === '/api/repo-selections/add' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body) as { repoId?: string; repoPath?: string };
        const repoPath = payload.repoPath
          ? resolve(expandUser(String(payload.repoPath)))
          : resolveRepoPathFromId(
              String(payload.repoId ?? ''),
              rootsState.activeRoot,
              getAllMapRoots(),
            );
        if (!repoPath) {
          res.statusCode = 400;
          respondJson(res, { error: 'repoId/repoPath invalido' });
          return;
        }
        addRepoSelection(rootsState, repoPath);
        persistState();
        respondJson(res, summarizeState(rootsState));
      } catch (e) {
        res.statusCode = 500;
        respondJson(res, { error: String(e) });
      }
      return;
    }

    if (path === '/api/repo-selections/remove' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body) as { repoId?: string; repoPath?: string };
        const repoPath = payload.repoPath
          ? resolve(expandUser(String(payload.repoPath)))
          : resolveRepoPathFromId(
              String(payload.repoId ?? ''),
              rootsState.activeRoot,
              getAllMapRoots(),
            );
        if (!repoPath) {
          res.statusCode = 400;
          respondJson(res, { error: 'repoId/repoPath invalido' });
          return;
        }
        removeRepoSelection(rootsState, repoPath);
        persistState();
        respondJson(res, summarizeState(rootsState));
      } catch (e) {
        res.statusCode = 500;
        respondJson(res, { error: String(e) });
      }
      return;
    }

    if (path === '/api/map-root' && req.method === 'GET') {
      respondJson(res, { path: rootsState.activeRoot });
      return;
    }

    if (path === '/api/map-root' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body) as { path?: string };
        const requested = String(payload.path ?? '').trim();
        const resolved = resolve(expandUser(requested));
        if (!requested) {
          res.statusCode = 400;
          respondJson(res, { error: 'path requerido' });
          return;
        }
        if (!repoExists(resolved)) {
          res.statusCode = 400;
          respondJson(res, { error: 'path no es carpeta valida' });
          return;
        }
        ensureRoot(rootsState, resolved);
        persistState();
        respondJson(res, { ok: true, path: rootsState.activeRoot, count: scanWorkspace().length });
      } catch (e) {
        res.statusCode = 500;
        respondJson(res, { error: String(e) });
      }
      return;
    }

    if (path === '/api/map-root/pick' && req.method === 'POST') {
      try {
        const pickedPath = resolve(pickFolderWithSystemDialog());
        if (!repoExists(pickedPath)) {
          res.statusCode = 400;
          respondJson(res, { error: 'carpeta invalida' });
          return;
        }
        ensureRoot(rootsState, pickedPath);
        persistState();
        respondJson(res, { ok: true, path: rootsState.activeRoot, count: scanWorkspace().length });
      } catch (e) {
        res.statusCode = 400;
        respondJson(res, { error: String(e) });
      }
      return;
    }

    if (path === '/api/repo/pick' && req.method === 'POST') {
      try {
        const pickedPath = resolve(pickFolderWithSystemDialog());
        if (!repoExists(pickedPath)) {
          res.statusCode = 400;
          respondJson(res, { error: 'carpeta invalida' });
          return;
        }
        respondJson(res, { ok: true, repo: scanRepoPath(pickedPath, dirname(pickedPath)) });
      } catch (e) {
        res.statusCode = 400;
        respondJson(res, { error: String(e) });
      }
      return;
    }

    if (path === '/api/repo/inspect' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body) as { path?: string };
        const requested = String(payload.path ?? '').trim();
        const resolved = resolve(expandUser(requested));
        if (!requested) {
          res.statusCode = 400;
          respondJson(res, { error: 'path requerido' });
          return;
        }
        if (!repoExists(resolved)) {
          res.statusCode = 400;
          respondJson(res, { error: 'path no es carpeta valida' });
          return;
        }
        respondJson(res, { ok: true, repo: scanRepoPath(resolved, dirname(resolved)) });
      } catch (e) {
        res.statusCode = 500;
        respondJson(res, { error: String(e) });
      }
      return;
    }

    // ── Multi-root management ─────────────────────────────────────────────────
    if (path === '/api/map-roots' && req.method === 'GET') {
      const roots = Object.entries(rootsState.roots).map(([rootPath, entry]) => ({
        path: rootPath,
        label: entry.label,
        isActive: rootPath === rootsState.activeRoot,
        repoCount: existsSync(rootPath)
          ? readdirSync(rootPath).filter((e) => {
              try {
                return statSync(join(rootPath, e)).isDirectory() && !e.startsWith('.');
              } catch {
                return false;
              }
            }).length
          : 0,
        selectedCount: entry.selectedRepoPaths.length,
        addedAt: entry.addedAt,
        lastSeen: entry.lastSeen,
      }));
      respondJson(res, { activeRoot: rootsState.activeRoot, roots });
      return;
    }

    if (path === '/api/map-roots' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body) as { path?: string; label?: string };
        const requested = String(payload.path ?? '').trim();
        const resolved = resolve(expandUser(requested));
        if (!requested) {
          res.statusCode = 400;
          respondJson(res, { error: 'path requerido' });
          return;
        }
        if (!repoExists(resolved)) {
          res.statusCode = 400;
          respondJson(res, { error: 'path no es carpeta valida' });
          return;
        }
        ensureRoot(rootsState, resolved, payload.label);
        persistState();
        respondJson(res, {
          ok: true,
          activeRoot: rootsState.activeRoot,
          root: resolved,
          totalRepos: scanWorkspace().length,
        });
      } catch (e) {
        res.statusCode = 500;
        respondJson(res, { error: String(e) });
      }
      return;
    }

    if (path === '/api/map-roots/activate' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body) as { path?: string };
        const requested = String(payload.path ?? '').trim();
        const resolved = resolve(expandUser(requested));
        if (!rootsState.roots[resolved]) {
          res.statusCode = 404;
          respondJson(res, { error: 'root no registrado' });
          return;
        }
        rootsState.activeRoot = resolved;
        persistState();
        respondJson(res, { ok: true, activeRoot: rootsState.activeRoot });
      } catch (e) {
        res.statusCode = 500;
        respondJson(res, { error: String(e) });
      }
      return;
    }

    if (path === '/api/map-roots/remove' && req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const payload = JSON.parse(body) as { path?: string };
        const requested = String(payload.path ?? '').trim();
        const resolved = resolve(expandUser(requested));
        if (!rootsState.roots[resolved]) {
          res.statusCode = 404;
          respondJson(res, { error: 'root no registrado' });
          return;
        }
        delete rootsState.roots[resolved];
        // If we removed the active root, switch to the first remaining one
        if (rootsState.activeRoot === resolved) {
          const remaining = Object.keys(rootsState.roots);
          rootsState.activeRoot = remaining[0] ?? '';
        }
        persistState();
        respondJson(res, {
          ok: true,
          activeRoot: rootsState.activeRoot,
          totalRepos: scanWorkspace().length,
        });
      } catch (e) {
        res.statusCode = 500;
        respondJson(res, { error: String(e) });
      }
      return;
    }

    if (path === '/api/map-roots/pick' && req.method === 'POST') {
      try {
        const pickedPath = resolve(pickFolderWithSystemDialog());
        if (!repoExists(pickedPath)) {
          res.statusCode = 400;
          respondJson(res, { error: 'carpeta invalida' });
          return;
        }
        ensureRoot(rootsState, pickedPath);
        persistState();
        respondJson(res, {
          ok: true,
          activeRoot: rootsState.activeRoot,
          root: pickedPath,
          totalRepos: scanWorkspace().length,
        });
      } catch (e) {
        res.statusCode = 400;
        respondJson(res, { error: String(e) });
      }
      return;
    }

    if (path.startsWith('/api/git/') && req.method === 'GET') {
      const name = path.slice('/api/git/'.length);
      const repoPath = resolveSelectedRepoPath(name, rootsState);
      if (!repoPath || !existsSync(join(repoPath, '.git'))) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'No git repo' }));
        return;
      }
      try {
        const qs = new URLSearchParams(rawUrl.includes('?') ? rawUrl.split('?')[1]! : '');
        const file = qs.get('file');

        if (file) {
          const safeFile = resolveRepoRelativeFile(repoPath, file);
          if (!safeFile) {
            res.statusCode = 400;
            respondJson(res, { error: 'file path invalido' });
            return;
          }
          // Per-file git history + blame. The requested path remains one argv
          // element; no shell parser is involved.
          const logRaw = tryRunGit(repoPath, ['log', '--oneline', '-n', '5', '--', safeFile]);
          const blameRaw = tryRunGit(repoPath, [
            'blame',
            '-L',
            '1,15',
            '--porcelain',
            '--',
            safeFile,
          ]);

          const log = logRaw ? logRaw.split('\n').filter(Boolean) : [];
          const blame: Array<{ line: number; author: string; date: string }> = [];
          if (blameRaw) {
            const blameLines = blameRaw.split('\n');
            let currentAuthor = '';
            let currentTime = 0;
            let lineNum = 0;
            for (const line of blameLines) {
              if (line.startsWith('author ')) {
                currentAuthor = line.slice(7);
              } else if (line.startsWith('author-time ')) {
                currentTime = parseInt(line.slice(12), 10);
              } else if (line.startsWith('\t')) {
                lineNum++;
                blame.push({
                  line: lineNum,
                  author: currentAuthor.slice(0, 20),
                  date: currentTime ? new Date(currentTime * 1000).toLocaleDateString() : '',
                });
              }
            }
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ log, blame }));
          return;
        }

        // Repo-wide git summary.
        const status = tryRunGit(repoPath, ['status', '--short']);
        const branch = tryRunGit(repoPath, ['branch', '--show-current']);
        const lastCommit = tryRunGit(repoPath, ['log', '-1', '--pretty=format:%h|%s|%ar']);
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            branch,
            lastCommit,
            changes: status.split('\n').filter(Boolean).slice(0, 50),
          }),
        );
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (path.startsWith('/api/files/') && req.method === 'GET') {
      const name = path.slice('/api/files/'.length);
      const repoPath = resolveSelectedRepoPath(name, rootsState);
      if (!repoPath || !existsSync(repoPath)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      try {
        const files: string[] = [];
        const walk = (d: string, rel: string, depth: number) => {
          if (depth > 3 || files.length > 200) return;
          for (const e of readdirSync(d)) {
            if (SKIP_DIRS.has(e) || e.startsWith('.')) continue;
            const full = join(d, e);
            let st;
            try {
              st = statSync(full);
            } catch {
              continue;
            }
            const r = rel ? `${rel}/${e}` : e;
            if (st.isDirectory()) walk(full, r, depth + 1);
            else files.push(r);
            if (files.length > 200) return;
          }
        };
        walk(repoPath, '', 0);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ files }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (path.startsWith('/api/skill-health/') && req.method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/skill-health/'.length));
      const skillPath = join(homedir(), '.hermes', 'skills', name);
      let health: 'ok' | 'stale' | 'broken' = 'broken';
      try {
        if (existsSync(skillPath)) {
          const days = (Date.now() - statSync(skillPath).mtimeMs) / 86_400_000;
          health = days < 7 ? 'ok' : days < 30 ? 'stale' : 'broken';
        }
      } catch {
        /* keep broken */
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ health }));
      return;
    }

    if (path.startsWith('/api/session-tint/') && req.method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/session-tint/'.length));
      const sessDir = join(homedir(), '.hermes', 'sessions');
      let tint: 'bright' | 'normal' | 'fog' = 'fog';
      try {
        if (existsSync(sessDir)) {
          const files = readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'));
          let latestMs = 0;
          for (const f of files) {
            try {
              const content = readFileSync(join(sessDir, f), 'utf8');
              if (content.includes(name)) {
                const ms = statSync(join(sessDir, f)).mtimeMs;
                if (ms > latestMs) latestMs = ms;
              }
            } catch {
              /* skip */
            }
          }
          if (latestMs > 0) {
            const days = (Date.now() - latestMs) / 86_400_000;
            tint = days < 7 ? 'bright' : days < 30 ? 'normal' : 'fog';
          }
        }
      } catch {
        /* keep fog */
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ tint }));
      return;
    }

    next();
  };

  return {
    name: 'repociv-api',
    configureServer(s) {
      server = s as typeof server;
      s.middlewares.use(handler);
      console.log(`[repociv] Active map root: ${getCurrentMapRoot()}`);
      console.log('[repociv] Workspace se escaneara bajo demanda (/api/repos)');
    },
  };
}
