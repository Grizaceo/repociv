import { expect, test } from '@playwright/test';
import type { Locator, Page, WebSocketRoute } from '@playwright/test';
import type { ExternalChatMessage, ExternalSessionRow } from '../src/externalAgents.ts';

const agent = {
  paneId: 'w1:p1', terminalId: 'term_a', agent: 'claude', status: 'idle', name: '', folder: 'city',
};
const row: ExternalSessionRow = {
  sessionId: 'agent-fixture', source: 'suvadu', agent: 'claude', model: 'test',
  repo: '/fixture/city', cityId: '', active: true, state: 'working', unit: null, unitType: 'hero',
  firstActivityAt: Date.now() / 1000, lastActivityAt: Date.now() / 1000,
  commandCount: 1, eventCount: 1, totalTokens: null, subagent: false, imported: true,
  liveChat: { state: 'unavailable', transport: null, reason: 'fixture' }, herdrPane: agent,
};
type WireMessage = { type: string; id?: string; text?: string; screen?: boolean };

async function stage(
  page: Page, options: { result?: string; reason?: string; noPane?: boolean; noResult?: boolean } = {},
) {
  const messages: ExternalChatMessage[] = [
    { role: 'user', text: 'pregunta anterior', at: null, turn: null, truncated: false },
    { role: 'assistant', text: '**respuesta anterior**', at: null, turn: null, truncated: false },
  ];
  const chosen = options.noPane ? { ...row, herdrPane: null, state: 'idle' as const, active: false } : row;
  const wire: WireMessage[] = [];
  let socket: WebSocketRoute | undefined;
  await page.route('**/api/external-agents/sessions', (route) => route.fulfill({ json: { sessions: [chosen] } }));
  await page.route(/\/api\/external-agents\/[^/]+\/chat/, (route) =>
    route.fulfill({ json: { session: chosen, messages, available: true, hasMore: false } }),
  );
  await page.routeWebSocket(/\/repociv-ws\/terminal/, (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as WireMessage;
      wire.push(message);
      if (message.type === 'attach') {
        ws.send(JSON.stringify({ type: 'attached', agent, cols: 80, rows: 24, history: '' }));
        if (message.screen !== false) ws.send(Buffer.from('\x1b[2J\x1b[1;1Hpantalla viva'));
      }
      if (message.type === 'submit' && !options.noResult) {
        ws.send(JSON.stringify({
          type: 'submit_result', id: message.id, state: options.result ?? 'confirmed',
          reason: options.reason ?? null,
        }));
      }
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    sessionStorage.setItem('repociv:hermes-banner-dismissed', '1');
    localStorage.setItem('repociv:renderer', 'flat');
  });
  await page.goto('/');
  await expect(page.locator('#agent-attention-strip')).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('F8');
  await page.locator('.agents-card[data-session="agent-fixture"]').click();
  return {
    wire, messages, socket: () => socket!,
    addUser(text: string) {
      messages.push({ role: 'user', text, at: null, turn: null, truncated: false });
    },
  };
}

test('opens the side panel with bubbles, status, basename and screenless attach', async ({ page }) => {
  const { wire } = await stage(page);
  const panel = page.locator('#side-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.side-tab[data-tab="chat"]')).toHaveClass(/active/);
  await expect(panel.locator('#agent-window .chat-msg.user')).toContainText('pregunta anterior');
  await expect(panel.locator('#agent-window .chat-msg.assistant strong')).toHaveText('respuesta anterior');
  await expect(panel.locator('.agent-window-status')).toContainText('listo');
  await expect(panel.locator('.agent-window-place')).toHaveText('city');
  await expect(panel).not.toContainText('/fixture');
  await expect.poll(() => wire.some((m) => m.type === 'attach' && m.screen === false)).toBe(true);
  await page.locator('#agent-window textarea').fill('t');
  await page.keyboard.press('t');
  await expect(page.locator('#terminal-panel')).toBeHidden();
});

test('fresh agent chat keeps its composer and last message inside the side panel', async ({ page }) => {
  await stage(page);
  expect(await page.evaluate(() => localStorage.getItem('repociv:hud-window:v1:side-panel'))).toBeNull();
  const panel = page.locator('#side-panel');
  await expect(panel).toHaveClass(/hud-window--placed/);
  const message = panel.locator('#agent-window .chat-msg').last();
  await expect(message).toContainText('respuesta anterior');
  const panelRect = (await panel.boundingBox())!;
  const composerRect = (await panel.locator('.agent-window-input-row').boundingBox())!;
  const logRect = (await panel.locator('.agent-window-log').boundingBox())!;
  const messageRect = (await message.boundingBox())!;
  const inside = (box: typeof panelRect, parent: typeof panelRect) =>
    box.x >= parent.x && box.y >= parent.y &&
    box.x + box.width <= parent.x + parent.width &&
    box.y + box.height <= parent.y + parent.height;
  expect({
    height: panelRect.height >= 300,
    composer: inside(composerRect, panelRect),
    message: inside(messageRect, panelRect) && inside(messageRect, logRect),
  }).toEqual({ height: true, composer: true, message: true });
});

test('agent window uses RepoCiv typography and buttons without overflowing', async ({ page }) => {
  const fixture = await stage(page);
  await expect.poll(() => fixture.wire.some((m) => m.type === 'attach')).toBe(true);
  const panel = page.locator('#side-panel');
  const window = panel.locator('#agent-window');
  const header = window.locator('.agent-window-header');
  const selectors = ['.agent-window-locate', '.agent-window-cli', '.agent-window-send'];
  const screenshots = process.env.AGENT_WINDOW_SHOTS;
  if (screenshots) {
    await expect(page.locator('#imperial-welcome')).toBeHidden();
    await panel.screenshot({ path: `${screenshots}-normal.png`, animations: 'disabled' });
  }
  const checkGeometry = async (buttons: Locator[]) => {
    const panelRect = (await panel.boundingBox())!;
    for (const button of buttons) {
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect.soft(box.x >= panelRect.x && box.y >= panelRect.y &&
        box.x + box.width <= panelRect.x + panelRect.width &&
        box.y + box.height <= panelRect.y + panelRect.height).toBe(true);
    }
    expect.soft(await header.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  };
  await checkGeometry([window.locator(selectors[0]), window.locator(selectors[1])]);

  const normal = await window.evaluate((root, buttonSelectors) => {
    const reference = document.createElement('button');
    reference.className = 'agents-compose-send';
    const native = document.createElement('button');
    native.style.all = 'revert';
    const font = document.createElement('span');
    font.style.fontFamily = 'var(--font-ui)';
    root.append(reference, native, font);
    const style = (element: Element) => {
      const css = getComputedStyle(element);
      return { font: css.fontFamily, background: css.backgroundColor, border: css.borderTopColor, color: css.color };
    };
    const result = {
      font: style(font).font,
      native: style(native),
      reference: style(reference),
      elements: Object.fromEntries(
        ['.agent-window-status', '.agent-window-place', ...buttonSelectors]
          .map((selector) => [selector, style(root.querySelector(selector)!)]),
      ),
    };
    reference.remove();
    native.remove();
    font.remove();
    return result;
  }, selectors);

  fixture.socket().send(JSON.stringify({ type: 'status', status: 'blocked' }));
  const noticeButton = window.locator('.agent-window-notice button');
  await expect(noticeButton).toBeVisible();
  if (screenshots) await panel.screenshot({ path: `${screenshots}-blocked.png`, animations: 'disabled' });
  const blockedStyle = await noticeButton.evaluate((element) => {
    const css = getComputedStyle(element);
    return { font: css.fontFamily, background: css.backgroundColor, border: css.borderTopColor, color: css.color };
  });

  for (const [selector, style] of Object.entries(normal.elements)) {
    expect.soft(style.font, `${selector} font`).toBe(normal.font);
    expect.soft(style.font, `${selector} is not browser font`).not.toBe(normal.native.font);
  }
  expect.soft(blockedStyle.font, 'blocked CLI font').toBe(normal.font);
  expect.soft(blockedStyle.font, 'blocked CLI is not browser font').not.toBe(normal.native.font);
  for (const [selector, style] of [
    ...selectors.map((selector) => [selector, normal.elements[selector]] as const),
    ['blocked CLI', blockedStyle] as const,
  ]) {
    for (const property of ['background', 'border', 'color'] as const) {
      expect.soft(style[property], `${selector} ${property} matches RepoCiv button`).toBe(normal.reference[property]);
      expect.soft(style[property], `${selector} ${property} is not native`).not.toBe(normal.native[property]);
    }
  }
  await checkGeometry([window.locator(selectors[0]), window.locator(selectors[1]), noticeButton]);
});

for (const variant of [
  { result: 'confirmed', reason: undefined, label: 'Entregado' },
  { result: 'unconfirmed', reason: 'agent_busy', label: 'Sin confirmar' },
]) {
  test(`${variant.result} ${variant.reason ?? ''} reconciles a late transcript once`, async ({ page }) => {
    const fixture = await stage(page, variant);
    const panel = page.locator('#agent-window');
    await expect(panel.locator('.chat-msg.user')).toContainText('pregunta anterior');
    await panel.locator('textarea').fill('mensaje nuevo');
    await panel.locator('textarea').press('Enter');
    await expect(panel).toContainText(variant.label);
    await expect(panel.locator('.chat-msg.user').filter({ hasText: 'mensaje nuevo' })).toHaveCount(1);
    expect(fixture.wire.filter((m) => m.type === 'submit')).toHaveLength(1);
    fixture.addUser('mensaje nuevo');
    await expect(panel.locator('.chat-msg.user').filter({ hasText: 'mensaje nuevo' }))
      .toHaveCount(1, { timeout: 8000 });
    await expect(panel).not.toContainText(variant.label, { timeout: 8000 });
    expect(fixture.wire.filter((m) => m.type === 'submit')).toHaveLength(1);
  });
}

test('unconfirmed does not retry', async ({ page }) => {
  const fixture = await stage(page, { result: 'unconfirmed', reason: 'no_state_change' });
  await page.locator('#agent-window textarea').fill('sin respuesta');
  await page.locator('#agent-window textarea').press('Enter');
  await expect(page.locator('#agent-window')).toContainText('Sin confirmar');
  await page.waitForTimeout(1100);
  expect(fixture.wire.filter((m) => m.type === 'submit')).toHaveLength(1);
});

test('a lost submit is not replayed when the connection returns', async ({ page }) => {
  const fixture = await stage(page, { noResult: true });
  const panel = page.locator('#agent-window');
  await expect.poll(() => fixture.wire.some((m) => m.type === 'attach')).toBe(true);
  await panel.locator('textarea').fill('no repetir');
  await panel.locator('textarea').press('Enter');
  await expect(panel).toContainText('Enviando');
  await fixture.socket().close();
  await expect(panel).toContainText('Sin confirmar');
  await expect.poll(() => fixture.wire.filter((m) => m.type === 'attach').length).toBe(2);
  await expect(panel).not.toContainText('Sin conexión con el agente.');
  expect(fixture.wire.filter((m) => m.type === 'submit')).toHaveLength(1);
});

test('blocked requires the CLI, never submit', async ({ page }) => {
  const fixture = await stage(page);
  await expect.poll(() => fixture.wire.some((m) => m.type === 'attach')).toBe(true);
  fixture.socket().send(JSON.stringify({ type: 'status', status: 'blocked' }));
  const panel = page.locator('#agent-window');
  await expect(panel).toContainText('Esas respuestas no quedan en la crónica');
  await expect(panel.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  await panel.getByRole('button', { name: /Abrir CLI/ }).last().click();
  await expect(page.locator('#terminal-panel')).toBeVisible();
  await expect.poll(() => fixture.wire.filter((m) => m.type === 'attach').length).toBe(2);
  expect(fixture.wire.filter((m) => m.type === 'attach')[1]?.screen).toBeUndefined();
  expect(fixture.wire.filter((m) => m.type === 'submit')).toHaveLength(0);
});

test('a row without herdr retains inline chat', async ({ page }) => {
  await stage(page, { noPane: true });
  await expect(page.locator('.agents-compose-text')).toBeVisible();
  await expect(page.locator('#agent-window')).toBeHidden();
});

test('opening a normal unit restores its composer', async ({ page }) => {
  await stage(page);
  await expect(page.locator('#agent-window')).toBeVisible();
  await page.locator('.agents-own').first().click();
  await page.locator('#main-canvas').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#chat-input')).toBeVisible();
  await expect(page.locator('#agent-window')).toBeHidden();
});
