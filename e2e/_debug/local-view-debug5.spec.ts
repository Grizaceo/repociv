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

test.describe('Debug Local View - check camera and double-click handler', () => {
  test('debug: check camera position and double-click handler', async ({ page }) => {
    await bootRepoCiv(page);
    await page.waitForTimeout(3000);

    // Check camera state and double-click handler
    const info = await page.evaluate(() => {
      const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
      if (!canvas) return { error: 'no canvas' };

      // Check event listeners on canvas
      const listeners = canvas.cloneNode(true);
      
      // Try to manually trigger the double-click handler logic
      // by simulating what renderer.ts does
      
      // The renderer's camera
      // We can't access it directly, but we can check the game state
      
      // Let's check the world tiles via the bridge API or by accessing the game state
      // The game state is in main.ts: const state = new GameState(world);
      
      // Try to trigger a double-click at canvas center and see what tile it hits
      const rect = canvas.getBoundingClientRect();
      const centerX = rect.left + canvas.width / 2;
      const centerY = rect.top + canvas.height / 2;
      
      // Simulate the renderer's worldToAxial logic
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
      
      // Camera defaults from renderer
      const cam = { x: 0, y: 0, cx: canvas.width / 2, cy: canvas.height / 2, zoom: 1 };
      
      // Test at canvas center
      const wx = centerX;
      const wy = centerY;
      const px = (wx - cam.cx) / cam.zoom + cam.x;
      const py = (wy - cam.cy) / cam.zoom + cam.y;
      const coord = pixelToAxial(px, py, HEX_SIZE, cam);
      
      return {
        canvasCenter: { x: centerX, y: centerY },
        camera: cam,
        worldCoord: coord,
        HEX_SIZE,
      };
    });
    
    console.log('Camera info:', JSON.stringify(info, null, 2));
    
    // Now try double-click at canvas center and check what happens
    const canvas = page.locator('#main-canvas');
    const box = await canvas.boundingBox();
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      
      console.log(`Clicking at canvas center (${cx}, ${cy})`);
      await page.mouse.dblclick(cx, cy);
      await page.waitForTimeout(500);
      
      const capitalPanel = page.locator('#capital-panel');
      const localFrame = page.locator('#local-view-frame');
      
      const capVisible = await capitalPanel.isVisible().catch(() => false);
      const locVisible = await localFrame.isVisible().catch(() => false);
      
      console.log(`  capital-panel: ${capVisible}, local-view-frame: ${locVisible}`);
    }
    
    // Also check if the renderer's double-click handler is attached
    const handlerCheck = await page.evaluate(() => {
      const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
      if (!canvas) return { error: 'no canvas' };
      
      // We can't easily check event listeners, but we can try to trigger
      // a double-click via the canvas dispatchEvent and see if the handler runs
      
      return { 
        canvasExists: true,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      };
    });
    
    console.log('Handler check:', JSON.stringify(handlerCheck, null, 2));
  });
});
