import { expect, test, type Page } from '@playwright/test';

const bridgeURL = process.env.VITE_BRIDGE_URL ?? `http://127.0.0.1:${process.env.BRIDGE_PORT ?? 5274}`;
const bridgeToken = process.env.VITE_BRIDGE_TOKEN ?? process.env.REPOCIV_TOKEN ?? '';

function bridgeHeaders(): Record<string, string> {
  return bridgeToken ? { 'X-RepoCiv-Token': bridgeToken } : {};
}

async function seedRepoSelection(page: Page) {
  const response = await page.request.get('/api/repos');
  expect(response.ok(), await response.text()).toBeTruthy();
  const repos = (await response.json()) as Array<{ path?: string }>;
  const selectedRepoPaths = repos
    .map((repo) => repo.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
    .slice(0, 12);
  expect(selectedRepoPaths.length, 'expected /api/repos to return selectable repos').toBeGreaterThan(0);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
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

async function bootRepoCiv(page: Page, options: { seedSelection?: boolean } = {}) {
  const pageErrors: string[] = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  if (options.seedSelection !== false) await seedRepoSelection(page);

  await page.goto('/');
  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 20_000 });
  if (await page.locator('#repo-onboarding').isVisible().catch(() => false)) {
    await expect(page.locator('#repo-onboarding-next')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#repo-onboarding-next').click();
    await expect(page.locator('#repo-onboarding-title')).toContainText(/Revisa tu seleccion/);
    await expect(page.locator('#repo-onboarding-next')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#repo-onboarding-next').click();
    await expect(page.locator('#repo-onboarding')).toBeHidden({ timeout: 20_000 });
  }
  await expect(page.locator('#main-canvas')).toBeVisible();
  expect(pageErrors, 'sin errores JS no capturados durante bootstrap').toEqual([]);
}

async function getActualCityScreenPositions(page: Page): Promise<Array<{ cityId: string; x: number; y: number }>> {
  return await page.evaluate(() => {
    return (
      (
        window as Window & {
          __repocivDebug?: {
            getMacroCityScreenPositions?: () => Array<{ cityId: string; x: number; y: number }>;
          };
        }
      ).__repocivDebug?.getMacroCityScreenPositions?.() ?? []
    );
  });
}

async function waitForCityScreenPositions(
  page: Page,
  timeoutMs = 5000,
): Promise<Array<{ cityId: string; x: number; y: number }>> {
  const deadline = Date.now() + timeoutMs;
  let positions: Array<{ cityId: string; x: number; y: number }> = [];
  while (Date.now() < deadline) {
    positions = await getActualCityScreenPositions(page);
    if (positions.length > 0) return positions;
    await page.waitForTimeout(250);
  }
  return positions;
}

async function getFirstSelectableCityId(page: Page): Promise<string | null> {
  const response = await page.request.get('/api/repos');
  expect(response.ok(), await response.text()).toBeTruthy();
  const repos = (await response.json()) as Array<{ name?: string }>;
  return repos
    .map((repo) => repo.name)
    .find((name): name is string => typeof name === 'string' && name.length > 0 && !/repociv/i.test(name)) ?? null;
}

async function tryEnterLocalView(page: Page): Promise<boolean> {
  const positions = await waitForCityScreenPositions(page);

  if (positions.length > 0) {
    for (const pos of positions) {
      await page.mouse.dblclick(pos.x, pos.y);
      await page.waitForTimeout(300);

      const localFrame = page.locator('#local-view-frame');
      const isVisible = await localFrame.isVisible().catch(() => false);

      if (isVisible) {
        return true;
      }
    }
  }

  const fallbackCityId = positions[0]?.cityId ?? (await getFirstSelectableCityId(page));
  if (!fallbackCityId) return false;

  const openedViaDebug = await page.evaluate((cityId) => {
    return (
      (
        window as Window & {
          __repocivDebug?: { openLocalView?: (id: string) => boolean };
        }
      ).__repocivDebug?.openLocalView?.(cityId) ?? false
    );
  }, fallbackCityId);
  if (!openedViaDebug) return false;

  const localFrame = page.locator('#local-view-frame');
  await expect(localFrame).toBeVisible({ timeout: 5000 });
  await page.locator('#main-canvas').focus();
  return true;
}

async function getJSHeapSize(page: Page): Promise<number> {
  return await page.evaluate(() => {
    // @ts-ignore
    return performance.memory?.usedJSHeapSize ?? 0;
  });
}

test.describe('RepoCiv Local View - Memory Leak Test', () => {
  test.setTimeout(120_000);

  test('heap snapshot: sin memory leaks tras 30s en vista local', async ({ page }) => {
    await bootRepoCiv(page);
    await page.waitForTimeout(3000);

    const entered = await tryEnterLocalView(page);
    expect(entered).toBeTruthy();
    if (!entered) return;

    const localFrame = page.locator('#local-view-frame');
    await expect(localFrame).toBeVisible({ timeout: 5000 });

    // Wait for initial render to settle
    await page.waitForTimeout(2000);

    // Force garbage collection if available (Chrome with --js-flags="--expose-gc")
    await page.evaluate(() => {
      // @ts-ignore
      if (window.gc) window.gc();
    });
    await page.waitForTimeout(500);

    // Initial heap snapshot
    const initialHeap = await getJSHeapSize(page);
    console.log(`Initial JS heap: ${(initialHeap / 1024 / 1024).toFixed(2)} MB`);

    // Run for 30 seconds, measuring heap every 5 seconds
    const heapSamples: number[] = [];
    const startTime = Date.now();

    while (Date.now() - startTime < 30_000) {
      await page.waitForTimeout(5000);

      // Force GC periodically
      await page.evaluate(() => {
        // @ts-ignore
        if (window.gc) window.gc();
      });
      await page.waitForTimeout(200);

      const currentHeap = await getJSHeapSize(page);
      heapSamples.push(currentHeap);
      console.log(`Heap at ${((Date.now() - startTime) / 1000).toFixed(0)}s: ${(currentHeap / 1024 / 1024).toFixed(2)} MB`);
    }

    // Final GC and measurement
    await page.evaluate(() => {
      // @ts-ignore
      if (window.gc) window.gc();
    });
    await page.waitForTimeout(500);
    const finalHeap = await getJSHeapSize(page);
    heapSamples.push(finalHeap);
    console.log(`Final JS heap: ${(finalHeap / 1024 / 1024).toFixed(2)} MB`);

    // Calculate heap growth
    const heapGrowth = finalHeap - initialHeap;
    const heapGrowthMB = heapGrowth / 1024 / 1024;
    console.log(`Heap growth: ${heapGrowthMB.toFixed(2)} MB over 30s`);

    // Allow up to 50 MB growth (generous for 30s with particle systems, animations, etc.)
    // The particle pool is fixed at 64, offscreen canvas is reused, so growth should be minimal
    expect(heapGrowthMB, `Memory leak detected: heap grew ${heapGrowthMB.toFixed(2)} MB`).toBeLessThan(50);

    // Also check that heap doesn't show consistent upward trend
    // (simple linear regression slope should be near zero or negative)
    if (heapSamples.length >= 3) {
      const n = heapSamples.length;
      const xSum = (n * (n - 1)) / 2;
      const ySum = heapSamples.reduce((a, b) => a + b, 0);
      const xySum = heapSamples.reduce((sum, y, i) => sum + i * y, 0);
      const x2Sum = heapSamples.reduce((sum, _, i) => sum + i * i, 0);

      const slope = (n * xySum - xSum * ySum) / (n * x2Sum - xSum * xSum);
      const slopeMBPerSample = slope / 1024 / 1024;
      console.log(`Heap trend slope: ${slopeMBPerSample.toFixed(4)} MB per 5s sample`);

      // Slope should be minimal (less than 1 MB per 5s interval)
      expect(Math.abs(slopeMBPerSample), `Heap trending upward: ${slopeMBPerSample.toFixed(4)} MB/sample`).toBeLessThan(1);
    }
  });

  test('heap snapshot: particles se limpian correctamente al salir', async ({ page }) => {
    await bootRepoCiv(page);
    await page.waitForTimeout(3000);

    const entered = await tryEnterLocalView(page);
    expect(entered).toBeTruthy();
    if (!entered) return;

    const localFrame = page.locator('#local-view-frame');
    await expect(localFrame).toBeVisible({ timeout: 5000 });

    // Wait for particles to spawn
    await page.waitForTimeout(3000);

    // Force GC
    await page.evaluate(() => {
      // @ts-ignore
      if (window.gc) window.gc();
    });
    await page.waitForTimeout(500);

    const heapInLocal = await getJSHeapSize(page);
    console.log(`Heap in local view: ${(heapInLocal / 1024 / 1024).toFixed(2)} MB`);

    // Exit local view
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500); // Wait for fade out + cleanup

    // Force GC after exit
    await page.evaluate(() => {
      // @ts-ignore
      if (window.gc) window.gc();
    });
    await page.waitForTimeout(500);

    const heapAfterExit = await getJSHeapSize(page);
    console.log(`Heap after exit: ${(heapAfterExit / 1024 / 1024).toFixed(2)} MB`);

    // Heap should not be significantly higher after exit
    const diff = heapAfterExit - heapInLocal;
    const diffMB = diff / 1024 / 1024;
    console.log(`Heap diff after exit: ${diffMB.toFixed(2)} MB`);

    // Allow small variance but not significant retention
    expect(Math.abs(diffMB), `Particle cleanup failed: heap diff ${diffMB.toFixed(2)} MB`).toBeLessThan(10);
  });
});
