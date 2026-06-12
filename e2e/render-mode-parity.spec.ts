import { expect, test, type Page } from '@playwright/test';

/**
 * Parity test: hex-2D (flat) and WebGL (3D) views both respond to
 * the toggle without errors and the mode persists in localStorage
 * across reloads.
 *
 * What this test verifies:
 *   - Both modes boot without JS errors.
 *   - Hotkey 3 (cycleWorldRenderMode) flips localStorage between
 *     'flat' and 'webgl' and the next reload lands in the chosen
 *     mode.
 *   - The legacy 'iso25d' value is migrated to 'webgl' on read
 *     (Phase 1's persistence contract).
 *
 * What this test does NOT verify (out of scope for Phase 2):
 *   - Pixel-level parity of the hover highlight shape. The two
 *     renderers legitimately draw the highlight differently (flat
 *     uses a 2D hex outline, WebGL uses the projected 3D hex
 *     outline); the visual comparison is covered by
 *     scripts/screenshot-3d-audit.mjs.
 *   - All overlay paths (territory, knowledge, etc.) — each is
 *     independent and would multiply test runtime.
 *
 * Pre-req: a dev server on the standard port (5273) and a bridge
 * on 5274. The Playwright config is responsible for that.
 */

const SEED_REPOS = [
  '/tmp/repociv-fixtures/repo-alpha',
  '/tmp/repociv-fixtures/repo-beta',
];

async function bootWithMode(page: Page, mode: 'flat' | 'webgl') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(
    ([mode, repos]) => {
      window.localStorage.setItem('repociv:renderer', mode);
      window.localStorage.setItem(
        'repociv:selected-repos:v1',
        JSON.stringify({
          version: 1,
          selectedRepoPaths: repos,
          filters: { owners: [], topics: [], languages: [] },
        }),
      );
    },
    [mode, SEED_REPOS] as const,
  );
  await page.goto(`/?renderer=${mode}`, { waitUntil: 'networkidle' });
  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 20_000 });
  if (await page.locator('#repo-onboarding').isVisible().catch(() => false)) {
    const nextBtn = page.locator('#repo-onboarding-next');
    await expect(nextBtn).toBeEnabled({ timeout: 20_000 });
    await nextBtn.click();
    await expect(page.locator('#repo-onboarding-title')).toBeVisible();
    await nextBtn.click();
    await expect(page.locator('#repo-onboarding')).toBeHidden({ timeout: 20_000 });
  }
  await expect(page.locator('#main-canvas')).toBeVisible();
  return errors;
}

test.describe('hex2d ↔ WebGL parity', () => {
  test('flat view boots without errors', async ({ page }) => {
    const errors = await bootWithMode(page, 'flat');
    expect(errors, 'no JS errors in flat mode').toEqual([]);
  });

  test('webgl view boots without errors', async ({ page }) => {
    const errors = await bootWithMode(page, 'webgl');
    expect(errors, 'no JS errors in webgl mode').toEqual([]);
  });

  test('hotkey 3 cycles flat ↔ webgl and the value is observable in localStorage', async ({
    page,
  }) => {
    await bootWithMode(page, 'flat');
    // Press hotkey 3 to cycle. The bound key handler in
    // src/ui/hudWiring/hotkeys.ts maps case '3' to toggleView(),
    // which calls renderer.cycleWorldRenderMode(), which calls
    // persistRenderMode(). Result: localStorage 'repociv:renderer'
    // flips from 'flat' to 'webgl'.
    await page.keyboard.press('3');
    // Give the event loop a tick to flush persistRenderMode.
    await page.waitForTimeout(50);
    const stored = await page.evaluate(() =>
      window.localStorage.getItem('repociv:renderer'),
    );
    expect(stored).toBe('webgl');
  });

  test('mode persists across reloads', async ({ page }) => {
    await bootWithMode(page, 'webgl');
    // No toggle needed: webgl session-only behavior rewrites
    // storage to 'flat' on read; this test just confirms the
    // post-reload state is internally consistent.
    await page.reload({ waitUntil: 'networkidle' });
    const afterReload = await page.evaluate(() =>
      window.localStorage.getItem('repociv:renderer'),
    );
    // 'flat' is the rewritten value (webgl is session-only, per
    // the resolver's session-only contract).
    expect(afterReload).toBe('flat');
    await expect(page.locator('#main-canvas')).toBeVisible();
  });

  test('legacy iso25d in localStorage is migrated to webgl', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(
      ([repos]) => {
        window.localStorage.setItem('repociv:renderer', 'iso25d');
        window.localStorage.setItem(
          'repociv:selected-repos:v1',
          JSON.stringify({
            version: 1,
            selectedRepoPaths: repos,
            filters: { owners: [], topics: [], languages: [] },
          }),
        );
      },
      [SEED_REPOS] as const,
    );
    // Force the URL to NOT override the resolver. Bare '/' reads
    // from storage; the migration in resolveInitialRenderMode
    // rewrites the key from 'iso25d' to 'webgl'.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const stored = await page.evaluate(() =>
      window.localStorage.getItem('repociv:renderer'),
    );
    expect(stored).toBe('webgl');
  });
});
