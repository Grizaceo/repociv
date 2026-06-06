import { expect, test, type Page } from '@playwright/test';

test.describe('Debug Local View', () => {
  test('debug: check game state and cities', async ({ page }) => {
    // Navigate directly
    await page.goto('/');
    await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(3000);

    // Check if there are cities in the game state by evaluating
    const stateInfo = await page.evaluate(() => {
      const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
      if (!canvas) return { error: 'no canvas' };

      // Try to access the game state
      // The state is created in main.ts as `const state = new GameState(world);`
      // It's not globally exposed, but let's check what's available

      // Check localStorage for selected repos
      const selected = localStorage.getItem('repociv:selected-repos:v1');
      let selectedPaths: string[] = [];
      if (selected) {
        try {
          const data = JSON.parse(selected);
          selectedPaths = data.selectedRepoPaths || [];
        } catch {}
      }

      return {
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        selectedReposCount: selectedPaths.length,
        selectedRepos: selectedPaths,
      };
    });

    console.log('State info:', JSON.stringify(stateInfo, null, 2));

    // Also check the bridge API for cities
    const response = await page.request.get('/api/repos');
    if (response.ok()) {
      const repos = await response.json();
      console.log('Repos from API:', repos.length);
      repos.slice(0, 5).forEach((r: any) => console.log(`  - ${r.name} (${r.path}): pop=${r.population}`));
    }

    // Try to access the game state via the renderer
    const rendererInfo = await page.evaluate(() => {
      // Check if there's any global reference to the renderer or state
      const anyWindow = window as any;
      const keys = Object.keys(anyWindow).filter(k => k.toLowerCase().includes('repociv') || k.toLowerCase().includes('renderer') || k.toLowerCase().includes('state') || k.toLowerCase().includes('game'));
      return { globalKeys: keys };
    });

    console.log('Renderer/state globals:', JSON.stringify(rendererInfo, null, 2));
  });

  test('debug: try triggering local view via onEnterLocal callback', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(3000);

    // Try to call the onEnterLocal callback directly by accessing the renderer
    const result = await page.evaluate(async () => {
      const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
      if (!canvas) return { error: 'no canvas' };

      // The renderer is created in main.ts and has onEnterLocal callback
      // We can try to find it by checking event listeners or module exports

      // Actually, let's try to trigger a double-click at a specific position
      // and see if the local view frame appears
      const rect = canvas.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Try double-click at center (capital) - should open capital panel
      const dblClickEvent = new MouseEvent('dblclick', {
        clientX: centerX,
        clientY: centerY,
        bubbles: true,
        cancelable: true,
      });
      canvas.dispatchEvent(dblClickEvent);

      // Wait a bit
      await new Promise(r => setTimeout(r, 500));

      // Check if local view frame appeared
      const localFrame = document.getElementById('local-view-frame');
      const capitalPanel = document.getElementById('capital-panel');

      return {
        localFrameVisible: localFrame ? !localFrame.classList.contains('hidden') : false,
        capitalPanelVisible: capitalPanel ? !capitalPanel.classList.contains('hidden') : false,
      };
    });

    console.log('After center dblclick:', JSON.stringify(result, null, 2));

    // Now try offset from center
    const result2 = await page.evaluate(async () => {
      const canvas = document.getElementById('main-canvas') as HTMLCanvasElement;
      if (!canvas) return { error: 'no canvas' };

      const rect = canvas.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Try at offset (150, -100) - should be a city at ring 1
      const testX = centerX + 150;
      const testY = centerY - 100;

      const dblClickEvent = new MouseEvent('dblclick', {
        clientX: testX,
        clientY: testY,
        bubbles: true,
        cancelable: true,
      });
      canvas.dispatchEvent(dblClickEvent);

      await new Promise(r => setTimeout(r, 500));

      const localFrame = document.getElementById('local-view-frame');
      return {
        localFrameVisible: localFrame ? !localFrame.classList.contains('hidden') : false,
      };
    });

    console.log('After offset dblclick:', JSON.stringify(result2, null, 2));
  });
});
