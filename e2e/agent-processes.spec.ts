import { expect, test } from '@playwright/test';

test('tasks include every agent process, even with an empty orchestrator', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    localStorage.setItem('repociv:world-render-mode', 'canvas');
  });
  const processes = Array.from({ length: 80 }, (_, i) => ({
    pid: 900000 + i,
    ppid: i ? 900000 : 1,
    rootPid: 900000,
    family: 'Hermes',
    name: i ? '<img src=x onerror=alert(1)>' : 'hermes',
    state: 'S',
    role: i ? 'descendant' : 'agent',
  }));
  let offline = false;
  await page.route('**/api/agent-processes', (route) =>
    route.fulfill({
      status: offline ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify({ available: true, scope: 'local-uid', unreadable: 0, processes }),
    }),
  );
  await page.route('**/bridge/tasks', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  await page.goto('/');
  await expect(page.locator('#agent-attention-strip')).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('F9');
  const panel = page.locator('#task-panel');
  await expect(panel.locator('[data-process-pid]')).toHaveCount(80);
  await expect(panel).toContainText('Sin tareas registradas en el orquestador');
  await expect(panel.locator('img')).toHaveCount(0);
  await expect(panel.locator('[data-process-pid="900079"]')).toContainText(
    'Descendiente de 900000',
  );
  offline = true;
  await expect(panel).toContainText('HTTP 503', { timeout: 10_000 });
  await expect(panel.locator('[data-process-pid]')).toHaveCount(80);
});
