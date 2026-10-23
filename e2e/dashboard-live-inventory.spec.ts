import { expect, test } from '@playwright/test';

// Explicit local dogfood check; CI need not contain the user's Hermes stores.
// Opt-in against the live stack (the config isolates runs by default):
// REPOCIV_LIVE_INVENTORY=1 PLAYWRIGHT_REUSE_SERVER=1 REPOCIV_PORT=5273 BRIDGE_PORT=5274
test.skip(process.env.REPOCIV_LIVE_INVENTORY !== '1', 'Requires a live local Hermes board');

test('live bridge: canonical Hermes Kanban and complete process snapshot reach the UI', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    localStorage.setItem('repociv:world-render-mode', 'canvas');
  });
  await page.goto('/');
  await expect(page.locator('#agent-attention-strip')).toBeVisible({ timeout: 60_000 });
  const boardResponse = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith('/api/kanban'),
  );
  await page.getByRole('button', { name: 'Kanban de Hermes', exact: true }).click();
  const boardRes = await boardResponse;
  expect(boardRes.status()).toBe(200);
  const board = await boardRes.json();
  expect(board.available).toBe(true);
  const cards = Object.values(board.columns).flat() as { title: string }[];
  await expect(page.locator('#kanban-panel .kb-card')).toHaveCount(cards.length);
  await expect(page.locator('#kanban-panel .kb-board-name')).toContainText(board.name);
  for (const card of cards) {
    await expect(page.locator('#kanban-panel')).toContainText(card.title);
  }
  await page.keyboard.press('Escape');
  const processesResponse = page.waitForResponse((r) => r.url().includes('/api/agent-processes'));
  await page.keyboard.press('F9');
  const res = await processesResponse;
  expect(res.status()).toBe(200);
  const inventory = await res.json();
  expect(inventory.available).toBe(true);
  expect(inventory.processes.length).toBeGreaterThan(0);
  await expect(page.locator('#task-panel [data-process-pid]')).toHaveCount(
    inventory.processes.length,
  );
  const renderedPids = await page
    .locator('#task-panel [data-process-pid]')
    .evaluateAll((rows) =>
      rows.map((row) => Number((row as HTMLElement).dataset.processPid)).sort((a, b) => a - b),
    );
  expect(renderedPids).toEqual(
    inventory.processes.map((p: { pid: number }) => p.pid).sort((a: number, b: number) => a - b),
  );
  for (const p of inventory.processes) {
    expect(p).not.toHaveProperty('argv');
    expect(p).not.toHaveProperty('env');
  }
  console.log(
    `Live UI verified: board=${board.slug}, cards=${cards.length}, processes=${inventory.processes.length}`,
  );
});
