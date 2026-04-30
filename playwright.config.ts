import { defineConfig, devices } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDotEnv(path = '.env') {
  const full = resolve(path);
  if (!existsSync(full)) return;
  const raw = readFileSync(full, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!key) continue;
    const value = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const uiPort = Number(process.env.REPOCIV_PORT ?? process.env.VITE_PORT ?? 5273);
const bridgePort = Number(process.env.BRIDGE_PORT ?? 5274);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${uiPort}`;
const bridgeURL = process.env.VITE_BRIDGE_URL ?? `http://127.0.0.1:${bridgePort}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
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
      command: `python3 -m server.bridge`,
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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
