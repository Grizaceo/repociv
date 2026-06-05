import { expect, test, type Page } from '@playwright/test';

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

test.describe('Debug Local View - using game spiralCoords', () => {
  test('debug: trace double-click positions using game spiralCoords', async ({ page }) => {
    await bootRepoCiv(page);
    await page.waitForTimeout(3000);

    // Compute city positions using the GAME'S exact spiralCoords (copied from src/hex.ts)
    const positions = await page.evaluate(() => {
      const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
      if (!canvas) return [];

      const HEX_SIZE = 48;

      // Game's exact AXIAL_DIRECTIONS from src/hex.ts
      const AXIAL_DIRECTIONS = [
        { q: +1, r: 0 },   // E (0)
        { q: +1, r: -1 },  // NE (1)
        { q: 0, r: -1 },   // NW (2)
        { q: -1, r: 0 },   // W (3)
        { q: -1, r: +1 },  // SW (4)
        { q: 0, r: +1 },   // SE (5)
      ];

      function axialAdd(a: { q: number; r: number }, b: { q: number; r: number }): { q: number; r: number } {
        return { q: a.q + b.q, r: a.r + b.r };
      }
      function axialScale(a: { q: number; r: number }, k: number): { q: number; r: number } {
        return { q: a.q * k, r: a.r * k };
      }
      function axialNeighbour(hex: { q: number; r: number }, dir: number): { q: number; r: number } {
        const d = AXIAL_DIRECTIONS[dir];
        return { q: hex.q + d.q, r: hex.r + d.r };
      }

      // Game's exact spiralCoords from src/hex.ts
      function spiralCoords(center: { q: number; r: number }, count: number): { q: number; r: number }[] {
        if (count === 0) return [];
        const results: { q: number; r: number }[] = [center];
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

      function axialToPixel(a: { q: number; r: number }, HEX_SIZE: number): { x: number; y: number } {
        const SQRT3 = Math.sqrt(3);
        const x = HEX_SIZE * ((3 / 2) * a.q);
        const y = HEX_SIZE * ((SQRT3 / 2) * a.q + SQRT3 * a.r);
        return { x, y };
      }

      // Get selected repos count
      let maxCities = 12;
      try {
        const selected = localStorage.getItem('repociv:selected-repos:v1');
        if (selected) {
          const data = JSON.parse(selected);
          const nonCapital = data.selectedRepoPaths.filter((p: string) => !p.toLowerCase().includes('repociv'));
          maxCities = Math.min(nonCapital.length, 12);
        }
      } catch {}

      const cam = { x: 0, y: 0, cx: canvas.width / 2, cy: canvas.height / 2, zoom: 1 };

      // Use the game's spiralCoords: center at (0,0), count = maxCities + 1 (for capital)
      const cityCoords = spiralCoords({ q: 0, r: 0 }, maxCities + 1);

      const positions = [];
      // Skip index 0 (capital at 0,0), start from index 1
      for (let i = 1; i < cityCoords.length && i <= maxCities; i++) {
        const coord = cityCoords[i];
        const worldPos = axialToPixel(coord, HEX_SIZE);
        const screenX = (worldPos.x - cam.x) * cam.zoom + cam.cx;
        const screenY = (worldPos.y - cam.y) * cam.zoom + cam.cy;
        const ring = Math.max(Math.abs(coord.q), Math.abs(coord.r), Math.abs(-coord.q - coord.r));
        positions.push({
          x: screenX,
          y: screenY,
          cityId: `city-${i}`,
          coord: { q: coord.q, r: coord.r },
          ring
        });
      }
      return positions;
    });

    console.log('Computed city positions (game spiralCoords):', JSON.stringify(positions, null, 2));

    // Now try double-clicking each position and check for local view frame
    for (const pos of positions) {
      console.log(`Trying city ${pos.cityId} at (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}) ring ${pos.ring} coord (${pos.coord.q}, ${pos.coord.r})`);

      await page.mouse.dblclick(pos.x, pos.y);
      await page.waitForTimeout(500);

      const localFrame = page.locator('#local-view-frame');
      const isVisible = await localFrame.isVisible().catch(() => false);
      console.log(`  local-view-frame visible: ${isVisible}`);

      if (isVisible) {
        console.log('SUCCESS: Local view frame appeared!');
        return;
      }
    }

    console.log('FAILED: No city click triggered local view');
    // Also try capital (center)
    const canvas = page.locator('#main-canvas');
    const box = await canvas.boundingBox();
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      console.log(`Trying capital at center (${cx}, ${cy})`);
      await page.mouse.dblclick(cx, cy);
      await page.waitForTimeout(500);
      const capitalPanel = page.locator('#capital-panel');
      const capVisible = await capitalPanel.isVisible().catch(() => false);
      console.log(`  capital-panel visible: ${capVisible}`);
    }
  });
});