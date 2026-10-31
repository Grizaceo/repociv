import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ExternalSessionRow } from '../src/externalAgents.ts';

async function stage(page: Page, runtime: 'ready' | 'stopped', finalState = 'ready', approval = false) {
  let posts = 0;
  let body: Record<string, unknown> = {};
  const wire: Record<string, unknown>[] = [];
  const chatRequests: string[] = [];
  let rows: ExternalSessionRow[] = [];
  let ready = false;
  let updateStatus = (_status: string) => {};
  let deferAttach = false;
  let attach = () => {};
  let disconnect = async () => {};
  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    sessionStorage.setItem('repociv:hermes-banner-dismissed', '1');
    localStorage.setItem('repociv:renderer', 'flat');
  });
  await page.route('**/api/herdr/agents', (route) => route.fulfill({
    json: { runtime: { state: runtime, version: '0.9.1', minVersion: '0.9.1' }, agents: [] },
  }));
  await page.route('**/api/external-agents/sessions', (route) => route.fulfill({ json: { sessions: rows } }));
  await page.route(/\/api\/external-agents\/[^/]+\/chat/, (route) => {
    const id = decodeURIComponent(route.request().url().split('/').slice(-2)[0]!);
    chatRequests.push(id);
    return route.fulfill({ json: {
      session: rows.find((row) => row.sessionId === id), available: true, hasMore: false,
      messages: [{ role: 'assistant', text: `crónica ${id}`, at: null, turn: null, truncated: false }],
    } });
  });
  await page.route('**/commands', (route) => {
    posts++;
    body = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ json: { ok: true, status: approval ? 'waiting_approval' : 'queued', commandId: 'launch-fixture' } });
  });
  await page.route('**/api/herdr/launches/launch-fixture', (route) => approval && !ready
    ? route.fulfill({ status: 404, json: { error: 'launch_not_found' } }) : route.fulfill({
    json: ready ? {
      state: finalState, reason: finalState === 'blocked' ? 'agent_not_ready' : null,
      terminalId: 'term_fixture', paneId: 'w1:p1', kind: 'claude', cityId: 'city', name: 'claude-city',
      missionDelivery: finalState === 'ready'
        ? { state: 'confirmed', reason: null } : { state: 'refused', reason: 'agent_not_ready' },
    } : { state: 'starting', terminalId: '', paneId: '' },
  }));
  await page.routeWebSocket(/\/repociv-ws\/terminal/, (socket) => {
    updateStatus = (status) => socket.send(JSON.stringify({ type: 'status', status }));
    disconnect = () => socket.close();
    socket.onMessage((message) => {
      if (typeof message !== 'string') return;
      const data = JSON.parse(message) as Record<string, unknown>;
      wire.push(data);
      if (data['type'] === 'attach') {
        attach = () => socket.send(JSON.stringify({
          type: 'attached', agent: { terminalId: 'term_fixture', paneId: 'w1:p1', agent: 'claude', status: finalState === 'blocked' ? 'blocked' : 'idle', name: 'claude-city', folder: 'city' },
          cols: 120, rows: 40, history: '',
        }));
        if (!deferAttach) attach();
      }
      if (data['type'] === 'submit') socket.send(JSON.stringify({ type: 'submit_result', id: data['id'], state: 'confirmed', reason: null }));
    });
  });
  await page.goto('/');
  await expect(page.locator('#agent-attention-strip')).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('F8');
  await page.locator('#agents-panel').getByRole('button', { name: '+ Sesión' }).click();
  const dialog = page.locator('.agent-session-dialog');
  await dialog.getByLabel('Dónde').selectOption('herdr');
  return {
    dialog, posts: () => posts, body: () => body, wire, chatRequests, finish: () => { ready = true; },
    setRows: (value: ExternalSessionRow[]) => { rows = value; },
    setStatus: (status: string) => updateStatus(status),
    pauseAttach: () => { deferAttach = true; },
    attach: () => attach(),
    disconnect: () => disconnect(),
  };
}

function session(sessionId: string, terminalId: string, activity: number): ExternalSessionRow {
  return {
    sessionId, source: 'suvadu', agent: 'claude', model: 'test', repo: '/fixture/city',
    cityId: '', active: true, state: 'working', unit: null, unitType: 'hero',
    firstActivityAt: activity, lastActivityAt: activity, commandCount: 1, eventCount: 1,
    totalTokens: null, subagent: false, imported: true,
    liveChat: { state: 'unavailable', transport: null, reason: 'fixture' },
    herdrPane: { paneId: 'w1:p1', terminalId, agent: 'claude', status: 'idle', name: '', folder: 'city' },
  };
}

test('stopped herdr prevents a launch', async ({ page }) => {
  const fixture = await stage(page, 'stopped');
  await expect(fixture.dialog).toContainText('herdr no está corriendo.');
  await expect(fixture.dialog.locator('.agent-session-submit')).toBeDisabled();
  expect(fixture.posts()).toBe(0);
});

for (const state of ['ready', 'blocked', 'unknown'] as const) {
  test(`launch ${state} never resubmits the command`, async ({ page }) => {
    const fixture = await stage(page, 'ready', state);
    if (state === 'unknown') fixture.pauseAttach();
    await fixture.dialog.getByLabel('Agente').selectOption('claude');
    await fixture.dialog.getByLabel('Primer mensaje (opcional)').fill('Hola');
    if (process.env.PHASEB_SHOTS && state === 'ready') await fixture.dialog.screenshot({ path: `${process.env.PHASEB_SHOTS}-wizard.png` });
    await fixture.dialog.locator('.agent-session-submit').click();
    const window = page.locator('#side-panel #agent-window');
    await expect(window).toContainText('Abriendo Claude Code en herdr');
    await expect(window.locator('.agent-window-send')).toBeDisabled();
    await expect.poll(async () => {
      const panelBox = (await page.locator('#side-panel').boundingBox())!;
      const noticeBox = (await window.locator('.agent-window-notice').boundingBox())!;
      return noticeBox.x >= panelBox.x && noticeBox.y >= panelBox.y &&
        noticeBox.x + noticeBox.width <= panelBox.x + panelBox.width &&
        noticeBox.y + noticeBox.height <= panelBox.y + panelBox.height;
    }).toBe(true);
    if (process.env.PHASEB_SHOTS && state === 'ready') await page.locator('#side-panel').screenshot({ path: `${process.env.PHASEB_SHOTS}-starting.png` });
    const payload = fixture.body()['payload'] as Record<string, unknown>;
    expect(payload['kind']).toBe('claude');
    expect(payload['city']).toBeTruthy();
    expect(payload).not.toHaveProperty('repoPath');
    expect(payload).not.toHaveProperty('cwd');
    fixture.finish();
    if (state === 'ready') {
      await expect.poll(() => fixture.wire.some((item) => item['type'] === 'attach' && item['terminalId'] === 'term_fixture')).toBe(true);
      await expect(window).toContainText('La crónica aparece cuando el agente registre su sesión');
      await expect(window.locator('.chat-msg.user')).toContainText('Hola');
      fixture.setRows([session('decoy', 'term_other', 1)]);
      await page.waitForTimeout(1500);
      expect(fixture.chatRequests).not.toContain('decoy');
      await window.locator('textarea').fill('Segundo mensaje');
      await window.locator('textarea').press('Enter');
      await expect.poll(() => fixture.wire.some((item) => item['type'] === 'submit' && item['text'] === 'Segundo mensaje')).toBe(true);
      fixture.setRows([session('decoy', 'term_other', 100), session('matching', 'term_fixture', 2)]);
      await expect(window).toContainText('crónica matching', { timeout: 20_000 });
      expect(fixture.chatRequests).not.toContain('decoy');
      fixture.setRows([session('matching', 'term_fixture', 2), session('newer', 'term_fixture', 3)]);
      await expect(window).toContainText('crónica newer', { timeout: 20_000 });
    } else if (state === 'blocked') {
      await expect(window).toContainText('⌨ Abrir CLI');
      await expect(window.locator('textarea')).toHaveValue('Hola');
      if (process.env.PHASEB_SHOTS) await page.locator('#side-panel').screenshot({ path: `${process.env.PHASEB_SHOTS}-blocked.png` });
      await expect.poll(() => fixture.wire.some((item) =>
        item['type'] === 'attach' && item['terminalId'] === 'term_fixture')).toBe(true);
      await expect(window.locator('.agent-window-send')).toBeDisabled();
      fixture.setStatus('idle');
      await expect(window.locator('.agent-window-send')).toBeEnabled();
      await window.locator('.agent-window-send').click();
      await expect.poll(() => fixture.wire.filter((item) => item['type'] === 'submit' && item['text'] === 'Hola').length).toBe(1);
      fixture.pauseAttach();
      await fixture.disconnect();
      await expect(window.locator('.agent-window-send')).toBeDisabled();
    } else {
      await expect(window).toContainText('No se pudo confirmar que el agente arrancó.');
      await expect.poll(() => fixture.wire.some((item) =>
        item['type'] === 'attach' && item['terminalId'] === 'term_fixture')).toBe(true);
      await expect(window.locator('.agent-window-send')).toBeDisabled();
      fixture.attach();
      await expect(window.locator('.agent-window-send')).toBeEnabled();
    }
    await page.waitForTimeout(1100);
    expect(fixture.posts()).toBe(1);
    if (state === 'blocked') expect(fixture.wire.filter((item) => item['type'] === 'submit')).toHaveLength(1);
  });
}

test('waiting for approval does not attach or submit automatically', async ({ page }) => {
  const fixture = await stage(page, 'ready', 'ready', true);
  await fixture.dialog.locator('.agent-session-submit').click();
  const window = page.locator('#side-panel #agent-window');
  await expect(window).toContainText('Esperando aprobación en la cola de RepoCiv.');
  await expect(window.locator('.agent-window-send')).toBeDisabled();
  await page.waitForTimeout(1200);
  expect(fixture.posts()).toBe(1);
  expect(fixture.wire).toHaveLength(0);
  fixture.finish();
  await expect.poll(() => fixture.wire.some((message) => message['type'] === 'attach')).toBe(true);
});
