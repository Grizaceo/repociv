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

test.describe('Debug Local View - access game state directly', () => {
  test('debug: expose game state cities via window for testing', async ({ page }) => {
    await bootRepoCiv(page);
    await page.waitForTimeout(3000);

    // Expose the game state cities by accessing the renderer's state
    // The renderer is created in main.ts and has access to state
    // We can try to access it through the constructionPanel's _rendererRef

    const cities = await page.evaluate(() => {
      const anyWindow = window as any;

      // Try to find the renderer through various paths
      // The renderer is created in main.ts and setRendererRef is called
      // constructionPanel.setRendererRef(renderer) stores it in _rendererRef

      // Check if there's a module we can access
      // In Vite/ES modules, the module namespace isn't on window

      // But we can try to trigger the local view by calling onEnterLocal directly
      // if we can get a reference to the renderer

      // Alternative: dispatch a custom event that the renderer listens to
      // Or try to access the state through the bridge

      // For now, let's just return what we can find
      return {
        windowKeys: Object.keys(anyWindow).filter(k =>
          k.toLowerCase().includes('renderer') ||
          k.toLowerCase().includes('state') ||
          k.toLowerCase().includes('game') ||
          k.toLowerCase().includes('repociv')
        )
      };
    });

    console.log('Window keys:', JSON.stringify(cities, null, 2));

    // Try to access the game state through the bridge
    // The bridge has access to the state
    // But we can't easily call it from the page

    // Let's try a different approach: add a temporary debug endpoint
    // by evaluating code that adds it to the bridge
    // But that's complex

    // Instead, let's use the fact that the renderer's onEnterLocal is set
    // and we can try to call it if we can get the renderer instance

    // The renderer is stored in constructionPanel._rendererRef
    // Let's check if constructionPanel is accessible
    const panelInfo = await page.evaluate(() => {
      // Check if there's a global reference to constructionPanel functions
      const anyWindow = window as any;

      // The functions from ui/constructionPanel.ts are imported in main.ts
      // but not exposed globally

      // However, we can try to trigger the local view by simulating
      // the exact same logic as the double-click handler

      // The double-click handler does:
      // 1. Get tile at coordinate
      // 2. If tile.city and !city.isCapital -> onEnterLocal(city.id, city.id)

      // We can try to find a city by checking the world tiles
      // But we don't have access to the world

      return { message: 'No direct access to game state' };
    });

    console.log('Panel info:', JSON.stringify(panelInfo, null, 2));

    // Since we can't easily access the game state, let's try
    // to use the bridge API to get city info
    // The bridge doesn't have a cities endpoint, but we can check
    // if there's a way to get it

    // Actually, let's try clicking at the exact positions where
    // the game's cities should be based on the selected repos
    // The game places cities in cityCoordLookup order

    // Let me try to replicate the EXACT game algorithm
    // by copying the map.ts city placement logic

    // For now, let's just try clicking at many more positions
    // using the actual game's spiralCoords and distance check

    const testResult = await page.evaluate(() => {
      // Replicate the game's exact city placement algorithm
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

      const MIN_CITY_DISTANCE = 3;
      const center = { q: 0, r: 0 };
      const maxAutoCoords = 200;
      const cityCoords = spiralCoords(center, maxAutoCoords);

      const occupiedCoords = new Set(['0,0', '-1,0', '1,0']); // capital, bibliotheca, labhub
      const cityCoordLookup = new Map();

      // Simulate placing 12 cities (from our selected repos)
      const selectedRepos = 12;
      for (let repoIdx = 0; repoIdx < selectedRepos; repoIdx++) {
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

      return Array.from(cityCoordLookup.entries()).map(([repo, coord]) => ({ repo, q: coord.q, r: coord.r }));
    });

    console.log('Simulated game city positions:', JSON.stringify(testResult, null, 2));

    // Now convert these to screen positions and try clicking
    const canvas = page.locator('#main-canvas');
    const box = await canvas.boundingBox();
    if (!box) return;

    const HEX_SIZE = 48;
    const SQRT3 = Math.sqrt(3);

    function axialToPixel(a: { q: number; r: number }) {
      const x = HEX_SIZE * ((3 / 2) * a.q);
      const y = HEX_SIZE * ((SQRT3 / 2) * a.q + SQRT3 * a.r);
      return { x, y };
    }

    for (const city of testResult) {
      const worldPos = axialToPixel({ q: city.q, r: city.r });
      const cam = { x: 0, y: 0, cx: box.width / 2, cy: box.height / 2, zoom: 1 };
      const screenX = box.x + (worldPos.x - cam.x) * cam.zoom + cam.cx;
      const screenY = box.y + (worldPos.y - cam.y) * cam.zoom + cam.cy;

      console.log(`Trying ${city.repo} at (${city.q}, ${city.r}) -> screen (${screenX.toFixed(1)}, ${screenY.toFixed(1)})`);

      await page.mouse.dblclick(screenX, screenY);
      await page.waitForTimeout(300);

      const localFrame = page.locator('#local-view-frame');
      const isVisible = await localFrame.isVisible().catch(() => false);

      if (isVisible) {
        console.log(`SUCCESS at (${city.q}, ${city.r})!`);
        return;
      }
    }

    console.log('No city found with simulated game algorithm');
  });
});
