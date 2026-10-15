import { expect, test } from '@playwright/test';
for (const width of [1280, 390]) {
  test(`human identity and refresh retention at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('repociv:tour-seen:v1', '1');
      // CI has no Hermes harness: the degraded-mode banner is a fixed
      // strip over the top bar that intercepts pointer events (measured in
      // CI run 38674628310). Dismiss it for the session so HUD clicks land.
      sessionStorage.setItem('repociv:hermes-banner-dismissed', '1');
      // Flat macro renderer (the old 'repociv:world-render-mode' key is dead).
      // These cards are panel-only; the webgl default would put the CI runner
      // (SwiftShader, 2 workers) under load heavy enough to starve Playwright's
      // in-page queries and detach cards mid-click.
      localStorage.setItem('repociv:renderer', 'flat');
    });
    let stage: string = 'initial';
    const identity = (commandId: string, data: Record<string, unknown>) => ({
      id: `identity-${commandId}-${JSON.stringify(data)}`,
      type: 'ExecutionIdentityRecorded',
      commandId,
      timestamp: 1,
      data: { commandId, commandType: 'execute_agent', ...data },
    });
    const history = [
      identity('unit-run', {
        harness: 'hermes',
        unitId: 'WORKER-2',
        profileName: 'worker',
        agentName: 'Worker',
      }),
      {
        id: 'bound',
        type: 'ProcessBound',
        commandId: 'unit-run',
        timestamp: 2,
        data: { processIdentity: 'boot:10:100' },
      },
      identity('harness-run', { harness: 'codex' }),
      identity('profile-run', {
        harness: 'hermes',
        profileName: 'researcher',
        agentName: 'Researcher',
      }),
      identity('ambiguous', { harness: 'hermes', unitId: 'A' }),
      identity('ambiguous', { harness: 'hermes', unitId: 'B' }),
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `end-${i}`,
        type: 'CommandCompleted',
        commandId: `ended-${i}`,
        timestamp: i + 10,
        data: {},
      })),
    ];
    await page.route('**/log?*', (route) =>
      route.fulfill({
        json: { ok: true, paged: true, more: false, before: 0, cursor: 100, events: history },
      }),
    );
    await page.route('**/tasks', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/agent-processes', (route) => {
      const base = { rootPid: 10, name: 'hermes', family: 'Hermes', role: 'agent', state: 'S' };
      const processes = [
        { ...base, pid: 10, ppid: 1, processIdentity: 'boot:10:100' },
        { ...base, pid: 11, ppid: 10, processIdentity: 'boot:11:110' },
        ...(stage !== 'initial'
          ? [{ ...base, pid: 12, ppid: 11, processIdentity: 'boot:12:120' }]
          : []),
      ];
      return route.fulfill({
        json: {
          available: stage !== 'unavailable',
          processes: stage !== 'unavailable' ? processes : [],
          unreadable: 0,
        },
      });
    });
    await page.goto('/');
    await expect(page.locator('#agent-attention-strip')).toBeVisible({ timeout: 60_000 });
    await page.evaluate(async () => {
      const { openLogPanel } = await import('/src/ui/logPanel.ts');
      openLogPanel();
    });
    await expect(page.locator('#log-panel')).toContainText('WORKER-2');
    await page.evaluate(async () => {
      const { openTaskPanel } = await import('/src/ui/taskPanel.ts');
      openTaskPanel();
    });
    const panel = page.locator('#task-panel');
    const card = panel.locator('[data-run="run:unit-run"]');
    await expect(card).toContainText('Harness: Hermes');
    await expect(card).toContainText('Profile: worker');
    await expect(card).toContainText('2 procesos');
    await expect(panel.locator('[data-run="run:harness-run"]')).toContainText(
      'Profile: desconocido',
    );
    await expect(panel.locator('[data-run="run:profile-run"]')).toContainText(
      'Sin unidad vinculada',
    );
    await expect(panel.locator('[data-run="run:ambiguous"]')).toContainText(
      'Identidad registrada ambigua',
    );
    await expect(panel.locator('.activity-card')).toHaveCount(44);
    const summary = card.locator('summary').first();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(card.locator('details').first()).toHaveAttribute('open', '');
    const body = panel.locator('.task-body');
    await body.evaluate((el) => {
      el.scrollTop = 100;
    });
    const scroll = await body.evaluate((el) => el.scrollTop);
    stage = 'grown';
    await page.evaluate(async () => {
      const { refreshTaskInventory } = await import('/src/ui/taskPanel.ts');
      await refreshTaskInventory();
    });
    await expect(card).toContainText('3 procesos', { timeout: 10_000 });
    await expect(summary).toBeFocused();
    await expect(card.locator('details').first()).toHaveAttribute('open', '');
    expect(await body.evaluate((el) => el.scrollTop)).toBe(scroll);
    expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await body.evaluate((el) => {
      el.scrollTop = 0;
    });
    await card.getByRole('button', { name: '⬡ WORKER-2', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`activity-fixture-${width}.png`) });
    stage = 'unavailable';
    await page.evaluate(async () => {
      const { refreshTaskInventory } = await import('/src/ui/taskPanel.ts');
      await refreshTaskInventory();
    });
    await expect(panel).toContainText('Inventario no disponible', { timeout: 10_000 });
    await expect(card).toContainText('3 procesos');
    await card.getByRole('button', { name: 'Ver Crónica', exact: true }).click();
    await expect(page.locator('#log-panel')).toBeVisible();
    await expect(page.locator('#log-panel .activity-context')).toContainText('WORKER-2');
    await page
      .locator('#log-panel')
      .getByRole('button', { name: 'Actividad de la selección' })
      .click();
    await expect(panel).toBeVisible();
    await expect(card.locator('details').first()).toHaveAttribute('open', '');
  });
}
