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

test.describe('Debug Local View - with seed', () => {
  test('debug: check game state cities after bootRepoCiv', async ({ page }) => {
    await bootRepoCiv(page);
    await page.waitForTimeout(3000);

    // Check localStorage
    const localStorageInfo = await page.evaluate(() => {
      const selected = localStorage.getItem('repociv:selected-repos:v1');
      let selectedPaths: string[] = [];
      if (selected) {
        try {
          const data = JSON.parse(selected);
          selectedPaths = data.selectedRepoPaths || [];
        } catch {}
      }
      return {
        selectedReposCount: selectedPaths.length,
        selectedRepos: selectedPaths,
        canvasWidth: (document.getElementById('main-canvas') as HTMLCanvasElement)?.width || 0,
        canvasHeight: (document.getElementById('main-canvas') as HTMLCanvasElement)?.height || 0,
      };
    });
    console.log('After bootRepoCiv:', JSON.stringify(localStorageInfo, null, 2));

    // Check game state for cities
    const gameState = await page.evaluate(() => {
      // Try to access the game state from the renderer
      // The renderer is created in main.ts
      const anyWindow = window as any;
      // Check if there's a way to access the state
      return { globalKeys: Object.keys(anyWindow) };
    });
    console.log('Global keys:', gameState);

    // Try to get cities by accessing the game state through the renderer
    // The renderer is not globally exposed, but we can try to trigger a render
    // and check if cities exist
  });

  test('debug: try to access game state cities via page.evaluate', async ({ page }) => {
    await bootRepoCiv(page);
    await page.waitForTimeout(3000);

    // The game state is created in main.ts bootstrap() as:
    // const state = new GameState(world);
    // state.start();
    // const renderer = new Renderer(canvas, state);
    // renderer.onEnterLocal = (repoId, _rootPath) => { ... }
    
    // We can't directly access state, but we can check what's rendered on canvas
    // by looking at the world tiles through the bridge API
    const response = await page.request.get('/api/repos');
    if (response.ok()) {
      const repos = await response.json();
      console.log(`Total repos from API: ${repos.length}`);
    }

    // Try to find cities by checking if the renderer has a reference
    // The renderer is stored in constructionPanel.ts as _rendererRef
    // But that's not globally accessible

    // Alternative: check the canvas content by reading pixels
    const canvasInfo = await page.evaluate(() => {
      const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
      if (!canvas) return { error: 'no canvas' };
      const ctx = canvas.getContext('2d');
      if (!ctx) return { error: 'no context' };
      
      // Check a few pixels to see if there's content
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const pixel = ctx.getImageData(centerX, centerY, 1, 1).data;
      
      // Check corners too
      const tl = ctx.getImageData(10, 10, 1, 1).data;
      const tr = ctx.getImageData(canvas.width - 10, 10, 1, 1).data;
      const bl = ctx.getImageData(10, canvas.height - 10, 1, 1).data;
      const br = ctx.getImageData(canvas.width - 10, canvas.height - 10, 1, 1).data;

      return {
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        centerPixel: Array.from(pixel),
        topLeft: Array.from(tl),
        topRight: Array.from(tr),
        bottomLeft: Array.from(bl),
        bottomRight: Array.from(br),
      };
    });
    console.log('Canvas pixel info:', JSON.stringify(canvasInfo, null, 2));
  });
});
