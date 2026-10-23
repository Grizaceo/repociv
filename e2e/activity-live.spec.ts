import { expect, test } from '@playwright/test';

// Read-only dogfood: no synthetic data or user state writes.
// Opt-in against the live stack (the config isolates runs by default):
// REPOCIV_LIVE_INVENTORY=1 PLAYWRIGHT_REUSE_SERVER=1 REPOCIV_PORT=5273 BRIDGE_PORT=5274
test.skip(process.env.REPOCIV_LIVE_INVENTORY !== '1', 'Opt-in local dashboard verification');
test('live activity: exact inventory, selection and safe chronicle navigation', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    localStorage.setItem('repociv:world-render-mode', 'canvas');
  });
  await page.goto('/');
  await expect(page.locator('#agent-attention-strip')).toBeVisible({ timeout: 60_000 });
  const response = page.waitForResponse((r) => r.url().includes('/api/agent-processes'));
  await page.keyboard.press('F9');
  const res = await response;
  expect(res.status()).toBe(200);
  const inventory = await res.json();
  expect(inventory.available).toBe(true);
  const task = page.locator('#task-panel');
  await expect(task.locator('[data-process-pid]')).toHaveCount(inventory.processes.length);
  const pids = await task
    .locator('[data-process-pid]')
    .evaluateAll((rows) =>
      rows.map((row) => Number((row as HTMLElement).dataset.processPid)).sort((a, b) => a - b),
    );
  expect(pids).toEqual(
    inventory.processes.map((p: { pid: number }) => p.pid).sort((a: number, b: number) => a - b),
  );
  const first = task.locator('.activity-card-heading button[data-activity]').first();
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  const selected = await task.locator('.activity-context').textContent();
  await task.getByRole('button', { name: 'Crónica de la selección' }).focus();
  await page.keyboard.press('Enter');
  const log = page.locator('#log-panel');
  await expect(task).toBeHidden();
  await expect(log).toBeVisible();
  await expect(log.locator('.activity-context')).toContainText(selected!);
  await log.getByRole('button', { name: 'Todas las ejecuciones', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(log.locator('tbody tr').first()).toBeVisible();
  const renderedEvents = await log.locator('tbody button[data-activity]').count();
  const legacy = await log.getByText(/Bridge anterior: ventana/).count();
  console.log(
    `Live dashboard: ${pids.length} PIDs matched; ${renderedEvents} rendered event links; legacyBridge=${legacy > 0}`,
  );
  await page.screenshot({ path: testInfo.outputPath('activity-live.png') });
});
