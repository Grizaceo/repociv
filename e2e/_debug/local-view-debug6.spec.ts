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

test.describe('Debug Local View - get actual city positions from game state', () => {
  test('debug: try to access game state cities', async ({ page }) => {
    await bootRepoCiv(page);
    await page.waitForTimeout(3000);

    // The game state is created in main.ts bootstrap() as:
    // const state = new GameState(world);
    // The world has cities array with their coordinates

    // We can't directly access state, but we can try to get city info
    // from the bridge API or by checking what's rendered

    // Let's check the construction panel's city list which reads from state
    const constructionInfo = await page.evaluate(() => {
      // Try to open construction panel to see city list
      // The construction panel uses refreshCityList() which reads from manualLayout
      // But the actual cities in the world are in state.world.cities

      // Check localStorage for manual layout
      try {
        const manual = localStorage.getItem('repociv:manual-layout:v1');
        if (manual) {
          const data = JSON.parse(manual);
          return { manualLayout: data };
        }
      } catch {}

      return { manualLayout: null };
    });
    console.log('Construction info:', JSON.stringify(constructionInfo, null, 2));

    // Try to access the game state by checking if there's a way to expose it
    // The renderer is stored in constructionPanel._rendererRef
    // And the renderer has access to state.world.cities

    // Let's try a different approach: use the bridge API to get city info
    // The bridge has /api/repos but not /api/cities

    // Alternative: click around and use the renderer's hit-testing
    // The renderer has worldToAxial and can tell us what tile was clicked

    // Actually, let me try to trigger the local view programmatically
    // by calling the onEnterLocal callback if we can find it

    // The renderer is created in main.ts and onEnterLocal is set
    // We can try to access it through the module system

    // For now, let's try clicking at various positions and check
    // what the renderer thinks we clicked using its own logic

    // We can simulate the renderer's hit testing by evaluating in page context
    const hitTest = await page.evaluate(() => {
      const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
      if (!canvas) return { error: 'no canvas' };

      const HEX_SIZE = 48;
      const SQRT3 = Math.sqrt(3);

      function pixelToAxial(px: number, py: number, size: number, cam: any): { q: number; r: number } {
        if (size <= 0) return { q: 0, r: 0 };
        const q = ((2 / 3) * px) / size;
        const r = ((-1 / 3) * px + (SQRT3 / 3) * py) / size;
        return axialRound({ q, r });
      }

      function axialRound(a: { q: number; r: number }): { q: number; r: number } {
        const x = a.q;
        const z = a.r;
        const y = -x - z;
        let rx = Math.round(x);
        let ry = Math.round(y);
        let rz = Math.round(z);
        const xDiff = Math.abs(rx - x);
        const yDiff = Math.abs(ry - y);
        const zDiff = Math.abs(rz - z);
        if (xDiff > yDiff && xDiff > zDiff) rx = -ry - rz;
        else if (yDiff > zDiff) ry = -rx - rz;
        else rz = -rx - ry;
        return { q: rx, r: rz };
      }

      const cam = { x: 0, y: 0, cx: canvas.width / 2, cy: canvas.height / 2, zoom: 1 };

      // Test a grid of positions around center
      const results = [];
      for (let dx = -200; dx <= 200; dx += 100) {
        for (let dy = -200; dy <= 200; dy += 100) {
          const wx = canvas.width / 2 + dx;
          const wy = canvas.height / 2 + dy;
          const px = (wx - cam.cx) / cam.zoom + cam.x;
          const py = (wy - cam.cy) / cam.zoom + cam.y;
          const coord = pixelToAxial(px, py, HEX_SIZE, cam);
          results.push({ screenX: wx, screenY: wy, coord });
        }
      }

      return { cam, results };
    });

    console.log('Hit test grid:', JSON.stringify(hitTest, null, 2));

    // Now try clicking at positions that should hit cities
    // We know from the game's city placement that cities are at specific coords
    // Let's try the actual game algorithm: spiralCoords with distance check

    // For now, let's just try a broader set of positions
    const canvas = page.locator('#main-canvas');
    const box = await canvas.boundingBox();
    if (!box) return;

    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Try a wider grid
    const testPoints = [
      { x: cx - 200, y: cy - 150 },
      { x: cx - 100, y: cy - 200 },
      { x: cx, y: cy - 250 },
      { x: cx + 100, y: cy - 200 },
      { x: cx + 200, y: cy - 150 },
      { x: cx + 250, y: cy },
      { x: cx + 200, y: cy + 150 },
      { x: cx + 100, y: cy + 200 },
      { x: cx, y: cy + 250 },
      { x: cx - 100, y: cy + 200 },
      { x: cx - 200, y: cy + 150 },
      { x: cx - 250, y: cy },
    ];

    for (const pos of testPoints) {
      if (pos.x < box.x || pos.x > box.x + box.width || pos.y < box.y || pos.y > box.y + box.height) continue;

      await page.mouse.dblclick(pos.x, pos.y);
      await page.waitForTimeout(300);

      const localFrame = page.locator('#local-view-frame');
      const isVisible = await localFrame.isVisible().catch(() => false);

      if (isVisible) {
        console.log(`SUCCESS at (${pos.x}, ${pos.y})`);
        return;
      }
    }

    console.log('No city found with wider grid');
  });
});
