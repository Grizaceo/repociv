/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { repocivPlugin, expandUser } from './vite-plugins/repociv.ts';

const DEFAULT_MAP_ROOT = join(homedir(), '.hermes', 'workspace', 'repos');

/** Imperial map scan root: REPOCIV_MAP_ROOT → WORKSPACE_ROOT → REPOCIV_REPOS_ROOT → Hermes repos. */
function resolveMapRoot(mode: string): string {
  const env = loadEnv(mode, process.cwd(), '');
  const pick = (key: string): string | undefined => {
    const v = process.env[key] ?? env[key];
    return v !== undefined && String(v).trim() !== '' ? String(v).trim() : undefined;
  };
  const raw =
    pick('REPOCIV_MAP_ROOT') ??
    pick('WORKSPACE_ROOT') ??
    pick('REPOCIV_REPOS_ROOT') ??
    DEFAULT_MAP_ROOT;
  return resolve(expandUser(raw));
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const vitePort = parseInt(env.VITE_PORT ?? '5273', 10);
  const mapRoot = resolveMapRoot(mode);
  return {
    plugins: [repocivPlugin(mapRoot)],
    server: {
      port: vitePort,
      strictPort: true,
      host: true,
      // The dev-server HMR watcher must not traverse the Python venv or the
      // build/e2e output trees — under WSL2's inotify that exhausts watchers
      // (ENOSPC) and crashes `npm run dev` mid-startup. node_modules is
      // already ignored by default; these are the repo-local trees that
      // aren't.
      watch: {
        ignored: ['**/.venv/**', '**/dist/**', '**/.hermes/**', '**/e2e/**'],
      },
      proxy: {
        '/bridge': {
          target: `http://localhost:${env.BRIDGE_PORT ?? '5274'}`,
          changeOrigin: true,
          ws: true, // WebSocket upgrade passthrough (Phase 1)
          secure: false,
          rewrite: (path) => path.replace(/^\/bridge/, ''),
        },
      },
    },
    test: {
      exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        include: ['src/**/*.ts'],
        exclude: [
          'src/**/*.test.ts',
          'src/local.demo.ts',
          'src/**/*.d.ts',
          // DOM/Canvas rendering files — untestable in jsdom
          'src/ui/**',
          'src/renderer.ts',
          'src/unitRenderer.ts',
          'src/hexRenderer.ts',
          'src/terminalPanel.ts',
          'src/spatialDirectives.ts',
          'src/localRenderer.ts',
          'src/minimapRenderer.ts',
          'src/localWorldManager.ts',
          'src/main.ts',
        ],
        // Anti-regression FLOOR over the measured core (src/ui/** is excluded
        // above). Set just below current actual (lines 44.98 / branches 38.3 /
        // funcs 52.58 / stmts 44.26 as of 2026-06-20) so the gate catches a real
        // drop without nagging on noise. Now ENFORCED — scripts/check.sh runs
        // vitest with --coverage. Ratchet upward as coverage grows; broadening
        // the src/ui/** exclusion is a follow-up (plan P1.4).
        thresholds: { lines: 43, branches: 36, functions: 50, statements: 42 },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('/node_modules/')) {
              return undefined;
            }
            // Three.js (~600 kB) is only reached via the dynamic import in
            // renderMode.ts (ThreeMapRenderer). Give it its own chunk so the
            // catch-all 'vendor' below — which a statically-imported dep keeps
            // eager — doesn't drag Three into the initial 2D-canonical load.
            if (id.includes('/three/')) {
              return 'vendor-three';
            }
            if (id.includes('/lucide/')) {
              return 'vendor-icons';
            }
            if (id.includes('/valibot/')) {
              return 'vendor-schema';
            }
            if (id.includes('/@xterm/')) {
              return 'vendor-terminal';
            }
            if (id.includes('/@formkit/')) {
              return 'vendor-ui';
            }
            return 'vendor';
          },
        },
        onLog(level, log, handler) {
          // Suppress known circular-dep dynamic-import warning:
          // agentChip.ts ↔ history.ts: dynamic import breaks init cycle.
          if (
            log.message?.includes('history.ts is dynamically imported') &&
            log.message?.includes('also statically imported')
          ) {
            return;
          }
          handler(level, log);
        },
      },
    },
  };
});
