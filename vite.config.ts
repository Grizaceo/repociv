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
        thresholds: { lines: 55, branches: 70 },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('/node_modules/')) {
              return undefined;
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
