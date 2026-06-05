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

test.describe('Debug Local View - click tracing', () => {
  test('debug: trace double-click positions and check local view frame', async ({ page }) => {
    await bootRepoCiv(page);
    await page.waitForTimeout(3000);

    // Compute city positions using the same logic as the game
    const positions = await page.evaluate(() => {
      const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
      if (!canvas) return [];

      const HEX_SIZE = 48;
      const SQRT3 = Math.sqrt(3);

      function axialToPixel(a: { q: number; r: number }): { x: number; y: number } {
        const x = HEX_SIZE * ((3 / 2) * a.q);
        const y = HEX_SIZE * ((SQRT3 / 2) * a.q + SQRT3 * a.r);
        return { x, y };
      }

      function spiralCoords(center: { q: number; r: number }, count: number): { q: number; r: number }[] {
        if (count <= 0) return [];
        const results: { q: number; r: number }[] = [];
        let q = center.q;
        let r = center.r;
        results.push({ q, r });

        for (let ring = 1; results.length < count; ring++) {
          q = center.q - ring;
          r = center.r;
          const directions = [
            { q: +1, r: 0 },
            { q: +1, r: -1 },
            { q: 0, r: -1 },
            { q: -1, r: 0 },
            { q: -1, r: +1 },
            { q: 0, r: +1 },
          ];

          for (let side = 0; side < 6 && results.length < count; side++) {
            const steps = ring;
            const dir = directions[side];
            for (let step = 0; step < steps && results.length < count; step++) {
              q += dir.q;
              r += dir.r;
              results.push({ q, r });
            }
          }
        }
        return results.slice(0, count);
      }

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
      const cityCoords = spiralCoords({ q: 0, r: 0 }, maxCities + 1);

      const positions = [];
      for (let i = 1; i < cityCoords.length && i <= maxCities; i++) {
        const coord = cityCoords[i];
        const worldPos = axialToPixel(coord);
        const screenX = (worldPos.x - cam.x) * cam.zoom + cam.cx;
        const screenY = (worldPos.y - cam.y) * cam.zoom + cam.cy;
        positions.push({
          x: screenX,
          y: screenY,
          cityId: `city-${i}`,
          coord: { q: coord.q, r: coord.r },
          ring: Math.max(Math.abs(coord.q), Math.abs(coord.r), Math.abs(-coord.q - coord.r))
        });
      }
      return positions;
    });

    console.log('Computed city positions:', JSON.stringify(positions, null, 2));

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