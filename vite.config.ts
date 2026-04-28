import { defineConfig } from 'vite';
import type { Plugin, Connect } from 'vite';
import { execSync } from 'node:child_process';
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

// ─── Workspace path ──────────────────────────────────────────────────────────
const WORKSPACE = join(homedir(), '.hermes', 'workspace', 'repos');

// ─── Repo scanning ───────────────────────────────────────────────────────────
interface ScannedRepo {
  name: string;
  path: string;
  population: number;
  extensions: Record<string, number>;
  gold: number;
  lastCommitDays: number;
  isLegacy: boolean;
  hasGit: boolean;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.next',
  '__pycache__', '.venv', 'venv', '.pytest_cache', '.cache',
  'checkpoints', '.turbo', '.parcel-cache',
]);

function countFiles(dir: string, exts: Record<string, number>, depth = 0): number {
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

function gitStats(repo: string): { commits: number; days: number; hasGit: boolean } {
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

let cachedRepos: ScannedRepo[] | null = null;
function scanWorkspace(): ScannedRepo[] {
  if (cachedRepos) return cachedRepos;
  const repos: ScannedRepo[] = [];
  if (!existsSync(WORKSPACE)) return repos;
  for (const entry of readdirSync(WORKSPACE)) {
    const full = join(WORKSPACE, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (entry.startsWith('.')) continue;
    if (entry === 'repociv') continue;  // self
    const exts: Record<string, number> = {};
    const population = countFiles(full, exts);
    const { commits, days, hasGit } = gitStats(full);
    repos.push({
      name: basename(full),
      path: entry,
      population,
      extensions: exts,
      gold: commits,
      lastCommitDays: days,
      isLegacy: days > 180,
      hasGit,
    });
  }
  cachedRepos = repos;
  return repos;
}

// ─── API + Bridge plugin ─────────────────────────────────────────────────────
function repocivPlugin(): Plugin {
  let server: { ws: { send: (msg: object) => void } } | undefined;

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = req.url ?? '';

    // Bridge events from bridge.py → frontend
    if (url === '/event' && req.method === 'POST') {
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

    // Real workspace scan
    if (url === '/api/repos' && req.method === 'GET') {
      const repos = scanWorkspace();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(repos));
      return;
    }

    // Force refresh of cache
    if (url === '/api/repos/refresh' && req.method === 'POST') {
      cachedRepos = null;
      const repos = scanWorkspace();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, count: repos.length }));
      return;
    }

    // Git status for a specific repo
    if (url.startsWith('/api/git/') && req.method === 'GET') {
      const name = url.slice('/api/git/'.length);
      const repoPath = join(WORKSPACE, name);
      if (!existsSync(join(repoPath, '.git'))) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'No git repo' }));
        return;
      }
      try {
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

    // Files in a repo
    if (url.startsWith('/api/files/') && req.method === 'GET') {
      const name = url.slice('/api/files/'.length).split('?')[0]!;
      const repoPath = join(WORKSPACE, name);
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

    // Skill health for a repo
    if (url.startsWith('/api/skill-health/') && req.method === 'GET') {
      const name = decodeURIComponent(url.slice('/api/skill-health/'.length));
      const skillPath = join(homedir(), '.hermes', 'skills', name);
      let health: 'ok' | 'stale' | 'broken' = 'broken';
      try {
        if (existsSync(skillPath)) {
          const mtimeMs = statSync(skillPath).mtimeMs;
          const days = (Date.now() - mtimeMs) / 86_400_000;
          health = days < 7 ? 'ok' : days < 30 ? 'stale' : 'broken';
        }
      } catch { /* keep broken */ }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ health }));
      return;
    }

    // Session tint for a repo (based on ~/.hermes/sessions/*.jsonl)
    if (url.startsWith('/api/session-tint/') && req.method === 'GET') {
      const name = decodeURIComponent(url.slice('/api/session-tint/'.length));
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
      // Pre-warm cache at startup
      console.log('[repociv] Scaneando workspace...');
      const repos = scanWorkspace();
      console.log(`[repociv] ${repos.length} repos detectados`);
    },
  };
}

export default defineConfig({
  plugins: [repocivPlugin()],
  server: { port: 5273, strictPort: true },
});
