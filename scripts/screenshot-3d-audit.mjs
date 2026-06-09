#!/usr/bin/env node
/**
 * Quick 3D renderer audit screenshots.
 * Run after `npm run dev` is active.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), '.hermes/artifacts/3d-audit');
mkdirSync(OUT, { recursive: true });

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5273';

async function seedRepoSelection(page) {
  const response = await page.request.get(`${baseURL}/api/repos`);
  if (!response.ok()) {
    console.warn('Could not fetch repos, proceeding without seed');
    return;
  }
  const repos = await response.json();
  const selectedRepoPaths = repos
    .map((repo) => repo.path)
    .filter((path) => typeof path === 'string' && path.length > 0)
    .slice(0, 12);
  if (selectedRepoPaths.length === 0) {
    console.warn('No repos found to seed');
    return;
  }
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((paths) => {
    window.localStorage.setItem(
      'repociv:selected-repos:v1',
      JSON.stringify({
        version: 1,
        selectedRepoPaths: paths,
        filters: { owners: [], topics: [], languages: [] },
      }),
    );
  }, selectedRepoPaths);
}

async function bootAndScreenshot() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await seedRepoSelection(page);

  // Open directly in WebGL mode
  await page.goto(`${baseURL}/?renderer=webgl`, { waitUntil: 'networkidle' });

  // Wait for loading screen to disappear
  try {
    await page.locator('#loading-screen').waitFor({ state: 'hidden', timeout: 20_000 });
  } catch {
    console.warn('Loading screen did not hide, continuing anyway');
  }

  // Handle onboarding if present
  const onboarding = page.locator('#repo-onboarding');
  if (await onboarding.isVisible().catch(() => false)) {
    const nextBtn = page.locator('#repo-onboarding-next');
    await nextBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await nextBtn.click();
    await page.locator('#repo-onboarding-title').waitFor({ state: 'visible', timeout: 10_000 });
    await nextBtn.click();
    await onboarding.waitFor({ state: 'hidden', timeout: 20_000 });
  }

  // Ensure canvas is visible
  await page.locator('#main-canvas').waitFor({ state: 'visible', timeout: 10_000 });

  // Let the 3D scene settle
  await page.waitForTimeout(3000);

  // Screenshot 1: General overview
  await page.screenshot({ path: join(OUT, '01-general-overview.png'), fullPage: false });
  console.log(`[AUDIT] Screenshot 1: general overview → ${join(OUT, '01-general-overview.png')}`);

  // Zoom in by scrolling (positive = zoom in)
  const canvas = page.locator('#main-canvas');
  const box = await canvas.boundingBox();
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Zoom in 5 times
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -300, { position: { x: cx, y: cy } });
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(1000);

    // Screenshot 2: Zoomed in
    await page.screenshot({ path: join(OUT, '02-zoomed-mid.png'), fullPage: false });
    console.log(`[AUDIT] Screenshot 2: zoomed mid → ${join(OUT, '02-zoomed-mid.png')}`);

    // Zoom in more
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -300, { position: { x: cx, y: cy } });
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(OUT, '03-zoomed-close.png'), fullPage: false });
    console.log(`[AUDIT] Screenshot 3: zoomed close → ${join(OUT, '03-zoomed-close.png')}`);
  }

  await browser.close();
  console.log('[AUDIT] Screenshots complete');
}

bootAndScreenshot().catch((err) => {
  console.error('[AUDIT] Failed:', err);
  process.exit(1);
});
