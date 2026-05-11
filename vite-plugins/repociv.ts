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
import { execSync } from 'node:child_process';
import { readdirSync, statSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import skipDirsJson from '../shared/skip-dirs.json' with { type: 'json' };

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScannedRepo {
  name: string;
  path: string;
  population: number;
  extensions: Record<string, number>;
  gold: number;
  lastCommitDays: number;
  isLegacy: boolean;
  hasGit: boolean;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

export const SKIP_DIRS = new Set(skipDirsJson);

export function expandUser(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

// ─── Repo scanning ────────────────────────────────────────────────────────────

export function scanRepoPath(repoPath: string): ScannedRepo {
  const exts: Record<string, number> = {};
  const population = countFiles(repoPath, exts);
  const { commits, days, hasGit } = gitStats(repoPath);
  return {
    name: basename(repoPath),
    path: repoPath,
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
      try { st = statSync(full); } catch { continue; }
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
  } catch { /* unreadable */ }
  return total;
}

export function gitStats(repo: string): { commits: number; days: number; hasGit: boolean } {
  if (!existsSync(join(repo, '.git'))) return { commits: 0, days: 999, hasGit: false };
  try {
    const commits = parseInt(
      execSync(`git -C "${repo}" rev-list --count HEAD 2>/dev/null || echo 0`,
        { encoding: 'utf8' }).trim(), 10) || 0;
    const lastTs = parseInt(
      execSync(`git -C "${repo}" log -1 --format=%ct 2>/dev/null || echo 0`,
        { encoding: 'utf8' }).trim(), 10) || 0;
    const days = lastTs === 0 ? 999 : Math.floor((Date.now() / 1000 - lastTs) / 86400);
    return { commits, days, hasGit: true };
  } catch {
    return { commits: 0, days: 999, hasGit: true };
  }
}

export function makeScanWorkspace(getMapRoot: () => string) {
  let cachedRepos: ScannedRepo[] | null = null;
  let cachedRoot: string | null = null;
  let cwdReal: string | null = null;
  try {
    cwdReal = realpathSync(process.cwd());
  } catch {
    cwdReal = resolve(process.cwd());
  }

  function scanWorkspace(): ScannedRepo[] {
    const mapRoot = getMapRoot();
    if (cachedRepos && cachedRoot === mapRoot) return cachedRepos;
    const repos: ScannedRepo[] = [];
    if (!existsSync(mapRoot)) return repos;
    for (const entry of readdirSync(mapRoot)) {
      const full = join(mapRoot, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (entry.startsWith('.')) continue;
      try {
        if (cwdReal && realpathSync(full) === cwdReal) continue;
      } catch {
        /* skip compare */
      }
      if (entry === 'repociv') continue;
      const repo = scanRepoPath(full);
      repos.push({ ...repo, path: entry });
    }
    cachedRoot = mapRoot;
    cachedRepos = repos;
    return repos;
  }

  return {
    scanWorkspace,
    clearCache: () => {
      cachedRepos = null;
      cachedRoot = null;
    },
  };
}

// ─── Request body helper ──────────────────────────────────────────────────────

export function readRequestBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
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

// ─── Main plugin factory ──────────────────────────────────────────────────────

export function repocivPlugin(mapRoot: string): Plugin {
  let server: { ws: { send: (msg: object) => void } } | undefined;
  let currentMapRoot = mapRoot;
  const { scanWorkspace, clearCache } = makeScanWorkspace(() => currentMapRoot);

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const rawUrl = req.url ?? '';
    const path = rawUrl.split('?')[0] ?? rawUrl;

    // Bridge events from bridge.py → frontend HMR websocket
    if (path === '/event' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const event = JSON.parse(body);
          server?.ws.send({ type: 'custom', event: 'bridge:event', data: event });
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    if (path === '/api/repos' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(scanWorkspace()));
      return;
    }

    if (path === '/api/repos/refresh' && req.method === 'POST') {
      clearCache();
      const repos = scanWorkspace();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, count: repos.length }));
      return;
    }

    if (path === '/api/map-root' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ path: currentMapRoot }));
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
          res.end(JSON.stringify({ error: 'path requerido' }));
          return;
        }
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'path no es carpeta valida' }));
          return;
        }
        currentMapRoot = resolved;
        clearCache();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, path: currentMapRoot, count: scanWorkspace().length }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (path === '/api/map-root/pick' && req.method === 'POST') {
      try {
        const pickedPath = resolve(pickFolderWithSystemDialog());
        if (!existsSync(pickedPath) || !statSync(pickedPath).isDirectory()) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'carpeta invalida' }));
          return;
        }
        currentMapRoot = pickedPath;
        clearCache();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, path: currentMapRoot, count: scanWorkspace().length }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (path === '/api/repo/pick' && req.method === 'POST') {
      try {
        const pickedPath = resolve(pickFolderWithSystemDialog());
        if (!existsSync(pickedPath) || !statSync(pickedPath).isDirectory()) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'carpeta invalida' }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, repo: scanRepoPath(pickedPath) }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(e) }));
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
          res.end(JSON.stringify({ error: 'path requerido' }));
          return;
        }
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'path no es carpeta valida' }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, repo: scanRepoPath(resolved) }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (path.startsWith('/api/git/') && req.method === 'GET') {
      const name = path.slice('/api/git/'.length);
      const repoPath = join(currentMapRoot, name);
      if (!existsSync(join(repoPath, '.git'))) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'No git repo' }));
        return;
      }
      try {
        const qs = new URLSearchParams(rawUrl.includes('?') ? rawUrl.split('?')[1]! : '');
        const file = qs.get('file');

        if (file) {
          // Per-file git history + blame
          const logRaw = execSync(
            `git -C "${repoPath}" log --oneline -n 5 -- "${file}" 2>/dev/null || true`,
            { encoding: 'utf8' },
          ).trim();
          const blameRaw = execSync(
            `git -C "${repoPath}" blame -L 1,15 --porcelain -- "${file}" 2>/dev/null || true`,
            { encoding: 'utf8' },
          ).trim();

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

        // Repo-wide git summary (existing behaviour)
        const status = execSync(`git -C "${repoPath}" status --short 2>/dev/null || true`,
          { encoding: 'utf8' }).trim();
        const branch = execSync(`git -C "${repoPath}" branch --show-current 2>/dev/null || echo`,
          { encoding: 'utf8' }).trim();
        const lastCommit = execSync(
          `git -C "${repoPath}" log -1 --pretty=format:'%h|%s|%ar' 2>/dev/null || echo`,
          { encoding: 'utf8' }).trim();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          branch, lastCommit,
          changes: status.split('\n').filter(Boolean).slice(0, 50),
        }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    if (path.startsWith('/api/files/') && req.method === 'GET') {
      const name = path.slice('/api/files/'.length);
      const repoPath = join(currentMapRoot, name);
      if (!existsSync(repoPath)) {
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
            try { st = statSync(full); } catch { continue; }
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
      } catch { /* keep broken */ }
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
          const files = readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
          let latestMs = 0;
          for (const f of files) {
            try {
              const content = readFileSync(join(sessDir, f), 'utf8');
              if (content.includes(name)) {
                const ms = statSync(join(sessDir, f)).mtimeMs;
                if (ms > latestMs) latestMs = ms;
              }
            } catch { /* skip */ }
          }
          if (latestMs > 0) {
            const days = (Date.now() - latestMs) / 86_400_000;
            tint = days < 7 ? 'bright' : days < 30 ? 'normal' : 'fog';
          }
        }
      } catch { /* keep fog */ }
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
      console.log(`[repociv] Map root: ${currentMapRoot}`);
      console.log('[repociv] Workspace se escaneara bajo demanda (/api/repos)');
    },
  };
}
