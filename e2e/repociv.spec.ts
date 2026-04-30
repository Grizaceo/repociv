import { expect, test, type Page } from '@playwright/test';

const bridgeURL = process.env.VITE_BRIDGE_URL ?? `http://127.0.0.1:${process.env.BRIDGE_PORT ?? 5274}`;
const bridgeToken = process.env.VITE_BRIDGE_TOKEN ?? process.env.REPOCIV_TOKEN ?? '';

function bridgeHeaders(): Record<string, string> {
  return bridgeToken ? { 'X-RepoCiv-Token': bridgeToken } : {};
}

async function bootRepoCiv(page: Page) {
  const pageErrors: string[] = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  await page.goto('/');
  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 20_000 });
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

    await expect(page.locator('#bridge-status')).toHaveText(/hermes|openclaw/i);
    await expect(page.locator('#hero-bar-slots .hero-slot[title^="DAVI"]')).toBeVisible();
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

  test('flujo browser → bridge → SSE → UI visible', async ({ page }) => {
    await bootRepoCiv(page);

    const marker = `e2e-${Date.now()}`;
    const response = await page.request.post(`${bridgeURL}/`, {
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      data: { type: 'tile_inspected', cityName: marker },
    });
    expect(response.ok(), await response.text()).toBeTruthy();

    await expect(page.locator('#log-messages')).toContainText(`Inspeccionando: ${marker}`, { timeout: 10_000 });
  });

  test('error de /api/repos queda visible y no deja pantalla vacía', async ({ page }) => {
    await page.route('**/api/repos', route => route.fulfill({ status: 500, body: 'boom' }));
    await bootRepoCiv(page);

    await expect(page.locator('#map-load-error')).toBeVisible();
    await expect(page.locator('#map-load-error')).toContainText(/No pude cargar repos reales|boom/);
    await expect(page.locator('#main-canvas')).toBeVisible();
  });
});
