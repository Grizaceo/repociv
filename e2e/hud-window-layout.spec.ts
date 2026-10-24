import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Real document, CSS and window manager; no game loop, agent launches or bridge writes.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(
    '</body>',
    `<script type="module">
    import '/src/styles/index.css';
    import { initHudWindows } from '/src/ui/hudWindow.ts';
    document.getElementById('loading-screen')?.remove();
    window.stopHudWindows = initHudWindows();
    window.hudReady = true;
  </script></body>`,
  );

async function mount(page: Page, width = 1600, height = 1000) {
  await page.setViewportSize({ width, height });
  await page.route('**/__hud-layout-test', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto('/__hud-layout-test');
  await page.waitForFunction(() => (window as unknown as { hudReady: boolean }).hudReady);
  // Starting-style transitions should not affect geometry assertions.
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
}

async function openUnit(page: Page) {
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser URL
    const { showUnitPanel } = await import('/src/ui/panel.ts');
    showUnitPanel({
      id: 'layout-unit',
      type: 'worker',
      name: 'Layout Unit',
      color: '#ffd700',
      state: 'idle',
      movesLeft: 4,
      maxMoves: 4,
    });
  });
  await expect(page.locator('#unit-panel')).toHaveClass(/hud-window--placed/);
}

async function rect(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function expectSeparated(page: Page, a: string, b: string) {
  await expect
    .poll(async () => {
      const x = await rect(page, a);
      const y = await rect(page, b);
      return (
        x.x + x.width <= y.x ||
        y.x + y.width <= x.x ||
        x.y + x.height <= y.y ||
        y.y + y.height <= x.y
      );
    })
    .toBe(true);
}

async function addPanel(page: Page, id: string, left: number, top: number) {
  await page.evaluate(
    ({ id, left, top }) => {
      const panel = document.createElement('aside');
      panel.id = id;
      // Static test markup only; no external or user-controlled HTML.
      panel.innerHTML = '<header class="agents-header">Layout panel</header><p>Panel content</p>';
      panel.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:300px;height:300px;display:block;transform:none`;
      document.body.append(panel);
    },
    { id, left, top },
  );
  await expect(page.locator(`#${id}`)).toHaveClass(/hud-window--placed/);
  await expect(page.locator(`#${id} .hud-window-reset`)).toBeAttached();
}

test('unit opens beside Gaceta; new panels, reopening and expanded Gaceta avoid collisions', async ({
  page,
}) => {
  await mount(page);
  await openUnit(page);
  const gaceta = await rect(page, '#gaceta-widget');
  const unit = await rect(page, '#unit-panel');
  expect(unit.x).toBeCloseTo(gaceta.x + gaceta.width + 8, 0);
  expect(unit.y).toBeCloseTo(gaceta.y, 0);
  await addPanel(page, 'agents-panel', unit.x, unit.y);
  await expectSeparated(page, '#unit-panel', '#agents-panel');
  await expectSeparated(page, '#gaceta-widget', '#agents-panel');
  await page.evaluate(() => {
    document.getElementById('unit-panel')!.classList.add('hidden');
  });
  await expect(page.locator('#unit-panel')).toBeHidden();
  await page.evaluate(() => {
    const panel = document.getElementById('agents-panel')!;
    panel.style.left = '340px';
    panel.style.top = '50px';
  });
  await openUnit(page);
  await expectSeparated(page, '#unit-panel', '#agents-panel');
  await page.evaluate(() => {
    const gaceta = document.getElementById('gaceta-widget')!;
    gaceta.className = 'gaceta-expanded';
    gaceta.style.width = '600px';
    gaceta.querySelector<HTMLElement>('.gaceta-body')!.hidden = false;
  });
  await expectSeparated(page, '#unit-panel', '#gaceta-widget');
  await expectSeparated(page, '#agents-panel', '#gaceta-widget');
});

test('saved layouts are collision-checked on open; content updates do not restore stale positions', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() =>
    localStorage.setItem(
      'repociv:hud-window:v1:agents-panel',
      JSON.stringify({ left: 340, top: 50, width: 300, height: 300 }),
    ),
  );
  await openUnit(page);
  await addPanel(page, 'agents-panel', 340, 50);
  await expectSeparated(page, '#unit-panel', '#agents-panel');
  const before = await rect(page, '#agents-panel');
  await page.locator('#agents-panel p').evaluate((el) => {
    el.textContent = 'Updated content';
  });
  await expect.poll(async () => (await rect(page, '#agents-panel')).x).toBe(before.x);
  await page.locator('#agents-panel .hud-window-reset').click({ force: true });
  await expectSeparated(page, '#unit-panel', '#agents-panel');
});

test('unit can be dragged and resized; narrow screens retain reachable content', async ({
  page,
}) => {
  await mount(page);
  await openUnit(page);
  const header = await rect(page, '#unit-panel .hero-card-main');
  await page.mouse.move(header.x + 10, header.y + 10);
  await page.mouse.down();
  await page.mouse.move(header.x + 150, header.y + 100, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#unit-panel')).toHaveClass(/hud-window--customized/);
  const before = await rect(page, '#unit-panel');
  await page.locator('#unit-panel .hud-window-resize').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await rect(page, '#unit-panel')).width).toBe(before.width + 8);
  await page.setViewportSize({ width: 390, height: 500 });
  await expect
    .poll(async () => {
      const r = await rect(page, '#unit-panel');
      return r.x >= 8 && r.y >= 8 && r.x + r.width <= 382 && r.y + r.height <= 492;
    })
    .toBe(true);
  await page.locator('#unit-panel .hud-window-reset').click();
  const resize = await rect(page, '#unit-panel .hud-window-resize');
  expect(resize.x + resize.width).toBeLessThanOrEqual(390);
});

test('small screen with no free slot keeps the unit in bounds and scrollable', async ({ page }) => {
  await mount(page, 390, 500);
  await openUnit(page);
  await page.locator('#unit-mission').evaluate((el) => {
    el.textContent = 'Long mission '.repeat(400);
  });
  await expect
    .poll(async () => {
      const r = await rect(page, '#unit-panel');
      return r.x >= 8 && r.y >= 8 && r.x + r.width <= 382 && r.y + r.height <= 492;
    })
    .toBe(true);
  await expect(page.locator('#unit-panel')).toHaveCSS('overflow-y', 'auto');
});
