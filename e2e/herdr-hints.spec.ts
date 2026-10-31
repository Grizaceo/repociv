import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { ExternalSessionRow } from '../src/externalAgents.ts';

const stopped = 'herdr no está corriendo. Ábrelo con herdr en una terminal y abre este agente en un panel.';
const missing = 'RepoCiv solo puede escribirle a Claude y Devin cuando corren dentro de herdr, y herdr no está instalado. Instálalo (README → «Agentes en herdr») y abre ahí el agente.';
const readyClaude = 'Este Claude corre en una terminal fuera de herdr: RepoCiv lo lee, pero no puede escribirle. Para hablarle desde aquí, ciérralo y retómalo en un panel de herdr (ya cerrado, ⏎ copia el comando), o lanza uno nuevo con «+ Sesión» → En herdr.';
const readyDevin = 'Este Devin corre en una terminal fuera de herdr: RepoCiv lo lee, pero no puede escribirle. Para hablarle desde aquí, ábrelo dentro de un panel de herdr, o lanza uno nuevo con «+ Sesión» → En herdr.';
const unknown = 'Este agente no corre dentro de herdr, así que RepoCiv no puede escribirle. Ábrelo en un panel de herdr para hablarle desde aquí.';

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    sessionStorage.setItem('repociv:hermes-banner-dismissed', '1');
    localStorage.setItem('repociv:renderer', 'flat');
  });
  await page.goto('/');
  await expect(page.locator('#agent-attention-strip')).toBeVisible({ timeout: 60_000 });
}

async function stage(page: Page, family: 'claude' | 'devin', state: string, longChat = false, version = '0.9.1') {
  const row: ExternalSessionRow = {
    sessionId: 'herdr-hint-fixture', source: 'suvadu', agent: family,
    model: 'test', repo: '/fixture/city', cityId: '', active: true, state: 'working', unit: null,
    unitType: 'hero', firstActivityAt: Date.now() / 1000, lastActivityAt: Date.now() / 1000,
    commandCount: 1, eventCount: 1, totalTokens: null, subagent: false, imported: true,
    liveChat: { state: 'unavailable', transport: null, reason: family === 'claude'
      ? 'claude_control_channel_unavailable' : 'devin_live_chat_unavailable' },
    herdrPane: null,
  };
  let runtime = state;
  let requests = 0;
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/external-agents/sessions', (route) => route.fulfill({ json: { sessions: [row] } }));
  await page.route(/\/api\/external-agents\/[^/]+\/chat/, (route) =>
    route.fulfill({ json: {
      session: row, available: true, hasMore: false,
      messages: longChat ? Array.from({ length: 12 }, () =>
        ({ role: 'assistant', text: 'Respuesta anterior del agente.', at: null, turn: null, truncated: false })) : [],
    } }),
  );
  await page.route('**/api/herdr/agents', async (route) => {
    requests++;
    if (runtime === 'error') return route.fulfill({ status: 503, body: '' });
    if (runtime === 'pending') {
      await pending;
      runtime = 'ready';
    }
    return route.fulfill({ json: { runtime: { state: runtime, version, minVersion: '0.9.1' }, agents: [] } });
  });
  await boot(page);
  await page.keyboard.press('F8');
  const before = requests;
  await page.locator('.agents-card[data-session="herdr-hint-fixture"]').click();
  return { requests: () => requests - before, setRuntime: (value: string) => { runtime = value; }, release };
}

async function inside(child: Locator, parent: Locator) {
  await expect(child).toBeVisible();
  const box = (await child.boundingBox())!;
  const bounds = (await parent.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(bounds.x);
  expect(box.y).toBeGreaterThanOrEqual(bounds.y);
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  const viewport = child.page().viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

async function screenshot(page: Page, panel: Locator, name: string) {
  if (!process.env.HERDR_HINT_SHOTS) return;
  await expect(page.locator('#imperial-welcome')).toBeHidden();
  await panel.screenshot({ path: `${process.env.HERDR_HINT_SHOTS}-${name}.png`, animations: 'disabled' });
}

test('stopped herdr shows a fully visible composer hint and refreshes on demand', async ({ page }) => {
  const fixture = await stage(page, 'claude', 'stopped', true);
  const panel = page.locator('#agents-panel');
  const hint = panel.locator('.agents-compose-hint');
  await expect(hint).toHaveText(stopped);
  await expect(hint.locator('code')).toHaveText('herdr');
  await expect.poll(fixture.requests).toBe(1);
  await inside(hint, panel);
  await inside(panel.locator('.agents-compose'), panel);
  expect(await hint.evaluate((el) => el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await panel.locator('.agents-compose').evaluate((el) =>
    el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth)).toBe(true);
  await screenshot(page, panel, 'stopped');
  fixture.setRuntime('ready');
  await panel.getByRole('button', { name: 'Actualizar' }).click();
  await expect(hint).toHaveText(readyClaude);
  await expect.poll(fixture.requests).toBe(2);
});

test('ready herdr gives Devin the approved hint', async ({ page }) => {
  await stage(page, 'devin', 'ready');
  await expect(page.locator('#agents-panel .agents-compose-hint')).toHaveText(readyDevin);
});

test('ready herdr gives Claude the approved hint', async ({ page }) => {
  await stage(page, 'claude', 'ready');
  const panel = page.locator('#agents-panel');
  await expect(panel.locator('.agents-compose-hint')).toHaveText(readyClaude);
  await inside(panel.locator('.agents-compose-hint'), panel);
  await screenshot(page, panel, 'ready-claude');
});

test('an unreachable bridge gives the unknown hint', async ({ page }) => {
  await stage(page, 'claude', 'error');
  await expect(page.locator('#agents-panel .agents-compose-hint')).toHaveText(unknown);
});

test('the unknown hint remains visible while the runtime is loading', async ({ page }) => {
  const fixture = await stage(page, 'claude', 'pending');
  await expect(page.locator('#agents-panel .agents-compose-hint')).toHaveText(unknown);
  fixture.release();
  await expect(page.locator('#agents-panel .agents-compose-hint')).toHaveText(readyClaude);
});

test('the outdated hint escapes runtime versions before marking commands as code', async ({ page }) => {
  await stage(page, 'claude', 'outdated', false, '0.8.0<img src=x>');
  const hint = page.locator('#agents-panel .agents-compose-hint');
  await expect(hint).toContainText('tienes 0.8.0<img src=x>.');
  await expect(hint.locator('img')).toHaveCount(0);
  await expect(hint.locator('code')).toHaveText('herdr update');
});

test('the terminal picker explains a missing herdr', async ({ page }) => {
  await page.route('**/api/herdr/agents', (route) =>
    route.fulfill({ json: { runtime: { state: 'missing', version: '', minVersion: '0.9.1' }, agents: [] } }),
  );
  await boot(page);
  await page.keyboard.press('t');
  const panel = page.locator('#terminal-panel');
  const hint = panel.locator('.terminal-picker .agents-empty');
  await expect(hint).toHaveText(missing);
  await inside(hint, panel);
  await screenshot(page, panel, 'terminal-missing');
});
