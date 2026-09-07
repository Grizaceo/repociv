// E2E for the chat profile selector (profileSelector.ts).
// The profile registry endpoint is network-mocked so the selector renders a
// deterministic list even when this dev bridge has no profiles configured.
// The chat is opened with the initial unit (same flow as chat-model-picker).
// NOTE: the automatic profile↔config match is covered by the unit test
// (profileSelector.test.ts); here we cover the integration: render, apply,
// and manual-change deselection.
import { expect, test, type Page } from '@playwright/test';

// The full boot (repos + map + bridge) plus opening the chat takes longer
// than Playwright's 30s default on this machine.
test.setTimeout(90_000);

const MOCK_PROFILES = {
  profiles: {
    davi: {
      harness: 'hermes',
      provider: 'ollama-cloud',
      model: 'deepseek-v4-flash',
      display_name: 'DAVI',
      slot_order: 0,
    },
    lexo: {
      harness: 'claude',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      display_name: 'LEXO',
      slot_order: 1,
    },
  },
};

// Same synthetic provider universe as chat-model-picker.spec.ts so the
// harness/provider/model dropdowns render a deterministic list.
const MOCK_PROVIDERS = {
  defaultHarness: 'hermes',
  defaultProvider: 'openai-api',
  hermesParity: true,
  harnesses: [
    { id: 'hermes', name: 'Hermes', transport: 'hermes', available: true },
    { id: 'claude-code', name: 'Claude Code', transport: 'cli', available: true },
    { id: 'codex', name: 'Codex', transport: 'cli', available: true },
    { id: 'cursor', name: 'Cursor', transport: 'cli', available: false },
  ],
  providers: [
    {
      id: 'openai-api', name: 'OpenAI', available: true, defaultModel: 'gpt-4o',
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', harnesses: ['hermes', 'claude-code'], reachable: true },
        { id: 'gpt-4o-mini', name: 'GPT-4o mini', harnesses: ['hermes', 'claude-code'], reachable: true },
        { id: 'o1', name: 'o1', harnesses: ['hermes', 'claude-code'], reachable: false },
      ],
    },
    {
      id: 'anthropic', name: 'Anthropic', available: true, defaultModel: 'claude-opus-4-8',
      models: [
        { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', harnesses: ['hermes', 'claude-code'], reachable: true },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', harnesses: ['hermes', 'claude-code'], reachable: true },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', harnesses: ['hermes', 'claude-code'], reachable: true },
      ],
    },
    {
      id: 'ollama-cloud', name: 'Ollama Cloud', available: true, defaultModel: 'deepseek-v4-pro',
      models: [
        { id: 'deepseek-v4-pro', name: 'DeepSeek v4 Pro', harnesses: ['hermes'], reachable: true },
        { id: 'deepseek-v4-flash', name: 'DeepSeek v4 Flash', harnesses: ['hermes'], reachable: true },
        { id: 'qwen-3', name: 'Qwen 3', harnesses: ['hermes'], reachable: false },
      ],
    },
    {
      id: 'xai', name: 'xAI', available: false, defaultModel: 'grok-3',
      models: [{ id: 'grok-3', name: 'Grok 3', harnesses: ['hermes'], reachable: false }],
    },
  ],
};

const MOCK_LIVE = {
  providers: MOCK_PROVIDERS.providers.map((p) => ({
    id: p.id,
    models: p.models.map((m) => ({ id: m.id, reachable: m.reachable })),
  })),
};

async function mockProviders(page: Page) {
  await page.route('**/providers/live', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(MOCK_LIVE) }),
  );
  await page.route('**/providers', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(MOCK_PROVIDERS) }),
  );
}

async function mockProfiles(page: Page) {
  await page.route('**/api/profiles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(MOCK_PROFILES) }),
  );
  // Native harness profiles (hermes → ~/.hermes/profiles/*). Deterministic
  // list so the "Perfiles nativos" section renders a fixed set.
  await page.route('**/api/harness-profiles?*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ profiles: ['main', 'lexo-alpha'], harness: 'hermes' }),
    }),
  );
}

async function seedRepoSelection(page: Page) {
  const response = await page.request.get('/api/repos');
  expect(response.ok(), await response.text()).toBeTruthy();
  const repos = (await response.json()) as Array<{ path?: string }>;
  const paths = repos
    .map((r) => r.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .slice(0, 12);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((p) => {
    window.localStorage.setItem(
      'repociv:selected-repos:v1',
      JSON.stringify({ version: 1, selectedRepoPaths: p, filters: { owners: [], topics: [], languages: [] } }),
    );
    // Skip the first-run coachmark tour: its backdrop intercepts pointer
    // events on the canvas, which the chat-opening flow needs.
    window.localStorage.setItem('repociv:tour-seen:v1', '1');
  }, paths);
}

async function boot(page: Page) {
  await mockProviders(page);
  await mockProfiles(page);
  await seedRepoSelection(page);
  await page.goto('/');
  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 20_000 });
  if (await page.locator('#repo-onboarding').isVisible().catch(() => false)) {
    await page.locator('#repo-onboarding-next').click();
    await page.locator('#repo-onboarding-next').click();
    await expect(page.locator('#repo-onboarding')).toBeHidden({ timeout: 20_000 });
  }
  await expect(page.locator('#main-canvas')).toBeVisible();
}

/** Open the chat with the first non-profile hero slot (the initial unit).
 *  Profile slots only select a profile; they do not open the chat, so they
 *  are excluded. The click is dispatched via evaluate: Playwright's own
 *  scroll-into-view hangs on the command-bar layout once the profile strip
 *  is injected, while a direct DOM click works reliably. */
async function openChat(page: Page) {
  const slot = page.locator('#hero-bar-slots .hero-chip').first();
  await expect(slot).toBeVisible({ timeout: 20_000 });
  // force:true skips Playwright's scroll-into-view (which hangs on the
  // command-bar layout once the profile strip is injected). The slot click
  // selects the unit; Enter (handled by the canvas hotkey) opens the chat.
  await slot.click({ force: true });
  // Focus the canvas (the Enter hotkey lives there) without clicking: a
  // click could select a different city/unit.
  await page.locator('#main-canvas').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#side-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#chat-input')).toBeVisible();
}

test('profile selector: aparece en el header del chat con la etiqueta y perfiles filtrados por harness', async ({
  page,
}) => {
  await boot(page);
  await openChat(page);

  const sel = page.locator('#profile-selector');
  await expect(sel).toBeVisible();
  // La etiqueta dice "PERFIL" — el select se entiende como selector de perfiles.
  await expect(page.locator('.profile-selector-label')).toHaveText('PERFIL');
  // Con harness hermes activo: manual + DAVI (hermes) + separador + 2 nativos.
  // LEXO (claude) NO aparece hasta que el harness del panel sea claude.
  await expect(sel.locator('option[value="davi"]')).toHaveCount(1);
  await expect(sel.locator('option[value="lexo"]')).toHaveCount(0);
  await expect(sel.locator('option[value="~/.hermes/profiles/main"]')).toHaveCount(1);
  await expect(sel.locator('option[value="~/.hermes/profiles/lexo-alpha"]')).toHaveCount(1);
  await page.locator('#side-panel').screenshot({ path: 'e2e/_shots/profile-selector.png' });
});

test('profile selector: cambiar el harness del panel filtra los perfiles disponibles', async ({
  page,
}) => {
  await boot(page);
  await openChat(page);

  const sel = page.locator('#profile-selector');
  await expect(sel).toBeVisible();
  // Hermes activo → solo DAVI.
  await expect(sel.locator('option[value="davi"]')).toHaveCount(1);
  await expect(sel.locator('option[value="lexo"]')).toHaveCount(0);

  // Cambiar el harness del panel a claude-code → ahora LEXO (claude) aparece
  // y DAVI (hermes) desaparece.
  await page.locator('#harness-selector').selectOption('claude-code');
  await expect(sel.locator('option[value="davi"]')).toHaveCount(0);
  await expect(sel.locator('option[value="lexo"]')).toHaveCount(1);
});

test('profile selector: elegir un perfil aplica harness/provider/model al chat activo', async ({
  page,
}) => {
  await boot(page);
  await openChat(page);

  // LEXO es de harness claude: primero hay que estar en claude-code para que
  // aparezca en el filtro (el perfil por sí solo también aplica el harness).
  await page.locator('#harness-selector').selectOption('claude-code');
  await page.locator('#profile-selector').selectOption('lexo');
  await expect(page.locator('#harness-selector')).toHaveValue('claude-code');
  await expect(page.locator('#provider-selector')).toHaveValue('anthropic');
  await expect(page.locator('#model-selector')).toHaveValue('claude-sonnet-4-6');
  // El chip activo refleja el modelo del perfil.
  await expect(page.locator('.chat-agent-chip.active .chip-model')).toContainText(
    'claude-sonnet-4-6',
  );
  // El selector sigue mostrando el perfil aplicado (match exacto).
  await expect(page.locator('#profile-selector')).toHaveValue('lexo');
});

test('profile selector: elegir un perfil nativo de hermes aplica harness hermes + profile', async ({
  page,
}) => {
  await boot(page);
  await openChat(page);

  const sel = page.locator('#profile-selector');
  await expect(sel).toBeVisible();

  // Elegir un perfil nativo (sección "Perfiles nativos").
  await sel.selectOption('~/.hermes/profiles/lexo-alpha');
  // Aplica harness hermes (el perfil nativo corre con hermes-cli).
  await expect(page.locator('#harness-selector')).toHaveValue('hermes');
  // El selector sigue mostrando el perfil nativo elegido.
  await expect(sel).toHaveValue('~/.hermes/profiles/lexo-alpha');
});

test('profile selector: cambiar la config manualmente deselecciona el perfil', async ({
  page,
}) => {
  await boot(page);
  await openChat(page);

  await page.locator('#harness-selector').selectOption('claude-code');
  await page.locator('#profile-selector').selectOption('lexo');
  await expect(page.locator('#harness-selector')).toHaveValue('claude-code');

  // El usuario cambia el harness a mano → la config ya no coincide con LEXO
  // → el selector de perfil vuelve a "— (config manual)".
  await page.locator('#harness-selector').selectOption('hermes');
  await expect(page.locator('#profile-selector')).toHaveValue('');
});
