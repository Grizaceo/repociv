import { expect, test } from '@playwright/test';

test('retired controls stay removed while tasks, Kanban and agent attention remain usable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    // Flat macro renderer (the old 'repociv:world-render-mode' key is dead).
    // This spec is HUD-only; the webgl default would put the CI runner
    // (SwiftShader, 2 workers) under load heavy enough to starve Playwright's
    // in-page queries.
    localStorage.setItem('repociv:renderer', 'flat');
  });
  await page.goto('/');
  await expect(page.locator('#agent-attention-strip')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#btn-layers, #layer-panel')).toHaveCount(0);
  const ribbon = page.locator('#hotkeys-ribbon');
  await expect(ribbon).not.toContainText(/capas|gran libro|quests|laboratorio|gran biblioteca/i);
  await expect(ribbon).toContainText('Kanban');
  await expect(ribbon).toContainText('tareas');
  await page.keyboard.press('h');
  await expect(page.locator('#layer-panel')).toHaveCount(0);
  await page.keyboard.press('?');
  await expect(page.locator('#keyboard-help')).toBeVisible();
  await expect(page.locator('#keyboard-help')).not.toContainText(
    /capas|gran libro|quests|laboratorio|gran biblioteca/i,
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Kanban de Hermes', exact: true }).click();
  await expect(page.locator('#kanban-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('F9');
  await expect(page.locator('#task-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  const palette = page.locator('#command-palette');
  await expect(palette).toBeVisible();
  await expect(palette).not.toContainText(/capas|gran libro|quests|laboratorio|gran biblioteca/i);
});
