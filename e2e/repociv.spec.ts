import { expect, test, type Page } from '@playwright/test';

const bridgeURL = process.env.VITE_BRIDGE_URL ?? `http://127.0.0.1:${process.env.BRIDGE_PORT ?? 5274}`;
const bridgeToken = process.env.VITE_BRIDGE_TOKEN ?? process.env.REPOCIV_TOKEN ?? '';

function bridgeHeaders(): Record<string, string> {
  return bridgeToken ? { 'X-RepoCiv-Token': bridgeToken } : {};
}

async function seedRepoSelection(page: Page) {
  const response = await page.request.get('/api/repos');
  expect(response.ok(), await response.text()).toBeTruthy();
  const repos = (await response.json()) as Array<{ path?: string }>;
  const selectedRepoPaths = repos
    .map((repo) => repo.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
    .slice(0, 12);
  expect(selectedRepoPaths.length, 'expected /api/repos to return selectable repos').toBeGreaterThan(0);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((paths) => {
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
  page.on('pageerror', err => pageErrors.push(err.message));

  if (options.seedSelection !== false) await seedRepoSelection(page);

  await page.goto('/');
  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 20_000 });
  if (await page.locator('#repo-onboarding').isVisible().catch(() => false)) {
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
  test('carga inicial: mapa, bridge vivo, HUD de recursos y DAVI', async ({ page }) => {
    await bootRepoCiv(page);

    const canvasBox = await page.locator('#main-canvas').boundingBox();
    expect(canvasBox?.width ?? 0).toBeGreaterThan(300);
    expect(canvasBox?.height ?? 0).toBeGreaterThan(200);

    await expect(page.locator('#top-bar')).toBeVisible();
    await expect(page.locator('#res-gold .res-value')).not.toHaveText('');
    await expect(page.locator('#res-science .res-value')).not.toHaveText('');
    await expect(page.locator('#res-production .res-value')).not.toHaveText('');

    await expect(page.locator('#hero-bar-slots .hero-slot[title^="DAVI"]')).toBeVisible();
    await expect(page.locator('#bridge-status')).toHaveText(/hermes|openclaw/i, { timeout: 20_000 });
  });

  test('regresiones visuales básicas: sin toggle 3D roto y paneles abren', async ({ page }) => {
    await bootRepoCiv(page);

    await expect(page.locator('#btn-toggle-3d')).toBeHidden();

    await page.locator('#btn-timeline').click();
    await expect(page.locator('#timeline-panel')).toBeVisible();
    await expect(page.locator('#timeline-panel')).toContainText(/CRÓNICA|Event Timeline/);

    await page.locator('#btn-approvals').click();
    await expect(page.locator('#approval-panel')).toBeVisible();
    await expect(page.locator('#approval-panel')).toContainText(/APROBACIONES|No hay aprobaciones|Aprobar/);
  });

  test('flujo bridge: comando seguro produce mission_start, chat_chunk y mission_complete visibles', async ({ page }) => {
    await bootRepoCiv(page);

    await page.locator('#hero-bar-slots .hero-slot[title^="DAVI"]').click();
    await page.keyboard.press('Enter');
    await expect(page.locator('#side-panel')).toBeVisible();

    const marker = `e2e-${Date.now()}`;
    const response = await page.request.post(`${bridgeURL}/commands`, {
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      data: {
        type: 'e2e_probe',
        target: 'repociv-e2e',
        payload: { unit: 'DAVI', marker },
        created_by: 'playwright',
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const command = await response.json() as { status: string; commandId: string };
    expect(command.status).toBe('queued');

    await page.locator('#btn-timeline').click();
    await expect(page.locator('#timeline-panel')).toBeVisible();
    await expect(page.locator('#log-messages')).toContainText(`E2E probe completado: ${marker}`, { timeout: 10_000 });
    await expect(page.locator('#timeline-panel')).toContainText('Command Completed', { timeout: 10_000 });
  });

  test('error de /api/repos queda visible y no deja pantalla vacía', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      window.localStorage.setItem(
        'repociv:selected-repos:v1',
        JSON.stringify({
          version: 1,
          selectedRepoPaths: ['/e2e/preselected-repo'],
          filters: { owners: [], topics: [], languages: [] },
        }),
      );
    });
    await page.route('**/api/repos', route => route.fulfill({ status: 500, body: 'boom' }));
    await bootRepoCiv(page, { seedSelection: false });

    await expect(page.locator('#map-load-error')).toBeVisible();
    await expect(page.locator('#map-load-error')).toContainText(/No pude cargar repos reales|boom/);
    await expect(page.locator('#main-canvas')).toBeVisible();
  });
});
