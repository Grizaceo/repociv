import { expect, test } from '@playwright/test';
import type { ExternalSessionRow } from '../src/externalAgents.ts';

test('compact attention strip: bounded row, truthful states, overflow and F8 chat', async ({
  page,
}) => {
  // Synthetic metadata, real app and real pointer/keyboard interactions. No agent is launched.
  const rows: ExternalSessionRow[] = Array.from({ length: 8 }, (_, i) => ({
    sessionId: `attention-fixture-${i}`,
    source: 'hermes',
    agent: 'hermes',
    profile: `test-${i}`,
    model: 'test',
    repo: '/fixture/city',
    cityId: '',
    active: true,
    state: i === 0 ? 'thinking' : 'working',
    unit: null,
    unitType: 'hero',
    firstActivityAt: Date.now() / 1000,
    lastActivityAt: Date.now() / 1000,
    commandCount: 1,
    eventCount: 1,
    totalTokens: null,
    subagent: false,
    imported: true,
    liveChat: { state: 'unavailable', transport: null, reason: 'test fixture' },
  }));
  await page.route('**/api/external-agents/sessions', (route) =>
    route.fulfill({ json: { sessions: rows } }),
  );
  await page.route('**/api/external-agents/attention-fixture-*/chat?*', (route) =>
    route.fulfill({
      json: { session: rows[1], messages: [], hasMore: false, available: true },
    }),
  );
  let approvals: unknown[] = [];
  await page.route('**/approvals', (route) => route.fulfill({ json: approvals }));
  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    localStorage.setItem('repociv:world-render-mode', 'canvas');
  });
  await page.goto('/');
  const strip = page.locator('#agent-attention-strip');
  await expect(strip).toBeVisible({ timeout: 60_000 });
  await expect(strip.locator('.attention-chip')).toHaveCount(5);
  await expect(strip.locator('.attention-more')).toContainText('+');
  await expect(strip.locator('[data-status="blocked"]')).toHaveCount(0);
  const focused = strip.locator('[data-attention-id="external:attention-fixture-1"]');
  await focused.focus();
  rows[1]!.repo = '/fixture/renamed-city';
  await page.evaluate(async () => {
    const path = '/src/ui/externalSessionDirectory.ts';
    const directory = await import(/* @vite-ignore */ path);
    await directory.refreshExternalSessionDirectory();
  });
  await expect(focused).toHaveAttribute('title', /renamed-city/);
  await expect(focused).toBeFocused();
  rows[1]!.state = 'idle';
  await page.evaluate(async () => {
    const path = '/src/ui/externalSessionDirectory.ts';
    const directory = await import(/* @vite-ignore */ path);
    await directory.refreshExternalSessionDirectory();
  });
  await expect(focused).toHaveAttribute('data-status', 'unreviewed');
  await expect(page.locator('.attention-announcement')).toContainText(
    '1 agentes con actividad sin revisar',
  );
  const box = await strip.boundingBox();
  expect(box?.height).toBe(36);
  expect(box?.width).toBeLessThanOrEqual(620);
  await strip.locator('[data-attention-id="external:attention-fixture-1"]').click();
  await expect(page.locator('#agents-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('F8');
  await expect(page.locator('#agents-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  approvals = [
    {
      id: 'attention-approval-fixture',
      type: 'agent_spawn',
      target: 'fixture-city',
      risk: 'high',
      payload: {},
      created_by: 'test',
      created_at: Date.now() / 1000,
    },
  ];
  const approval = strip.locator('[data-attention-id="approvals"]');
  await expect(approval).toHaveAccessibleName(/1 aprobaciones pendientes/, { timeout: 15_000 });
  await expect(page.locator('.attention-announcement')).toContainText('1 aprobaciones pendientes');
  await approval.click();
  await expect(page.locator('#approval-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  for (const width of [320, 390, 701]) {
    await page.setViewportSize({ width, height: 740 });
    for (const button of await strip.locator('button').all()) {
      await expect(button).toBeInViewport();
      const bounds = await button.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    const mobile = await strip.boundingBox();
    expect(mobile!.x + mobile!.width).toBeLessThanOrEqual(width);
  }
  await strip.locator('.attention-more').click();
  await expect(page.locator('#agents-panel')).toBeVisible();
});
