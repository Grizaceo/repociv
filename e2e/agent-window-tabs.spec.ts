import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalSessionRow } from '../src/externalAgents.ts';

const repoPath = (name: string) => realpathSync(new URL(`../demo-workspace/${name}`, import.meta.url));
const repoId = (p: string) => 'repo:' + Buffer.from(p).toString('base64url');
const TASKFORGE = repoPath('taskforge');

// Fresh dir per off-map test: the server-side selection survives across
// tests in one run, so a reused path would already be a mapped city.
const offRoots: string[] = [];
function freshOffmap(): string {
  const root = mkdtempSync(join(tmpdir(), 'e2e-offmap-'));
  offRoots.push(root);
  const repo = join(root, 'offmap-repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'README.md'), 'off-map repo\n');
  return realpathSync(repo);
}

const agent = { paneId: 'w1:p1', terminalId: 'term_a', agent: 'claude', status: 'idle', name: '', folder: 'taskforge' };

function makeRow(repo: string): ExternalSessionRow {
  return {
    sessionId: 'agent-fixture', source: 'suvadu', agent: 'claude', model: 'test',
    repo, cityId: repoId(realpathSync(repo)), active: true, state: 'working',
    unit: 'ext-fixture', unitType: 'hero',
    firstActivityAt: Date.now(), lastActivityAt: Date.now(),
    commandCount: 1, eventCount: 1, totalTokens: null, subagent: false, imported: true,
    liveChat: { state: 'unavailable', transport: null, reason: 'fixture' }, herdrPane: agent,
  };
}

async function stage(page: Page, row: ExternalSessionRow) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route(/\/api\/external-agents(\?.*)?$/, (r) => r.fulfill({
    json: { agents: [{ unit: 'ext-fixture', unitType: 'hero', cityId: row.cityId, state: 'working' }] },
  }));
  await page.route('**/api/external-agents/sessions', (r) => r.fulfill({ json: { sessions: [row] } }));
  await page.route(/\/api\/external-agents\/[^/]+\/chat/, (r) => r.fulfill({
    json: { session: row, messages: [{ role: 'assistant', text: 'hola', at: null, turn: null, truncated: false }], available: true, hasMore: false },
  }));
  await page.routeWebSocket(/\/repociv-ws\/terminal/, (ws) => {
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw)) as { type: string };
      if (m.type === 'attach') ws.send(JSON.stringify({ type: 'attached', agent, cols: 80, rows: 24, history: '' }));
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    sessionStorage.setItem('repociv:hermes-banner-dismissed', '1');
    localStorage.setItem('repociv:renderer', 'flat');
  });
  await page.goto('/');
  await expect(page.locator('#agent-attention-strip')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#imperial-welcome')).toBeHidden({ timeout: 20_000 }).catch(() => {});
}

/** #btn-agents because the F8 key is inert while the side panel has focus. */
async function openAgentWindow(page: Page) {
  await page.locator('#btn-agents').click();
  await page.locator('.agents-card[data-session="agent-fixture"]').click();
  await expect(page.locator('#agent-window')).toBeVisible();
  await page.locator('#agents-panel .agents-close').click().catch(() => {});
}

async function cityPositions(page: Page): Promise<Array<{ cityId: string; x: number; y: number }>> {
  return page.evaluate(() =>
    (window as unknown as { __repocivDebug: { getMacroCityScreenPositions(): Array<{ cityId: string; x: number; y: number }> } })
      .__repocivDebug.getMacroCityScreenPositions(),
  );
}

function inside(box: { x: number; y: number; width: number; height: number }, parent: { x: number; y: number; width: number; height: number }): boolean {
  return box.x >= parent.x && box.y >= parent.y &&
    box.x + box.width <= parent.x + parent.width &&
    box.y + box.height <= parent.y + parent.height;
}

test('unit tab shows the agent session card, not the previously selected unit', async ({ page }) => {
  await stage(page, makeRow(TASKFORGE));
  // Open the own unit MAIN first (the bug showed its card on the Unidad tab).
  await page.keyboard.press('F8');
  await page.locator('.agents-own[data-unit="MAIN"]').click();
  await page.keyboard.press('Escape');
  await page.locator('#main-canvas').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#side-panel')).toBeVisible();

  await openAgentWindow(page);
  await page.locator('.side-tab[data-tab="unit"]').click();

  const card = page.locator('#agent-unit-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Claude Code');
  await expect(card).toContainText('taskforge');
  await expect(page.locator('#unit-panel')).toBeHidden();
  await expect(page.locator('#btn-move')).toBeHidden();
  const panelBox = (await page.locator('#side-panel').boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(inside(cardBox, panelBox)).toBe(true);
});

test('manuscripts and files tabs follow the agent repo city, not the last city', async ({ page }) => {
  await stage(page, makeRow(TASKFORGE));
  const pos = (await cityPositions(page)).find((c) => c.cityId === 'sentinel-flask');
  if (pos) {
    await page.mouse.click(pos.x, pos.y);
    await page.waitForTimeout(800);
    await page.keyboard.press('Escape');
  }
  const gitRequests: string[] = [];
  const filesRequests: string[] = [];
  await page.route(/\/api\/git\//, (r) => {
    gitRequests.push(r.request().url());
    return r.fulfill({ status: 404, json: {} });
  });
  await page.route(/\/api\/files\//, (r) => {
    filesRequests.push(r.request().url());
    return r.fulfill({ status: 404, json: {} });
  });

  await openAgentWindow(page);

  await page.locator('.side-tab[data-tab="git"]').click();
  const git = page.locator('#git-info');
  await expect(git).toContainText('taskforge');
  expect(gitRequests.some((u) => u.includes('taskforge'))).toBe(true);
  await expect(git).not.toContainText('sentinel-flask');
  const paneBox = (await page.locator('.tab-pane[data-pane="git"]').boundingBox())!;
  const gitBox = (await git.boundingBox())!;
  expect(inside(gitBox, paneBox)).toBe(true);

  await page.locator('.side-tab[data-tab="files"]').click();
  const files = page.locator('#files-info');
  await expect(files).not.toBeEmpty();
  expect(filesRequests.some((u) => u.includes('taskforge'))).toBe(true);
  const filesPaneBox = (await page.locator('.tab-pane[data-pane="files"]').boundingBox())!;
  const filesBox = (await files.boundingBox())!;
  expect(inside(filesBox, filesPaneBox)).toBe(true);
});

test('off-map repo offers both add buttons and the auto button founds the city', async ({ page }) => {
  const OFFMAP = freshOffmap();
  await stage(page, makeRow(OFFMAP));
  await page.route(/\/api\/git\//, (r) => r.fulfill({ status: 404, json: {} }));

  await openAgentWindow(page);

  await page.locator('.side-tab[data-tab="unit"]').click();
  const card = page.locator('#agent-unit-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('fuera del mapa');
  await expect(card).toContainText('offmap-repo');
  const auto = card.getByRole('button', { name: /automático/ });
  const pick = card.getByRole('button', { name: /elegir casilla/ });
  await expect(auto).toBeVisible();
  await expect(pick).toBeVisible();
  const panelBox = (await page.locator('#side-panel').boundingBox())!;
  expect(inside((await auto.boundingBox())!, panelBox)).toBe(true);
  expect(inside((await pick.boundingBox())!, panelBox)).toBe(true);

  await page.locator('.side-tab[data-tab="git"]').click();
  const offer = page.locator('.agent-offmap-offer');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('offmap-repo');
  await expect(page.locator('#git-info')).toContainText('Capital');

  const before = (await cityPositions(page)).length;
  await offer.getByRole('button', { name: /automático/ }).click();
  await expect.poll(async () => (await cityPositions(page)).length).toBe(before + 1);
  // The city-founded refresh drops the offer everywhere it was rendered.
  await page.locator('.side-tab[data-tab="unit"]').click();
  await expect(card).not.toContainText('Agregar al mapa');
  await expect(card).toContainText('offmap-repo');
});

test('off-map repo pick button opens the map editor with the repo selected', async ({ page }) => {
  const OFFMAP = freshOffmap();
  await stage(page, makeRow(OFFMAP));

  await openAgentWindow(page);
  await page.locator('.side-tab[data-tab="unit"]').click();
  await page.locator('#agent-unit-card').getByRole('button', { name: /elegir casilla/ }).click();

  await expect(page.locator('#map-editor')).toBeVisible();
  await expect(page.locator('#map-editor .map-editor-select')).toHaveValue(OFFMAP);
});

test('nations footer is reachable by scrolling the pane', async ({ page }) => {
  await page.addInitScript(() => {
    const nations = Array.from({ length: 14 }, (_, i) => ({
      id: `n${i}`, name: `Nación ${i + 1}`, color: '#4a70b8', createdAt: i,
    }));
    localStorage.setItem('repociv:nations:v1', JSON.stringify({ version: 1, nations, assignments: {} }));
  });
  await stage(page, makeRow(TASKFORGE));

  await openAgentWindow(page);
  await page.locator('.side-tab[data-tab="nations"]').click();
  await page.locator('#nations-pane').evaluate((el) => { el.scrollTop = el.scrollHeight; });

  const footer = page.locator('#nations-footer');
  await expect(footer).toBeVisible();
  // The footer must land inside the tab pane's clipped viewport, not just
  // inside the overflowing #nations-pane box.
  const paneBox = (await page.locator('.tab-pane[data-pane="nations"]').boundingBox())!;
  const footerBox = (await footer.boundingBox())!;
  expect(inside(footerBox, paneBox)).toBe(true);
});

test.afterAll(() => {
  for (const root of offRoots) rmSync(root, { recursive: true, force: true });
});
