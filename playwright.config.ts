import { defineConfig, devices } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

loadDotEnv();

const uiPort = Number(process.env.REPOCIV_PORT ?? process.env.VITE_PORT ?? 5273);
const bridgePort = Number(process.env.BRIDGE_PORT ?? 5274);
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
      reuseExistingServer: true,
      timeout: 15_000,
      env: process.env as Record<string, string>,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${uiPort}`,
      url: baseURL,
      reuseExistingServer: true,
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
