import { expect, test, type Page } from '@playwright/test';
import { syncServerRepoSelection } from './helpers/repo-selection.ts';

const bridgeURL =
  process.env.VITE_BRIDGE_URL ?? `http://127.0.0.1:${process.env.BRIDGE_PORT ?? 5274}`;
const bridgeToken = process.env.VITE_BRIDGE_TOKEN ?? process.env.REPOCIV_TOKEN ?? '';

function bridgeHeaders(): Record<string, string> {
  return bridgeToken ? { 'X-RepoCiv-Token': bridgeToken } : {};
}

async function seedRepoSelection(page: Page) {
  const response = await page.request.get('/api/repos');
  expect(response.ok(), await response.text()).toBeTruthy();
  const repos = (await response.json()) as Array<{ repoPath?: string }>;
  const selectedRepoPaths = repos
    .map((repo) => repo.repoPath)
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
    .slice(0, 12);
  expect(
    selectedRepoPaths.length,
    'expected /api/repos to return selectable repos',
  ).toBeGreaterThan(0);
  await syncServerRepoSelection(page, selectedRepoPaths);
  await page.addInitScript((paths) => {
    window.localStorage.setItem('repociv:tour-seen:v1', '1');
    window.localStorage.setItem('repociv:renderer', 'flat');
    window.localStorage.setItem(
      'repociv:selected-repos:v1',
      JSON.stringify({
        version: 1,
        selectedRepoPaths: paths,
        filters: { owners: [], topics: [], languages: [] },
      }),
    );
  }, selectedRepoPaths);
}

async function bootRepoCiv(page: Page, options: { seedSelection?: boolean } = {}) {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  if (options.seedSelection !== false) await seedRepoSelection(page);

  await page.goto('/');
  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('html[data-app-ready="1"]')).toBeAttached({ timeout: 20_000 });
  if (
    await page
      .locator('#repo-onboarding')
      .isVisible()
      .catch(() => false)
  ) {
    await expect(page.locator('#repo-onboarding-next')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#repo-onboarding-next').click();
    await expect(page.locator('#repo-onboarding-title')).toContainText(/Revisa tu seleccion/);
    await expect(page.locator('#repo-onboarding-next')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#repo-onboarding-next').click();
    await expect(page.locator('#repo-onboarding')).toBeHidden({ timeout: 20_000 });
  }
  await expect(page.locator('#main-canvas')).toBeVisible();
  expect(pageErrors, 'sin errores JS no capturados durante bootstrap').toEqual([]);
}

test.describe('RepoCiv e2e visual', () => {
  test('carga inicial: mapa, bridge vivo, HUD de recursos y MAIN', async ({ page }) => {
    const wsAuthErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('[ws] auth failed')) {
        wsAuthErrors.push(message.text());
      }
    });
    await bootRepoCiv(page);

    const canvasBox = await page.locator('#main-canvas').boundingBox();
    expect(canvasBox?.width ?? 0).toBeGreaterThan(300);
    expect(canvasBox?.height ?? 0).toBeGreaterThan(200);

    await expect(page.locator('#top-bar')).toBeVisible();
    await expect(page.locator('#res-gold .res-value')).not.toHaveText('');
    await expect(page.locator('#res-science .res-value')).not.toHaveText('');
    await expect(page.locator('#res-production .res-value')).not.toHaveText('');

    await expect(page.locator('#hero-bar-slots .hero-slot[title^="Main"]')).toBeVisible();
    await expect(page.locator('#bridge-status')).toHaveText(/hermes|openclaw/i, {
      timeout: 20_000,
    });
    await page.waitForTimeout(5_500);
    expect(wsAuthErrors, 'WebSocket debe autenticar con VITE_BRIDGE_TOKEN').toEqual([]);
  });

  test('regresiones visuales básicas: sin toggle 3D roto y paneles abren', async ({ page }) => {
    await bootRepoCiv(page);

    await expect(page.locator('#btn-toggle-3d')).toBeVisible();
    await expect(page.locator('#btn-toggle-3d')).toBeEnabled();

    await page.locator('#btn-timeline').click();
    await expect(page.locator('#timeline-panel')).toBeVisible();
    await expect(page.locator('#timeline-panel')).toContainText(/TAREAS — ESTADO Y EVIDENCIA/);

    await page.locator('#btn-approvals').click();
    await expect(page.locator('#approval-panel')).toBeVisible();
    await expect(page.locator('#approval-panel')).toContainText(
      /APROBACIONES|No hay aprobaciones|Aprobar/,
    );
  });

  test('mobile 390px: sin overflow de documento y bottom sheet usable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await bootRepoCiv(page);

    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
      .toBeLessThanOrEqual(0);
    await expect(page.locator('#hud-right')).toBeHidden();
    await expect(page.locator('#command-bar')).toBeVisible();

    const primaryTarget = await page.locator('#spawn-new-profile').boundingBox();
    expect(primaryTarget).not.toBeNull();
    expect(primaryTarget?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(primaryTarget?.height ?? 0).toBeGreaterThanOrEqual(44);

    const bannerClose = page.getByRole('button', { name: 'Cerrar banner' });
    if (await bannerClose.isVisible()) await bannerClose.click();

    const hudMode = page.locator('#btn-hud-mode');
    await hudMode.scrollIntoViewIfNeeded();
    await expect(hudMode).toBeInViewport();
    await hudMode.click();
    await expect(hudMode).toHaveAttribute('aria-pressed', 'true');
    await hudMode.click();
    await expect(hudMode).toHaveAttribute('aria-pressed', 'false');

    const themeToggle = page.locator('#btn-theme-toggle');
    await themeToggle.scrollIntoViewIfNeeded();
    await expect(themeToggle).toBeInViewport();

    const lastSpawn = page.locator('.hero-bar-spawn .spawn-btn[data-type="CODEX"]');
    await lastSpawn.scrollIntoViewIfNeeded();
    await expect(lastSpawn).toBeInViewport();
    await expect(lastSpawn).toBeEnabled();
  });

  test('flujo bridge: comando seguro produce evidencia y CommandCompleted visibles', async ({
    page,
  }) => {
    await bootRepoCiv(page);

    await page.locator('#hero-bar-slots .hero-slot[title^="Main"]').click();
    await page.keyboard.press('Enter');
    await expect(page.locator('#side-panel')).toBeVisible();

    const marker = `e2e-${Date.now()}`;
    const response = await page.request.post(`${bridgeURL}/commands`, {
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      data: {
        type: 'e2e_probe',
        target: 'repociv-e2e',
        payload: { unit: 'MAIN', marker },
        created_by: 'playwright',
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const command = (await response.json()) as { status: string; commandId: string };
    expect(command.status).toBe('queued');

    await expect
      .poll(async () => {
        const artifacts = await page.request.get(
          `${bridgeURL}/commands/${command.commandId}/artifacts`,
          { headers: bridgeHeaders() },
        );
        if (!artifacts.ok()) return '';
        const body = (await artifacts.json()) as { terminalEvent?: { type?: string } };
        return body.terminalEvent?.type ?? '';
      })
      .toBe('CommandCompleted');

    await page.locator('#side-panel-close').click();
    await expect(page.locator('#side-panel')).toBeHidden();
    await page.locator('#btn-timeline').click();
    await expect(page.locator('#timeline-panel')).toBeVisible();
    const commandRow = page.locator(`.tl-entry[data-cmd="${command.commandId}"]`);
    await expect(commandRow).toBeVisible();
    await expect(commandRow.locator('.tl-type')).toHaveText('Completed');
  });

  test('error de /api/repos queda visible y no deja pantalla vacía', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('repociv:tour-seen:v1', '1');
      window.localStorage.setItem('repociv:renderer', 'flat');
      window.localStorage.setItem(
        'repociv:selected-repos:v1',
        JSON.stringify({
          version: 1,
          selectedRepoPaths: ['/e2e/preselected-repo'],
          filters: { owners: [], topics: [], languages: [] },
        }),
      );
    });
    await page.route('**/api/repos', (route) => route.fulfill({ status: 500, body: 'boom' }));
    await bootRepoCiv(page, { seedSelection: false });

    await expect(page.locator('#map-load-error')).toBeVisible();
    await expect(page.locator('#map-load-error')).toContainText(/No pude cargar repos reales|boom/);
    await expect(page.locator('#main-canvas')).toBeVisible();
  });
});
