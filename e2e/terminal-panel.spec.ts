import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import type { ExternalSessionRow } from '../src/externalAgents.ts';

// Real xterm in a real browser against a scripted /terminal socket: no herdr and
// no agent. server/test_terminal_channel.py covers the other end of the wire.

const AGENT = {
  paneId: 'w1:p1',
  terminalId: 'term_a',
  agent: 'claude',
  status: 'working',
  name: '',
  folder: 'repociv',
};

interface Wire {
  sent: { type: string; data?: string; terminalId?: string }[];
  socket(): WebSocketRoute;
  attaches(): number;
  typed(): string[];
}

async function stage(page: Page, onAttach?: (ws: WebSocketRoute) => void): Promise<Wire> {
  const wire: Wire['sent'] = [];
  let current: WebSocketRoute | null = null;
  await page.route('**/api/herdr/agents', (route) =>
    route.fulfill({
      json: { runtime: { state: 'ready', version: '0.9.1', minVersion: '0.9.1' }, agents: [AGENT] },
    }),
  );
  await page.routeWebSocket(/\/repociv-ws\/terminal/, (ws) => {
    current = ws;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Wire['sent'][number];
      wire.push(message);
      if (message.type !== 'attach') return;
      if (onAttach) {
        onAttach(ws);
        return;
      }
      ws.send(
        JSON.stringify({ type: 'attached', agent: AGENT, cols: 80, rows: 24, history: 'linea vieja' }),
      );
      ws.send(Buffer.from('\x1b[2J\x1b[1;1Hpantalla viva'));
    });
  });
  return {
    sent: wire,
    socket: () => current as unknown as WebSocketRoute,
    attaches: () => wire.filter((m) => m.type === 'attach').length,
    typed: () => wire.filter((m) => m.type === 'input').map((m) => m.data ?? ''),
  };
}

/** The app up and ready for hotkeys, with the flat renderer so CI's software GL
 *  does not starve Playwright. */
async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    sessionStorage.setItem('repociv:hermes-banner-dismissed', '1');
    localStorage.setItem('repociv:renderer', 'flat');
  });
  await page.goto('/');
  await expect(page.locator('#agent-attention-strip')).toBeVisible({ timeout: 60_000 });
}

async function openTerminal(page: Page): Promise<void> {
  await boot(page);
  await page.keyboard.press('t');
  await page.locator('.terminal-agent').click();
  await expect(page.locator('.xterm-rows')).toContainText('pantalla viva');
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
}

test('the list leads to the live screen, with history above it', async ({ page }) => {
  await stage(page);
  await openTerminal(page);
  await expect(page.locator('.terminal-title')).toContainText('claude · repociv');
  await expect(page.locator('.terminal-header .terminal-status')).toHaveText('working');
  // In the scrollback, not on the screen the full frame just painted.
  await expect(page.locator('.xterm-rows')).not.toContainText('linea vieja');
});

test('keys go out one by one, and Enter alone', async ({ page }) => {
  const wire = await stage(page);
  await openTerminal(page);
  await page.keyboard.type('hola');
  await page.keyboard.press('Enter');
  await expect.poll(() => wire.typed()).toEqual(['h', 'o', 'l', 'a', '\r']);
});

test('the agent gets Esc and every hotkey letter while the terminal has focus', async ({ page }) => {
  const wire = await stage(page);
  await openTerminal(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  await page.keyboard.press('Control+k');
  await expect.poll(() => wire.typed()).toEqual(['\x1b', 't', '\x0b']);
  await expect(page.locator('#terminal-panel')).toBeVisible();
  await expect(page.locator('#command-palette')).toBeHidden();
});

test('a paste never reaches the PTY as keystrokes', async ({ page }) => {
  const wire = await stage(page);
  await openTerminal(page);
  await page.evaluate(() => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'uno\r\ndos\rtres');
    document
      .querySelector('.xterm-helper-textarea')
      ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => wire.sent.filter((m) => m.type === 'paste')).toEqual([
    { type: 'paste', data: 'uno\ndos\ntres' },
  ]);
  expect(wire.typed()).toEqual([]);
});

test('Shift+Enter is a newline in the prompt, not a submit', async ({ page }) => {
  const wire = await stage(page);
  await openTerminal(page);
  await page.keyboard.press('Shift+Enter');
  await expect.poll(() => wire.typed()).toEqual(['\x1b\r']);
});

test('Shift+Esc hands the keyboard back to the map, and T reopens the same agent', async ({ page }) => {
  const wire = await stage(page);
  await openTerminal(page);
  await page.keyboard.press('Shift+Escape');
  await expect(page.locator('.xterm-helper-textarea')).not.toBeFocused();
  expect(wire.typed()).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#terminal-panel')).toBeHidden();
  await page.keyboard.press('t');
  await expect.poll(() => wire.attaches()).toBe(2);
  await expect(page.locator('.terminal-picker')).toBeHidden();
  await expect(page.locator('.xterm-rows')).toContainText('pantalla viva');
});

test('xterm follows the PTY when it changes size', async ({ page }) => {
  const wire = await stage(page);
  await openTerminal(page);
  await expect(page.locator('.xterm-rows > div')).toHaveCount(24);
  wire.socket().send(JSON.stringify({ type: 'size', cols: 100, rows: 30 }));
  await expect(page.locator('.xterm-rows > div')).toHaveCount(30);
});

test('a dropped link reconnects by itself and repaints', async ({ page }) => {
  const wire = await stage(page);
  await openTerminal(page);
  await wire.socket().close();
  await expect.poll(() => wire.attaches(), { timeout: 5000 }).toBe(2);
  await expect(page.locator('.terminal-notice')).toBeHidden();
  await expect(page.locator('.xterm-rows')).toContainText('pantalla viva');
});

test('a blocked agent shows on the header at once', async ({ page }) => {
  const wire = await stage(page);
  await openTerminal(page);
  wire.socket().send(JSON.stringify({ type: 'status', status: 'blocked' }));
  await expect(page.locator('.terminal-header .terminal-status--blocked')).toHaveText('blocked');
});

test('a closed pane says so and does not retry', async ({ page }) => {
  const wire = await stage(page);
  await openTerminal(page);
  wire.socket().send(JSON.stringify({ type: 'closed', reason: 'pane_not_found' }));
  await expect(page.locator('.terminal-notice')).toContainText('Ese panel ya no existe.');
  await page.waitForTimeout(800);
  expect(wire.attaches()).toBe(1);
});

test('a refusal explains itself', async ({ page }) => {
  await stage(page, (ws) => ws.send(JSON.stringify({ type: 'refused', reason: 'origin_not_allowed' })));
  await boot(page);
  await page.keyboard.press('t');
  await page.locator('.terminal-agent').click();
  await expect(page.locator('.terminal-notice')).toContainText('REPOCIV_TERMINAL_ORIGINS');
});

test('without herdr the panel says what is wrong instead of an empty list', async ({ page }) => {
  await page.route('**/api/herdr/agents', (route) =>
    route.fulfill({ json: { runtime: { state: 'stopped', version: '0.9.1', minVersion: '0.9.1' }, agents: [] } }),
  );
  await boot(page);
  await page.keyboard.press('t');
  await expect(page.locator('.terminal-picker')).toContainText('herdr no está corriendo.');
});

test('an agent in a herdr pane opens its CLI from the agents panel', async ({ page }) => {
  await stage(page);
  const row: ExternalSessionRow = {
    sessionId: 'herdr-fixture',
    source: 'suvadu',
    agent: 'claude',
    model: 'test',
    repo: '/fixture/city',
    cityId: '',
    active: true,
    state: 'working',
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
    herdrPane: AGENT,
  };
  await page.route('**/api/external-agents/sessions', (route) =>
    route.fulfill({ json: { sessions: [row] } }),
  );
  await boot(page);
  await page.keyboard.press('F8');
  await page.locator('.agents-card[data-session="herdr-fixture"]').click();
  await expect(page.locator('#agent-window')).toBeVisible();
  await page.locator('#agent-window').getByRole('button', { name: /Abrir CLI/ }).first().click();
  await expect(page.locator('.xterm-rows')).toContainText('pantalla viva');
});

/** A PTY the size of a maximized herdr window, with the prompt on its last row. */
async function stageWidePty(page: Page, pty: { cols: number; rows: number }): Promise<void> {
  const { cols, rows } = pty;
  await stage(page, (ws) => {
    ws.send(JSON.stringify({ type: 'attached', agent: AGENT, cols, rows, history: '' }));
    ws.send(Buffer.from(`\x1b[2J\x1b[1;1Hprimera fila\x1b[${rows};1H> cuadro de entrada`));
  });
  await page.setViewportSize({ width: 1908, height: 990 });
  await boot(page);
  await page.keyboard.press('t');
  await page.locator('.terminal-agent').click();
  await expect(page.locator('.xterm-rows')).toContainText('cuadro de entrada');
}

const fits = (page: Page) =>
  page.evaluate(() => {
    const view = document.querySelector('.terminal-viewport')!.getBoundingClientRect();
    const screen = document.querySelector('.xterm-screen')!.getBoundingClientRect();
    return { bottom: screen.bottom <= view.bottom + 1, right: screen.right <= view.right + 1 };
  });

test('a maximized herdr window fits: the panel grows to show the whole PTY', async ({ page }) => {
  await stageWidePty(page, { cols: 322, rows: 84 });
  await expect.poll(() => fits(page)).toEqual({ bottom: true, right: true });
});

test('a small PTY after a big one gives the map back', async ({ page }) => {
  const wire = await stage(page);
  await page.setViewportSize({ width: 1908, height: 990 });
  await openTerminal(page);
  const panel = page.locator('#terminal-panel');
  const before = await panel.boundingBox();
  wire.socket().send(JSON.stringify({ type: 'size', cols: 322, rows: 84 }));
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before!.width);
  wire.socket().send(JSON.stringify({ type: 'size', cols: 80, rows: 24 }));
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(before!.width);
});

test('when the PTY cannot fit the window, the prompt stays in view', async ({ page }) => {
  await stageWidePty(page, { cols: 322, rows: 200 });
  await expect.poll(() => page.evaluate(() => {
    const view = document.querySelector('.terminal-viewport')!;
    return view.scrollHeight - view.clientHeight - view.scrollTop;
  })).toBeLessThanOrEqual(1);
  await expect(page.locator('.xterm-rows')).toContainText('cuadro de entrada');
});

test('a ResizeObserver notice does not raise the red error toast', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'ResizeObserver loop completed with undelivered notifications.',
      }),
    );
  });
  await expect(page.locator('#global-error-toast')).toHaveCount(0);
});

test('a real error still raises it', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.dispatchEvent(new ErrorEvent('error', { message: 'something really broke' }));
  });
  await expect(page.locator('#global-error-toast')).toContainText('something really broke');
});
