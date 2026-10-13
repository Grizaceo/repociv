import { expect, test, type Page } from '@playwright/test';

const observedStart = Date.UTC(2026, 9, 13, 18);
function inventory(sampledAtMs = observedStart + 100_000) {
  const entries = Array.from({ length: 35 }, (_, i) => ({
    repoPath: '/repos/demo',
    repoName: 'demo',
    worktreePath: `/repos/worktree-${i}`,
    branch: `feature-${i}`,
    detached: i === 2,
    head: 'abc123',
    state: 'dirty',
    stagedCount: 1,
    unstagedCount: 1,
    untrackedCount: 0,
    conflictCount: i === 0 ? 1 : 0,
    changedCount: 1,
    files: [{ path: `src/long path ${i}/file<script>.ts`, index: 'M', worktree: 'M' }],
    firstObservedAtMs: observedStart + (i === 0 ? 90_000 : 1000 + i),
    lastObservedAtMs: sampledAtMs,
    ageMs: sampledAtMs - observedStart - (i === 0 ? 90_000 : 1000 + i),
    relatedSessions:
      i === 0 ? [{ id: 's-1', name: 'DAVI', status: 'idle', lastActivityAtMs: 9000 }] : [],
  }));
  return { available: true, sampledAtMs, entries, errors: [] };
}
async function harness(page: Page, theme = 'dark'): Promise<void> {
  await page.route('**/api/agent-processes', (route) =>
    route.fulfill({ json: { available: true, processes: [], unreadable: 0 } }),
  );
  await page.route('**/tasks', (route) => route.fulfill({ json: [] }));
  await page.route('**/log?*', (route) =>
    route.fulfill({ json: { ok: true, paged: true, events: [], cursor: 0, more: false } }),
  );
  await page.route('**/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `
    <!doctype html><html data-theme="${theme}"><head><link rel="stylesheet" href="/src/styles/index.css"></head>
    <body><button id="open">Actividad</button><script type="module">
      import { openTaskPanel, refreshTaskInventory } from '/src/ui/taskPanel.ts';
      window.refreshPendingFixture = refreshTaskInventory;
      document.querySelector('#open').onclick = openTaskPanel;
      document.querySelector('#open').dataset.ready = 'true';
    </script></body></html>`,
    }),
  );
  await page.goto('/');
  await expect(page.locator('#open')).toHaveAttribute('data-ready', 'true');
  await page.locator('#open').click();
}
async function refresh(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (
      window as unknown as { refreshPendingFixture: () => Promise<void> }
    ).refreshPendingFixture();
  });
}
for (const [width, theme] of [
  [1280, 'dark'],
  [390, 'dark'],
  [1280, 'light'],
  [390, 'light'],
] as const) {
  test(`pending work comes first, retains details/focus and stale data at ${width}px ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    let sample = observedStart + 100_000;
    let fail = false;
    await page.route('**/api/pending-work', (route) =>
      fail
        ? route.fulfill({ status: 503, json: { error: 'offline' } })
        : route.fulfill({ json: inventory(sample) }),
    );
    await harness(page, theme);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.body).getPropertyValue('--ui-text').trim(),
      ),
    ).not.toBe('');
    const panel = page.locator('#task-panel');
    await expect(panel.locator('.pending-work-card')).toHaveCount(35);
    await expect(panel.locator('.task-body > section').first()).toHaveClass('pending-work');
    await expect(panel.locator('.pending-work-card').first()).toHaveAttribute(
      'data-worktree',
      '/repos/worktree-0',
    );
    const card = panel.locator('[data-worktree="/repos/worktree-0"]');
    const summary = card.locator('summary').last();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(card.locator('details').last()).toHaveAttribute('open', '');
    await expect(card).toContainText('file<script>.ts');
    await expect(card.locator('script')).toHaveCount(0);
    sample += 3000;
    await refresh(page);
    await expect(summary).toBeFocused();
    await expect(card.locator('details').last()).toHaveAttribute('open', '');
    await expect(card).toContainText('no acredita autoría');
    await expect(panel).toContainText('Antigüedad observada, no edad real');
    await expect(panel.locator('[data-worktree="/repos/worktree-2"]')).toContainText(
      'HEAD separado',
    );
    expect(
      await panel.locator('.task-body').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    const box = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await panel.locator('.task-body').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: testInfo.outputPath(`pending-work-${width}-${theme}.png`) });
    fail = true;
    await refresh(page);
    await expect(panel).toContainText('datos anteriores posiblemente desactualizados');
    await expect(panel.locator('.pending-work-card')).toHaveCount(35);
  });
}
test('missing endpoint or invalid payload is unavailable, not a clean inventory', async ({
  page,
}) => {
  await page.route('**/api/pending-work', (route) =>
    route.fulfill({ json: { available: true, entries: [] } }),
  );
  await harness(page);
  await expect(page.locator('.pending-work')).toContainText(
    'Respuesta de trabajo pendiente inválida',
  );
  await expect(page.locator('.pending-work')).not.toContainText('Sin cambios sin commit');
});
