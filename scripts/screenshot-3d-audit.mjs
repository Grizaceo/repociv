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
 *   - animTime is pinned via ?freeze=2, so time-driven animations
 *     (shoreline pulse, sun arc, territory shimmer) render identically
 *     regardless of capture-timing jitter.
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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// Three fixed cameras. `auto` keeps the app's own capital-centered focus
// (deterministic given the seed) and overrides only the zoom — absolute
// world coords would need to know the centroid for this seed.
//
// Two additional macro cameras (05, 06) cover the world at low zoom so
// the biomes that the three mid-zoom shots don't frame well (ocean rim,
// mountain clusters, desert spans) are visible. They were added in the
// same commit that swapped to Blender-baked atlas content, so a
// regression in any group's texture changes the same set of hashes.
const CAMERAS = [
  { name: '01-general-overview', cam: 'auto,0.9' },
  { name: '02-zoomed-mid',       cam: 'auto,1.8' },
  { name: '03-zoomed-close',     cam: 'auto,3.2' },
  { name: '05-ocean-macro',      cam: 'auto,0.55' },
  { name: '06-mountain-desert-macro', cam: 'auto,0.50' },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => {
    let seed = 123456789;
    const next = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const fixedNow = 1_700_000_000_000;
    Math.random = () => next();
    Date.now = () => fixedNow;
    // NOTE: do NOT freeze performance.now — the game loop derives dt from
    // it, so freezing it stalls initialization and the capture lands on
    // the welcome screen. Time-driven WebGL animation determinism comes
    // from ?freeze=<s> (pins renderer.animTime) instead.
  });
  const page = await context.newPage();
  // Surface page errors — a shader/WebGL failure renders as an empty sky
  // and would otherwise pass silently into the goldens.
  page.on('pageerror', (err) => console.error(`[PAGE ERROR] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.error(`[PAGE ${msg.type().toUpperCase()}] ${msg.text()}`);
    }
  });

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
    // freeze=2 pins animTime so shoreline pulse / sun arc / shimmer don't
    // depend on capture-timing jitter (the goldens are SHA-exact).
    const url = `${baseURL}/?renderer=webgl&freeze=2&cam=${encodeURIComponent(cam)}`;
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
    // The imperial welcome salute covers the map for ~4s and a waitFor
    // 'detached' resolves instantly if it hasn't been created yet —
    // remove it outright instead. The loading screen hides when the
    // world is ready; capturing before that compares the splash screen.
    await page
      .locator('#loading-screen')
      .waitFor({ state: 'hidden', timeout: 15_000 })
      .catch(() => {});
    await page.evaluate(() => {
      document.getElementById('imperial-welcome')?.remove();
    });
    // Hide the HUD chrome: resources tick, the Gaceta rotates teasers, and
    // panels reflect live bridge state — none of that is what this gate
    // protects (the WebGL world rendering), and all of it breaks SHA
    // equality between runs.
    await page.addStyleTag({ content: '#hud-overlay { display: none !important; }' });
    // The WebGL canvas lives in #three-container; require it so a silent
    // fallback to the flat renderer fails the gate instead of passing.
    await page.locator('#three-container canvas').waitFor({ state: 'attached', timeout: 15_000 });
    // The terrain atlas loads async and swaps the material when it lands —
    // capturing before that yields the untextured world. Wait for the
    // explicit readiness signal instead of guessing with sleeps.
    await page
      .waitForFunction(() => window.__repocivDebug?.isTerrainAtlasReady?.() === true, null, {
        timeout: 15_000,
      })
      .catch(() => console.error('[AUDIT] terrain atlas never became ready — capturing anyway'));
    // Fixed settle time: a few frames to compile shaders, run the first
    // dirty rebuild with the atlas-backed material, and settle CSS2D labels.
    await page.waitForTimeout(1500);

    const shotPath = join(OUT, `${name}.png`);
    await page.screenshot({ path: shotPath, fullPage: false });
    const hash = sha256(readFileSync(shotPath));
    results.push({ name, shotPath, hash });
    console.log(`[AUDIT] ${name}: ${shotPath} (sha256=${hash.slice(0, 12)}...)`);
  }

  // ── Local view golden (office layout regression net) ─────────────────
  // The local view once went visually empty (desks suppressed) without
  // anything catching it. One deterministic capture of the labhub office:
  // clean mode kills particles/Zzz randomness, freeze pins animations,
  // and DAVI idles at the reception until a mission is dispatched.
  {
    const name = '04-local-office';
    await page.goto(`${baseURL}/?renderer=webgl&freeze=2`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      window.localStorage.setItem('repociv_clean_map', '1');
    });
    await page.goto(`${baseURL}/?renderer=webgl&freeze=2`, { waitUntil: 'networkidle' });
    await page
      .locator('#loading-screen')
      .waitFor({ state: 'hidden', timeout: 15_000 })
      .catch(() => {});
    await page.evaluate(() => document.getElementById('imperial-welcome')?.remove());
    await page.addStyleTag({ content: '#hud-overlay { display: none !important; }' });
    await page
      .waitForFunction(() => typeof window.__repocivDebug?.openLocalView === 'function', null, {
        timeout: 15_000,
      })
      .catch(() => {});
    const opened = await page.evaluate(
      () => window.__repocivDebug?.openLocalView?.('labhub') ?? false,
    );
    if (!opened) {
      console.error('[AUDIT] could not open local view for labhub — golden skipped');
    } else {
      // Local world generation + static layer build + camera settle.
      await page.waitForTimeout(5000);
      // The local renderer reads performance.now() directly for blink/pulse
      // phases (server-rack LEDs, monitors). Freeze the clock NOW — after
      // init, so the world loaded normally — and let a few frames repaint
      // with the pinned phase before hashing.
      await page.evaluate(() => {
        // Pin to a CONSTANT, not the current time — blink phases like
        // sin(now/200) must land identically on every run.
        performance.now = () => 1_000_000;
      });
      await page.waitForTimeout(600);
      const shotPath = join(OUT, `${name}.png`);
      await page.screenshot({ path: shotPath, fullPage: false });
      const hash = sha256(readFileSync(shotPath));
      results.push({ name, shotPath, hash });
      console.log(`[AUDIT] ${name}: ${shotPath} (sha256=${hash.slice(0, 12)}...)`);
    }
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
