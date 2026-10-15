import { expect, test } from '@playwright/test';

test('tasks include every agent process, even with an empty orchestrator', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    // Flat macro renderer (the old 'repociv:world-render-mode' key is dead).
    // This spec is panel-only; the webgl default would put the CI runner
    // (SwiftShader, 2 workers) under load heavy enough to starve Playwright's
    // in-page queries.
    localStorage.setItem('repociv:renderer', 'flat');
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
  // Evidence-gated presentation (2c8507e): without processIdentity the parent
  // chain cannot be validated, so the row shows its direct PPID and the
  // explicit "no identity" note instead of inferring "Descendiente de N" from
  // rootPid. The validated-descendant case lives in activity-correlation.spec.
  const descendant = panel.locator('[data-process-pid="900079"]');
  await expect(descendant).toContainText('PID 900079 ← PPID 900000');
  await expect(descendant).toContainText('Estado SO: S');
  await expect(descendant).toContainText('Identidad de proceso no disponible');
  await expect(panel).toContainText('Familia detectada: Hermes');
  offline = true;
  // The process inventory reports unavailability without the HTTP status code
  // (that detail only renders for pending-work failures) and keeps the rows
  // from the last successful sample.
  await expect(panel).toContainText('Inventario no disponible', { timeout: 10_000 });
  await expect(panel.locator('[data-process-pid]')).toHaveCount(80);
});
