// Capture a close-up of the capital + 2 wonders (bibliotheca at q=-1, institutum at q=+1).
// Camera: zoomed to capital, with the 2 wonders in frame.
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(SCRIPT_DIR, '..');
const OUT = join(REPO_ROOT, '.hermes/artifacts/f5-wonders');
mkdirSync(OUT, { recursive: true });

const FIXED_SEED = {
  version: 1,
  selectedRepoPaths: [
    '/tmp/repociv-fixtures/repo-alpha',
    '/tmp/repociv-fixtures/repo-beta',
    '/tmp/repociv-fixtures/repo-gamma',
    '/tmp/repociv-fixtures/repo-delta',
    '/tmp/repociv-fixtures/repo-epsilon',
    '/tmp/repociv-fixtures/repo-zeta',
  ],
  filters: { owners: [], topics: [], languages: [] },
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await ctx.addInitScript((seedJson) => {
  let s = 123456789;
  Math.random = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0x100000000; };
  Date.now = () => 1700000000000;
  // Pre-seed localStorage so the first goto already has the right seed
  // (avoids the cam-URL being applied before the seed lands).
  localStorage.setItem('repociv:selected-repos:v1', seedJson);
  localStorage.setItem('repociv:renderer', 'webgl');
}, JSON.stringify(FIXED_SEED));
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('[ERR]', e.message));

// Camera 1: zoomed to capital (covers both wonders)
const cameras = [
  { name: 'capital-with-wonders',  cam: 'auto,1.6' },
  { name: 'wonder-closeup-wide',   cam: 'auto,2.0' },
  { name: 'wonder-closeup-tight',  cam: 'auto,2.6' },
];

for (const { name, cam } of cameras) {
  // Full page reload to ensure applyCameraFromUrl runs against the new cam.
  await page.goto(`http://localhost:5273/?renderer=webgl&freeze=2&reveal=all&cam=${encodeURIComponent(cam)}`, { waitUntil: 'networkidle' });
  await page.locator('#three-container canvas').waitFor({ state: 'attached', timeout: 15000 });
  await page.locator('#loading-screen').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.getElementById('imperial-welcome')?.remove());
  await page.addStyleTag({ content: '#hud-overlay{display:none!important}' });
  await page.waitForFunction(() => window.__repocivDebug?.isTerrainAtlasReady?.() === true, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('wrote', name);
}

await browser.close();
