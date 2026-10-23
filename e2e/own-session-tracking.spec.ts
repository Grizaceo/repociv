import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Real GameState and UI, isolated from the game loop and agent execution.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(
    '</body>',
    `<script type="module">
    import '/src/styles/index.css';
    import { GameState } from '/src/game.ts';
    import { bindAgentsPanel, openAgentsPanel, closeAgentsPanel } from '/src/ui/agentsPanel.ts';
    import { spawnAcceptedSession } from '/src/ui/hudWiring/spawn.ts';
    import { bindChatAgentLocator } from '/src/ui/chat/panel.ts';
    import { setActiveChatUnit } from '/src/ui/chat/state.ts';
    import { agentLocation } from '/src/ui/agentLocation.ts';
    document.getElementById('loading-screen')?.remove();
    const city = { id: 'lab', name: 'Laboratorio', coord: {q: 7, r: -3}, repoPath: '/fixture/lab' };
    const state = new GameState({ tiles: new Map(), cities: [city], units: [], buildings: [],
      resources: {gold: 0, science: 0, production: 0, culture: 0}, restAreas: [], generatedAt: 0 });
    const renderer = { selectUnit() {} };
    const located = [];
    const selected = [];
    bindAgentsPanel({state, locate: c => located.push(c), selectOwnUnit: u => selected.push(u.id),
      startSession: async () => ({ok: false})});
    bindChatAgentLocator(id => {
      const unit = state.getUnit(id);
      if (unit) located.push(agentLocation(unit, state.world.cities));
    });
    window.tracking = {state, located, selected, openAgentsPanel, closeAgentsPanel, setActiveChatUnit,
      spawn(id = 'SCOUT') {
        return spawnAcceptedSession({name: id, display_name: id, harness: 'hermes'}, city,
          'Revisar <img src=x onerror=alert(1)>', id, state, renderer, {});
      }};
    window.trackingReady = true;
  </script></body>`,
  );

async function mount(page: Page, sessions: unknown[] = []) {
  // No live bridge reads/writes: all API responses in this harness are fixtures.
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    const json = url.endsWith('/sessions')
      ? { sessions }
      : url.includes('/chat?')
        ? { session: sessions[0], available: true, messages: [], hasMore: false }
        : { agents: [] };
    return route.fulfill({ json });
  });
  await page.route('**/__own-session-test', (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto('/__own-session-test');
  await page.waitForFunction(() => (window as any).trackingReady);
}

async function action(page: Page, code: string) {
  await page.evaluate(code);
}

test('own sessions appear immediately in open F8 and survive completed work and reopening', async ({
  page,
}) => {
  await mount(page);
  await action(page, 'tracking.openAgentsPanel()');
  await expect(page.locator('.agents-own')).toHaveCount(0);
  await action(page, 'tracking.spawn()');
  const scout = page.locator('.agents-own[data-unit="SCOUT"]');
  await expect(scout).toBeVisible();
  await expect(scout).toContainText('Laboratorio');
  await expect(scout).toContainText('Revisar <img');
  await expect(scout.locator('img')).toHaveCount(0);
  await action(page, 'tracking.state.setUnitState("SCOUT", "working")');
  await expect(scout.locator('.agents-own-state')).toHaveText('working');
  await action(page, 'tracking.state.setUnitState("SCOUT", "idle")');
  await expect(scout.locator('.agents-own-state')).toHaveText('idle');
  await action(
    page,
    'tracking.closeAgentsPanel(); tracking.spawn("SECOND"); tracking.openAgentsPanel()',
  );
  await expect(page.locator('.agents-own')).toHaveCount(2);
  await scout.click();
  await expect
    .poll(() => page.evaluate(() => (window as any).tracking.located.at(-1)))
    .toEqual({ q: 7, r: -3 });
});

test('F8 chat agent name focuses its city rather than the adjacent agent hex', async ({ page }) => {
  await mount(page, [
    {
      sessionId: 'fixture-ext',
      source: 'suvadu',
      agent: 'codex',
      model: 'fixture',
      repo: '/fixture/lab',
      cityId: 'lab',
      active: true,
      state: 'working',
      unit: 'ext-fixture',
      unitType: 'hero',
      firstActivityAt: 0,
      lastActivityAt: 0,
      commandCount: 0,
      eventCount: 0,
      totalTokens: null,
      subagent: false,
      imported: false,
      liveChat: { available: false },
    },
  ]);
  await action(
    page,
    `tracking.state.spawnUnit('ext-fixture', 'External', 'hero', 'capital', {q: 9, r: -3});
    tracking.openAgentsPanel()`,
  );
  await page.locator('[data-session="fixture-ext"]').click();
  const name = page.locator('.agents-chat-agent');
  await expect(name).toBeVisible();
  await action(page, 'tracking.located.length = 0');
  await name.click();
  expect(await page.evaluate(() => (window as any).tracking.located)).toEqual([{ q: 7, r: -3 }]);
});

test('chat header navigates to the active conversation city, not a stale map selection', async ({
  page,
}) => {
  await mount(page);
  await action(
    page,
    `tracking.spawn(); tracking.spawn('SECOND');
    tracking.state.setUnitCity('SECOND', 'missing');
    tracking.state.getUnit('SECOND').coord = {q: -10, r: 4};
    document.getElementById('side-panel').classList.remove('hidden');
    tracking.setActiveChatUnit('SCOUT');`,
  );
  const name = page.locator('#side-hero-name');
  await name.click();
  expect(await page.evaluate(() => (window as any).tracking.located.at(-1))).toEqual({
    q: 7,
    r: -3,
  });
  await action(page, `tracking.setActiveChatUnit('SECOND')`);
  await name.click();
  expect(await page.evaluate(() => (window as any).tracking.located.at(-1))).toEqual({
    q: -10,
    r: 4,
  });
});
