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

async function getActualCityScreenPositions(page: Page): Promise<Array<{ x: number; y: number; coord: { q: number; r: number } }>> {
  return await page.evaluate(() => {
    const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
    if (!canvas) return [];

    const HEX_SIZE = 48;
    const SQRT3 = Math.sqrt(3);

    // Helper functions (must be inside evaluate for browser context)
    const AXIAL_DIRECTIONS = [
      { q: +1, r: 0 },   // E (0)
      { q: +1, r: -1 },  // NE (1)
      { q: 0, r: -1 },   // NW (2)
      { q: -1, r: 0 },   // W (3)
      { q: -1, r: +1 },  // SW (4)
      { q: 0, r: +1 },   // SE (5)
    ];

    function axialAdd(a: any, b: any) { return { q: a.q + b.q, r: a.r + b.r }; }
    function axialScale(a: any, k: number) { return { q: a.q * k, r: a.r * k }; }
    function axialNeighbour(hex: any, dir: number) {
      const d = AXIAL_DIRECTIONS[dir];
      return { q: hex.q + d.q, r: hex.r + d.r };
    }
    function axialDistance(a: any, b: any) {
      const dq = a.q - b.q;
      const dr = a.r - b.r;
      const ds = (-a.q - a.r) - (-b.q - b.r);
      return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
    }

    function spiralCoords(center: any, count: number) {
      if (count === 0) return [];
      const results: any[] = [center];
      for (let k = 1; results.length < count; k++) {
        let hex = axialAdd(center, axialScale(AXIAL_DIRECTIONS[4], k));
        for (let i = 0; i < 6 && results.length < count; i++) {
          for (let j = 0; j < k && results.length < count; j++) {
            results.push(hex);
            hex = axialNeighbour(hex, i);
          }
        }
      }
      return results;
    }

    function axialToPixel(a: any) {
      const x = HEX_SIZE * ((3 / 2) * a.q);
      const y = HEX_SIZE * ((SQRT3 / 2) * a.q + SQRT3 * a.r);
      return { x, y };
    }

    const MIN_CITY_DISTANCE = 3;
    const center = { q: 0, r: 0 };
    const maxAutoCoords = 200;
    const cityCoords = spiralCoords(center, maxAutoCoords);

    const occupiedCoords = new Set(['0,0', '-1,0', '1,0']);
    const cityCoordLookup = new Map<string, { q: number; r: number }>();

    let maxCities = 12;
    try {
      const selected = localStorage.getItem('repociv:selected-repos:v1');
      if (selected) {
        const data = JSON.parse(selected);
        const nonCapital = data.selectedRepoPaths.filter((p: string) => !p.toLowerCase().includes('repociv'));
        maxCities = Math.min(nonCapital.length, 12);
      }
    } catch {}

    for (let repoIdx = 0; repoIdx < maxCities; repoIdx++) {
      let placed = false;
      for (let cursor = 0; cursor < cityCoords.length && !placed; cursor++) {
        const coord = cityCoords[cursor];
        const key = `${coord.q},${coord.r}`;
        if (occupiedCoords.has(key)) continue;

        let tooClose = false;
        for (const assignedCoord of cityCoordLookup.values()) {
          if (axialDistance(coord, assignedCoord) < MIN_CITY_DISTANCE) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;

        occupiedCoords.add(key);
        cityCoordLookup.set(`repo-${repoIdx}`, coord);
        placed = true;
      }
    }

    const cam = { x: 0, y: 0, cx: canvas.width / 2, cy: canvas.height / 2, zoom: 1 };

    const positions: Array<{ x: number; y: number; coord: { q: number; r: number } }> = [];
    for (const [repo, coord] of cityCoordLookup.entries()) {
      const worldPos = axialToPixel(coord);
      const screenX = (worldPos.x - cam.x) * cam.zoom + cam.cx;
      const screenY = (worldPos.y - cam.y) * cam.zoom + cam.cy;
      positions.push({ x: screenX, y: screenY, coord: { q: coord.q, r: coord.r } });
    }
    return positions;
  });
}

async function tryEnterLocalView(page: Page): Promise<boolean> {
  const positions = await getActualCityScreenPositions(page);

  if (positions.length === 0) return false;

  for (const pos of positions) {
    await page.mouse.dblclick(pos.x, pos.y);
    await page.waitForTimeout(300);

    const localFrame = page.locator('#local-view-frame');
    const isVisible = await localFrame.isVisible().catch(() => false);

    if (isVisible) {
      return true;
    }
  }

  return false;
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