import { expect, test } from '@playwright/test';

// Real panel modules + intercepted metadata. No tasks, agents or user stores written.
for (const width of [1280, 390]) {
  test(`activity navigation, evidence and keyboard at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let missing = false;
    let inventoryUnavailable = false;
    let processGets = 0;
    const processes = [
      {
        pid: 10,
        ppid: 1,
        rootPid: 10,
        processIdentity: 'boot:10:100',
        family: 'Hermes',
        name: 'hermes',
        state: 'S',
        role: 'agent',
      },
      {
        pid: 11,
        ppid: 10,
        rootPid: 10,
        processIdentity: 'boot:11:101',
        family: 'Hermes',
        name: 'helper',
        state: 'S',
        role: 'descendant',
      },
      {
        pid: 20,
        ppid: 1,
        rootPid: 20,
        processIdentity: 'boot:20:200',
        family: 'Hermes',
        name: 'hermes',
        state: 'S',
        role: 'agent',
      },
    ];
    const history = [
      {
        id: 'identity',
        type: 'ExecutionIdentityRecorded',
        commandId: 'run1',
        timestamp: 1,
        data: {
          commandId: 'run1',
          commandType: 'execute_agent',
          unitId: 'WORKER-2',
          agentName: 'Worker',
          harness: 'hermes',
          profileName: 'worker',
        },
      },
      {
        id: '1',
        type: 'TaskRunLinked',
        timestamp: 1,
        data: { runId: 'run1', commandId: 'run1', taskKey: 'repo::issue', agentId: 'WORKER' },
      },
      {
        id: '2',
        type: 'ProcessBound',
        timestamp: 2,
        data: { commandId: 'run1', processIdentity: 'boot:10:100', pid: 10, agentId: 'WORKER' },
      },
      { id: '3', type: 'CommandCompleted', commandId: 'run1', timestamp: 3, data: {} },
      { id: '4', type: 'CommandStarted', commandId: 'unrelated', timestamp: 4, data: {} },
    ];
    await page.route('**/api/agent-processes', (route) => {
      processGets++;
      return inventoryUnavailable
        ? route.fulfill({ status: 503, json: { error: 'unavailable' } })
        : route.fulfill({
            json: { available: true, unreadable: 0, processes: missing ? [] : processes },
          });
    });
    await page.route('**/tasks', (route) =>
      route.fulfill({
        json: [
          {
            key: 'repo::issue',
            repo: 'repo',
            issueId: 'issue',
            phase: 'executing',
            stepCurrent: 1,
            stepCount: 2,
            startedAt: '',
            updatedAt: '',
          },
        ],
      }),
    );
    await page.route('**/log?*', (route) =>
      route.fulfill({
        json: route.request().url().includes('before=')
          ? {
              events: [
                {
                  id: 'older',
                  sourceOffset: 0,
                  type: 'CommandFailed',
                  commandId: 'older-command',
                  timestamp: 0,
                  data: {},
                },
              ],
              before: 0,
              more: false,
            }
          : { events: history, before: 42, more: true },
      }),
    );
    await page.route('**/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><link rel="stylesheet" href="/src/styles/index.css"></head><body><button id="open">Actividad</button><script type="module">
      import { openTaskPanel } from '/src/ui/taskPanel.ts';
      import { refreshActivityHistory } from '/src/ui/logPanel.ts';
      import { bindAgentsPanel } from '/src/ui/agentsPanel.ts';
      bindAgentsPanel({ state: { getUnit: id => id === 'WORKER-2' ? {id} : null, getAllUnits: () => [], world: {cities:[]} }, locate: () => {}, startSession: async () => null, selectOwnUnit: unit => { window.selectedFixtureUnit = unit.id; } });
      document.querySelector('#open').onclick = openTaskPanel;
      window.refreshHistory = refreshActivityHistory;
      document.querySelector('#open').dataset.ready = 'true';
    </script></body></html>`,
      }),
    );
    await page.goto('/');
    await expect(page.locator('#open')).toHaveAttribute('data-ready', 'true');
    await page.locator('#open').click();
    const taskPanel = page.locator('#task-panel');
    const root = taskPanel.getByRole('button', {
      name: '⬡ WORKER-2',
      exact: true,
    });
    await expect(root).toBeVisible();
    const color = await root.evaluate((el) => getComputedStyle(el).borderLeftColor);
    const card = taskPanel.locator('[data-run="run:run1"]');
    await expect(card).toContainText('Harness: Hermes');
    await expect(card).toContainText('Profile: worker');
    await card.locator('summary').first().click();
    await expect(
      taskPanel.getByRole('button', { name: '⬡ PID 11 ← PPID 10 · helper', exact: true }),
    ).toHaveCSS('border-left-color', color);
    await expect(card).toContainText('1 descendientes');
    await expect(
      taskPanel.getByRole('button', { name: '⬡ Proceso externo · hermes', exact: true }),
    ).toBeVisible();
    await root.focus();
    await page.keyboard.press('Enter');
    await expect(root).toHaveAttribute('aria-pressed', 'true');
    await expect(root).toBeFocused();
    await page.waitForTimeout(3200);
    await expect(root).toBeFocused();
    await expect(card.locator('details').first()).toHaveAttribute('open', '');
    await taskPanel.getByRole('button', { name: 'Crónica de la selección' }).click();
    const log = page.locator('#log-panel');
    await expect(log).toBeVisible();
    await expect(taskPanel).toBeHidden();
    await expect(log.locator('tbody tr')).toHaveCount(4);
    await expect(log).toContainText('Comando completado (no valida la tarea)');
    await expect(log).toContainText('PID 11 ← PPID 10');
    await expect(log.locator('[data-activity]').first()).toHaveCSS('border-left-color', color);
    await log.getByLabel('Filtrar por tipo').selectOption('CommandCompleted');
    await expect(log.locator('tbody tr')).toHaveCount(1);
    await log.locator('[data-activity]').focus();
    await page.evaluate(() =>
      (window as unknown as { refreshHistory: () => Promise<void> }).refreshHistory(),
    );
    await expect(log.locator('[data-activity]')).toBeFocused();
    const box = await log.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`activity-${width}.png`) });
    inventoryUnavailable = true;
    await expect(log).toContainText('procesos anteriores posiblemente desactualizados');
    inventoryUnavailable = false;
    missing = true;
    await expect(log).toContainText('0 procesos en el último inventario');
    await expect(log.locator('tbody tr')).toHaveCount(1);
    await expect(log).toContainText('Comando completado (no valida la tarea)');
    await log.getByLabel('Filtrar por tipo').selectOption('');
    await log.getByRole('button', { name: 'Todas las ejecuciones', exact: true }).click();
    await expect(log.locator('tbody tr')).toHaveCount(5);
    await log.getByRole('button', { name: 'Cargar historia anterior' }).click();
    await expect(log.locator('tbody tr')).toHaveCount(6);
    await log.locator('tbody details').last().locator('summary').click();
    await expect(log).toContainText('older-command');
    await page.evaluate(() =>
      (window as unknown as { refreshHistory: () => Promise<void> }).refreshHistory(),
    );
    await expect(log.locator('tbody tr')).toHaveCount(6);
    await log.locator('[data-activity="run:unrelated"]').click();
    await expect(log.locator('tbody tr')).toHaveCount(1);
    await log.getByRole('button', { name: 'Actividad de la selección', exact: true }).click();
    await expect(taskPanel.locator('.activity-context')).toHaveText('Comando registrado');
    await expect(log).toBeHidden();
    // A single active panel's loop should be running, not both timers.
    expect(processGets).toBeLessThan(20);
    expect(
      await taskPanel.locator('.task-body').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await taskPanel.getByRole('button', { name: 'Todas las ejecuciones', exact: true }).click();
    await card.getByRole('button', { name: 'Ver unidad', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { selectedFixtureUnit?: string }).selectedFixtureUnit,
        ),
      )
      .toBe('WORKER-2');
    expect(errors).toEqual([]);
  });
}
