import { defineConfig, devices } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ─── Browser resolution ────────────────────────────────────────────────────
// Playwright's bundled Chromium is a ~150MB download. Plenty of dev machines
// already ship a system Chromium (Omarchy/Arch ships /usr/bin/chromium), and
// on those `npx playwright test` should just work instead of demanding the
// download first.
//
// Precedence:
//   1. PLAYWRIGHT_CHROMIUM_PATH — explicit override, always wins.
//   2. A system Chromium, when not on CI (CI images rarely have one, and
//      silently using a different browser there would be a surprise).
//   3. Playwright's own bundled Chromium.
const SYSTEM_CHROMIUM_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function resolveChromiumPath(): string | undefined {
  const override = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  if (override) return existsSync(override) ? override : undefined;
  if (process.env.CI) return undefined;
  return SYSTEM_CHROMIUM_PATHS.find((p) => existsSync(p));
}

const chromiumPath = resolveChromiumPath();

function loadDotEnv(path = '.env') {
  const full = resolve(path);
  if (!existsSync(full)) return;
  const raw = readFileSync(full, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!key) continue;
    const value = rest
      .join('=')
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// ─── Isolation from the live dashboard ─────────────────────────────────────
// The e2e stack gets its own ports and its own state root unless the caller
// pins them. Applied BEFORE loading .env so a developer .env (VITE_PORT=5273,
// REPOCIV_CONFIG_DIR=~/.repociv) cannot point the run at the live service:
// with the old defaults plus reuseExistingServer, a local `npx playwright test`
// silently drove the live bridge and wrote its events/ledger (2026-10-14/15).
const E2E_DEFAULTS: Record<string, string> = {
  REPOCIV_PORT: '5373',
  VITE_PORT: '5373',
  BRIDGE_PORT: '5374',
  BRIDGE_WS_PORT: '5375',
};
for (const [key, value] of Object.entries(E2E_DEFAULTS)) process.env[key] ??= value;
process.env.REPOCIV_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'repociv-e2e-'));

// REPOCIV_SKIP_DOTENV=1 (set by scripts/e2e-ci-sim.sh) keeps a developer .env —
// live token, Hermes endpoints — out of the run, as on CI.
if (process.env.REPOCIV_SKIP_DOTENV !== '1') loadDotEnv();

// Reusing an already-running server is opt-in: it is how a run ends up writing
// into whatever stack owns the port. PLAYWRIGHT_BASE_URL targets one on purpose.
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVER === '1';

const uiPort = Number(process.env.REPOCIV_PORT ?? process.env.VITE_PORT);
const bridgePort = Number(process.env.BRIDGE_PORT);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${uiPort}`;
const bridgeURL = process.env.VITE_BRIDGE_URL ?? `http://127.0.0.1:${bridgePort}`;
const bridgePython = existsSync('.venv/bin/python') ? '.venv/bin/python' : 'python3';

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/_debug/**'],
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: `${bridgePython} -m server.bridge`,
      url: `${bridgeURL}/health`,
      reuseExistingServer,
      timeout: 15_000,
      env: process.env as Record<string, string>,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${uiPort}`,
      url: baseURL,
      reuseExistingServer,
      timeout: 20_000,
      env: process.env as Record<string, string>,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumPath
          ? {
              launchOptions: {
                executablePath: chromiumPath,
                // The macro hex map defaults to the WebGL renderer, and a
                // headless system Chromium has no GPU. Playwright's bundled
                // build enables software GL by default; a distro Chromium does
                // not, so the map renders nothing and every city position comes
                // back empty. Opt into SwiftShader explicitly.
                args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
              },
            }
          : {}),
      },
    },
  ],
});
