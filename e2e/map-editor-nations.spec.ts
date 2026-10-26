import { expect, test, type Page } from '@playwright/test';

// The map-edit layer (nations + manual map edits) is validated in two ways:
// - against a small harness, for the panel and toolbar behaviour;
// - against the real app, to prove the surfaces are wired in the product.
//
// The harness keeps the specs fast and independent of the workspace scan; the
// real-app case covers the boot path (onboarding → HUD wiring).

const HARNESS = `
<!doctype html><html><head><link rel="stylesheet" href="/src/styles/index.css"></head>
<body>
  <aside id="side-panel">
    <div id="side-panel-tabs">
      <button class="side-tab" data-tab="nations">Naciones</button>
    </div>
    <div id="side-panel-content">
      <div class="tab-pane active" data-pane="nations"><div id="nations-pane"></div></div>
    </div>
  </aside>
  <script type="module">
    import { renderNationsPanel } from '/src/ui/nationsPanel.ts';
    import { openMapEditor, closeMapEditor } from '/src/ui/mapEditor.ts';
    import { getNationStore } from '/src/nations.ts';

    const city = (id, name) => ({
      id, name, coord: { q: 0, r: 0 }, repoPath: '/workspace/' + id,
      population: 5, territory: [], districts: [], buildings: [], isCapital: false,
      color: [0.3, 0.3, 0.3],
    });
    const world = {
      tiles: new Map(),
      cities: [city('repociv', 'repociv'), city('hermes', 'hermes')],
      units: [], buildings: [],
      resources: { gold: 0, science: 0, production: 0 },
      generatedAt: Date.now(), restAreas: [],
    };
    window.__world = world;
    window.__nations = getNationStore;

    // The editor only calls a handful of renderer methods; a stub keeps the
    // harness free of the canvas/WebGL stack.
    const calls = [];
    window.__editorCalls = calls;
    const stub = {
      setMapEditorMode: (v) => calls.push(['mode', v]),
      setMapEditorTool: (v) => calls.push(['tool', v]),
      setMapEditorTerrain: (v) => calls.push(['terrain', v]),
      setMapEditorNation: (v) => calls.push(['nation', v]),
      setMapEditorRepo: (v) => calls.push(['repo', v]),
    };
    window.__openEditor = () => openMapEditor(stub, world);
    window.__closeEditor = () => closeMapEditor();

    renderNationsPanel(world);
    document.body.dataset.ready = 'true';
  </script>
</body></html>`;

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
    window.localStorage.setItem('repociv:tour-seen:v1', '1');
    sessionStorage.setItem('repociv:hermes-banner-dismissed', '1');
    window.localStorage.setItem('repociv:renderer', 'flat');
  }, selectedRepoPaths);
}

async function bootRepoCiv(page: Page) {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await seedRepoSelection(page);
  await page.goto('/');
  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 20_000 });
  if (await page.locator('#repo-onboarding').isVisible().catch(() => false)) {
    await expect(page.locator('#repo-onboarding-next')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#repo-onboarding-next').click();
    await expect(page.locator('#repo-onboarding-title')).toContainText(/Revisa tu seleccion/);
    await page.locator('#repo-onboarding-next').click();
    await expect(page.locator('#repo-onboarding')).toBeHidden({ timeout: 20_000 });
  }
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', '1', { timeout: 30_000 });
  expect(pageErrors, 'sin errores JS no capturados durante bootstrap').toEqual([]);
}

test.describe('map editor — harness', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('repociv:tour-seen:v1', '1');
      sessionStorage.setItem('repociv:hermes-banner-dismissed', '1');
    });
    await page.route('**/', (route) => route.fulfill({ contentType: 'text/html', body: HARNESS }));
    await page.goto('/');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  });

  test('nations panel creates, renames and assigns a nation', async ({ page }) => {
    await page.getByRole('button', { name: '+ Nueva' }).click();

    const rows = page.locator('.nation-row');
    await expect(rows).toHaveCount(1);

    // Rename → persisted in the store.
    const nameInput = rows.first().locator('.nation-name');
    await nameInput.fill('Liga del Norte');
    await nameInput.blur();
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as never as { __nations: () => { nations: { name: string }[] } }
            ).__nations().nations[0]?.name,
        ),
      )
      .toBe('Liga del Norte');

    // Assign a city → the city carries the nation.
    const citySelect = page.locator('.nation-city-row').first().locator('.nation-city-select');
    await citySelect.selectOption({ label: 'Liga del Norte' });
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as never as { __world: { cities: { nationId?: string }[] } }).__world.cities[0]
              ?.nationId,
        ),
      )
      .toBeTruthy();

    // The store survives a reload: it is the source of truth for the layer.
    const stored = await page.evaluate(() => localStorage.getItem('repociv:nations:v1'));
    expect(stored).toContain('Liga del Norte');
  });

  test('map editor toolbar switches tools and exposes the terrain palette', async ({ page }) => {
    await page.evaluate(() => (window as never as { __openEditor: () => void }).__openEditor());
    const editor = page.locator('#map-editor');
    await expect(editor).toBeVisible();

    const tools = editor.locator('.map-editor-tool');
    await expect(tools).toHaveCount(5);

    await editor.getByRole('button', { name: /Terreno/ }).click();
    await expect(editor.locator('.map-editor-terrain')).toHaveCount(7);

    await editor.getByRole('button', { name: /Nación/ }).click();
    await expect(editor.locator('.map-editor-select')).toHaveCount(1);

    const calls = await page.evaluate(
      () => (window as never as { __editorCalls: unknown[] }).__editorCalls,
    );
    expect(calls).toContainEqual(['tool', 'terrain']);
    expect(calls).toContainEqual(['tool', 'nation']);
  });
});

test.describe('map editor — app real', () => {
  test('la pestaña Naciones y el editor de mapa están cableados en la app', async ({ page }) => {
    await bootRepoCiv(page);

    // The nations tab lives in the real side panel.
    await expect(page.locator('.side-tab[data-tab="nations"]')).toHaveCount(1);

    // Open the side panel and switch to the nations tab.
    await page.evaluate(() => {
      document.getElementById('side-panel')?.classList.remove('hidden');
      document.querySelector<HTMLElement>('.side-tab[data-tab="nations"]')?.click();
    });
    await expect(page.locator('#nations-pane .nations-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#nations-pane #nations-new')).toBeVisible();

    // The map editor opens with K and shows its tools.
    await page.locator('#main-canvas').focus();
    await page.keyboard.press('k');
    await expect(page.locator('#map-editor')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#map-editor .map-editor-tool')).toHaveCount(5);

    // The terrain tool reveals the palette.
    await page.locator('#map-editor').getByRole('button', { name: /Terreno/ }).click();
    await expect(page.locator('#map-editor .map-editor-terrain')).toHaveCount(7);

    // Escape closes the editor again.
    await page.keyboard.press('Escape');
    await expect(page.locator('#map-editor')).toBeHidden();
  });
});
