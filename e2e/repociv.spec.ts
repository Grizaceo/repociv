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
    // Skip the first-run coachmark tour: its backdrop intercepts pointer
    // events, which every click-driven flow in this spec needs.
    window.localStorage.setItem('repociv:tour-seen:v1', '1');
    // CI has no Hermes harness: the degraded-mode banner is a fixed
    // strip over the top bar that intercepts pointer events (measured in
    // CI run 38674628310). Dismiss it for the session so HUD clicks land.
    sessionStorage.setItem('repociv:hermes-banner-dismissed', '1');
    // Flat macro renderer: these specs drive the chat/HUD panels, and the
    // webgl default only adds SwiftShader load on the CI runner (measured:
    // the page stopped answering keyboard events under that load).
    window.localStorage.setItem('repociv:renderer', 'flat');
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
  // HUD listeners (incl. #btn-agents / #btn-log) are wired after the loading
  // screen hides; wait for the readiness flag so HUD clicks are not silent
  // no-ops.
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', '1', {
    timeout: 30_000,
  });
  expect(pageErrors, 'sin errores JS no capturados durante bootstrap').toEqual([]);
}

test.describe('RepoCiv e2e visual', () => {
  test('carga inicial: mapa, bridge vivo, HUD de recursos y panel de agentes (F8)', async ({ page }) => {
    await bootRepoCiv(page);

    const canvasBox = await page.locator('#main-canvas').boundingBox();
    expect(canvasBox?.width ?? 0).toBeGreaterThan(300);
    expect(canvasBox?.height ?? 0).toBeGreaterThan(200);

    await expect(page.locator('#top-bar')).toBeVisible();
    await expect(page.locator('#res-gold .res-value')).not.toHaveText('');
    await expect(page.locator('#res-science .res-value')).not.toHaveText('');
    await expect(page.locator('#res-production .res-value')).not.toHaveText('');

    // F8 is the single agents view: the panel lists RepoCiv's own units
    // (MAIN is spawned at boot). The old #hero-bar-slots chips are gone.
    await page.locator('#btn-agents').click();
    const agentsPanel = page.locator('#agents-panel');
    await expect(agentsPanel).toBeVisible();
    await expect(agentsPanel.locator('.agents-own').first()).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    await expect(agentsPanel).toBeHidden();

    await expect(page.locator('#bridge-status')).toHaveText(/hermes|openclaw/i, { timeout: 20_000 });
  });

  test('regresiones visuales básicas: toggle 3D disponible y paneles abren', async ({ page }) => {
    await bootRepoCiv(page);

    // The 2D/3D toggle is a first-class control (main.ts un-hides it and the
    // WebGL fallback covers GPU-less machines); the actual flat↔webgl cycle
    // is asserted in render-mode-parity.spec.ts.
    await expect(page.locator('#btn-toggle-3d')).toBeVisible();
    await expect(page.locator('#btn-toggle-3d')).toBeEnabled();

    // The F10 log panel is the current chronicle surface (the old #timeline-panel
    // was replaced by #log-panel; see logPanel.ts). #btn-log is an advanced-tier
    // control, hidden in the default Quick HUD mode — F10 is the canonical path.
    // Focus the canvas first: Chromium swallows F10 while a native <select> has
    // focus (measured — the keydown never reaches the page), and opening the
    // chat leaves #profile-selector focused.
    await page.locator('#main-canvas').focus();
    await page.keyboard.press('F10');
    await expect(page.locator('#log-panel')).toBeVisible();
    await expect(page.locator('#log-panel')).toContainText(/CRÓNICA|Event Timeline/);

    await page.locator('#btn-approvals').click();
    await expect(page.locator('#approval-panel')).toBeVisible();
    await expect(page.locator('#approval-panel')).toContainText(/APROBACIONES|No hay aprobaciones|Aprobar/);
  });

  test('flujo bridge: comando seguro produce mission_start, chat_chunk y mission_complete visibles', async ({ page }) => {
    await bootRepoCiv(page);

    // Open the chat through the canonical F8 flow; the row carries the unit
    // id that the bridge command targets.
    await page.locator('#btn-agents').click();
    const agentsPanel = page.locator('#agents-panel');
    await expect(agentsPanel).toBeVisible();
    const own = agentsPanel.locator('.agents-own').first();
    await expect(own).toBeVisible({ timeout: 20_000 });
    const heroUnitId = (await own.getAttribute('data-unit')) ?? '';
    expect(heroUnitId).not.toBe('');
    await own.click();
    await page.keyboard.press('Escape');
    await expect(agentsPanel).toBeHidden();
    await page.locator('#main-canvas').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#side-panel')).toBeVisible();

    const marker = `e2e-${Date.now()}`;
    const response = await page.request.post(`${bridgeURL}/commands`, {
      headers: { 'Content-Type': 'application/json', ...bridgeHeaders() },
      data: {
        type: 'e2e_probe',
        target: 'repociv-e2e',
        payload: { unit: heroUnitId, marker },
        created_by: 'playwright',
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const command = await response.json() as { status: string; commandId: string };
    expect(command.status).toBe('queued');

    // F10 is the canonical path to the chronicle (#btn-log is advanced-tier).
    // Canvas focus first: Chromium swallows F10 while a native <select> has
    // focus, and the chat leaves #profile-selector focused.
    await page.locator('#main-canvas').focus();
    await page.keyboard.press('F10');
    await expect(page.locator('#log-panel')).toBeVisible();
    await expect(page.locator('#log-messages')).toContainText(`E2E probe completado: ${marker}`, { timeout: 10_000 });
    await expect(page.locator('#log-panel')).toContainText('CommandCompleted', { timeout: 10_000 });
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
