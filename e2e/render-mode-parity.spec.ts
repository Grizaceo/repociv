import { expect, test, type Page } from '@playwright/test';

/**
 * Parity test: hex-2D (flat) and WebGL (3D) views both respond to
 * the toggle without errors and the mode persists in localStorage
 * across reloads.
 *
 * What this test verifies:
 *   - Both modes boot without JS errors.
 *   - Hotkey 3 (cycleWorldRenderMode) flips localStorage between
 *     'flat' and 'webgl'. The first flip lazily loads Three.js, so the
 *     assertion polls instead of racing the async toggle with a fixed
 *     sleep.
 *   - An explicit 3D choice is sticky across reloads (plan B5: 3D is
 *     the default view, so honouring the stored preference is the
 *     contract).
 *   - The legacy 'iso25d' value is migrated to 'webgl' on read
 *     (Phase 1's persistence contract). The migration runs during the
 *     async boot, so this also polls.
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
 * Pre-req: a dev server and a bridge on the isolated e2e ports
 * (5373/5374 by default). The Playwright config is responsible for that.
 */

const SEED_REPOS = ['/tmp/repociv-fixtures/repo-alpha', '/tmp/repociv-fixtures/repo-beta'];

async function bootWithMode(page: Page, mode: 'flat' | 'webgl') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.evaluate(
    ([mode, repos]) => {
      window.localStorage.setItem('repociv:renderer', mode);
      // CI has no Hermes harness: the degraded-mode banner is a fixed
      // strip over the top bar that intercepts pointer events (measured in
      // CI run 38674628310). Dismiss it for the session so HUD clicks land.
      sessionStorage.setItem('repociv:hermes-banner-dismissed', '1');
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
  if (
    await page
      .locator('#repo-onboarding')
      .isVisible()
      .catch(() => false)
  ) {
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
    await page.locator('#main-canvas').click();
    await page.keyboard.press('3');
    // Intent is persisted before the lazy Three.js import; still poll in
    // case a slower path writes storage after init.
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('repociv:renderer')), {
        timeout: 30_000,
      })
      .toBe('webgl');
  });

  test('mode persists across reloads', async ({ page }) => {
    await bootWithMode(page, 'webgl');
    // A bare navigation without the ?renderer= param: the persisted
    // explicit 3D choice is sticky (plan B5), so the resolver must
    // land in webgl from storage alone.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('repociv:renderer')))
      .toBe('webgl');
    await expect(page.locator('#main-canvas')).toBeVisible();
  });

  test('legacy iso25d in localStorage is migrated to webgl', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(
      ([repos]) => {
        window.localStorage.setItem('repociv:renderer', 'iso25d');
        // CI has no Hermes harness: the degraded-mode banner is a fixed
        // strip over the top bar that intercepts pointer events (measured in
        // CI run 38674628310). Dismiss it for the session so HUD clicks land.
        sessionStorage.setItem('repociv:hermes-banner-dismissed', '1');
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
    // rewrites the key from 'iso25d' to 'webgl'. It runs inside the
    // async boot, so poll rather than reading before bootstrap
    // reaches the resolver.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('repociv:renderer')), {
        timeout: 20_000,
      })
      .toBe('webgl');
  });
});
