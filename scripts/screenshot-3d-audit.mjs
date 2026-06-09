#!/usr/bin/env node
/**
 * Visual regression script for the 3D world renderer.
 *
 * Captures the world view from three fixed camera positions and
 * compares them against goldens in e2e/golden/. This is the
 * regression net for the WebGL renderer's visual output: a
 * `computeWorldSignature`-gated dirty-flag fix that changes a single
 * pixel still fails this gate, but so does an unintended
 * shader/material change — which is the point.
 *
 * Run after `npm run dev` is active (or PLAYWRIGHT_BASE_URL set to
 * the deployed host).
 *
 * Usage:
 *   node scripts/screenshot-3d-audit.mjs                # compare mode (default)
 *   node scripts/screenshot-3d-audit.mjs --update       # update goldens
 *   PLAYWRIGHT_BASE_URL=https://host node scripts/screenshot-3d-audit.mjs
 *
 * Determinism contract:
 *   - The seed (selectedRepoPaths) is read from localStorage, written
 *     to a fixed JSON shape before navigation. Same inputs every run.
 *   - Camera is set via ?cam=x,y,zoom URL param. No mouse interaction.
 *   - Wait time after the canvas appears is fixed at 1500 ms. Increase
 *     in the script if a future change needs more time to settle.
 *
 * What this script is NOT:
 *   - A pixelmatch-style perceptual diff. We compare SHA-256 hashes of
 *     the PNG bytes. This catches layout/composition regressions but
 *     NOT small tone changes (e.g. shader light intensity tweaks that
 *     shift every pixel by <1 RGB step). For that we'd need
 *     pixelmatch, which is a larger dependency.
 *   - A headless-renderable test. The actual GL pipeline needs the
 *     browser. Phase 2 keeps it that way to avoid headless GL
 *     compatibility drift.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, existsSync, createHash } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const OUT = join(REPO_ROOT, '.hermes/artifacts/3d-audit');
const GOLDEN = join(REPO_ROOT, 'e2e/golden');
mkdirSync(OUT, { recursive: true });
mkdirSync(GOLDEN, { recursive: true });

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5273';
const updateMode = process.argv.includes('--update');

// Fixed seed: a tiny, fixed repo selection so screenshots are
// reproducible across machines and CI runs. The shapes are stable;
// the actual paths are arbitrary as long as the resulting tile count
// is consistent (we use 6 of the local repos which always exist on
// the dev box).
const FIXED_SEED = {
  version: 1,
  selectedRepoPaths: [
    '/home/gris/.hermes/workspace/repos/repociv',
    '/home/gris/.hermes/workspace/repos/labhub',
    '/home/gris/.hermes/workspace/repos/cdaily',
    '/home/gris/.hermes/workspace/repos/symphony',
    '/home/gris/.hermes/workspace/repos/TradingAgents',
    '/home/gris/.hermes/workspace/repos/labhub-oss',
  ],
  filters: { owners: [], topics: [], languages: [] },
};

// Three fixed cameras. The (x, y) are world-space, not screen-space;
// in a future iteration we'll compute them from the seed's bounding
// box. For now, these are hard-coded for the canonical view.
const CAMERAS = [
  { name: '01-general-overview', cam: '0,0,1' },
  { name: '02-zoomed-mid', cam: '0,0,1.8' },
  { name: '03-zoomed-close', cam: '0,0,3.2' },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  // Pre-seed localStorage with the fixed repo selection so the
  // world is identical on every run.
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((seed) => {
    window.localStorage.setItem('repociv:selected-repos:v1', JSON.stringify(seed));
    // Force flat -> webgl on first frame so the URL ?renderer=webgl is
    // the only thing that controls it. This keeps the test
    // independent of any leftover state from a previous run.
    window.localStorage.setItem('repociv:renderer', 'webgl');
  }, FIXED_SEED);

  // Land on the WebGL view with the first camera. The other two
  // cameras are reachable by re-navigating to a different ?cam.
  const results = [];
  for (const { name, cam } of CAMERAS) {
    const url = `${baseURL}/?renderer=webgl&cam=${encodeURIComponent(cam)}`;
    await page.goto(url, { waitUntil: 'networkidle' });

    // Wait for the canvas to render. We can't read state from the
    // page (no exposed API) so we wait for the canvas to be visible
    // and then a fixed settling time. This is the "no UI
    // dependencies" part of the contract.
    await page.locator('#main-canvas').waitFor({ state: 'visible', timeout: 15_000 });
    // Skip the onboarding overlay if it appears.
    const onboarding = page.locator('#repo-onboarding');
    if (await onboarding.isVisible().catch(() => false)) {
      const nextBtn = page.locator('#repo-onboarding-next');
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(200);
        await nextBtn.click();
      }
      await onboarding.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    }
    // Fixed settle time: the 3D scene needs a few frames to compile
    // shaders, populate the instance buffer, and run the first
    // rebuild. 1.5s is empirically enough on the dev box.
    await page.waitForTimeout(1500);

    const shotPath = join(OUT, `${name}.png`);
    await page.screenshot({ path: shotPath, fullPage: false });
    const hash = sha256(readFileSync(shotPath));
    results.push({ name, shotPath, hash });
    console.log(`[AUDIT] ${name}: ${shotPath} (sha256=${hash.slice(0, 12)}...)`);
  }

  await browser.close();

  // Compare against goldens.
  let diffCount = 0;
  for (const { name, shotPath, hash } of results) {
    const goldenPath = join(GOLDEN, `${name}.sha256`);
    if (updateMode) {
      writeFileSync(goldenPath, hash + '\n');
      console.log(`[GOLDEN] wrote ${goldenPath}`);
      continue;
    }
    if (!existsSync(goldenPath)) {
      console.warn(`[DIFF] ${name}: no golden at ${goldenPath} — run with --update`);
      diffCount++;
      continue;
    }
    const expected = readFileSync(goldenPath, 'utf-8').trim();
    if (expected !== hash) {
      console.error(
        `[DIFF] ${name}: hash mismatch\n  expected: ${expected.slice(0, 12)}...\n  got:      ${hash.slice(0, 12)}...\n  shot:     ${shotPath}`,
      );
      diffCount++;
    } else {
      console.log(`[OK]    ${name}: matches golden`);
    }
  }

  if (!updateMode && diffCount > 0) {
    console.error(`\n[AUDIT] ${diffCount} diff(s) — visual regression detected.`);
    console.error('       If the change is intentional, run with --update to refresh goldens.');
    process.exit(1);
  }
  console.log('\n[AUDIT] visual regression gate complete.');
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

main().catch((err) => {
  console.error('[AUDIT] failed:', err);
  process.exit(1);
});
