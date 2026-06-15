// E2E for the in-chat harness/provider/model picker (slashPicker.ts).
// Provider endpoints are network-mocked (mockProviders) so the picker
// renders a deterministic list even when this dev bridge has no API keys.
// Screenshots land in e2e/_shots/ (gitignored) for PR review.
import { expect, test, type Page } from '@playwright/test';

// Synthetic provider universe so the picker renders a populated list even when
// this dev bridge has no API keys configured (the real client code consumes
// these exactly as it would the live bridge response).
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
  }, paths);
}

async function boot(page: Page) {
  await mockProviders(page);
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

async function openChat(page: Page) {
  const slot = page.locator('#hero-bar-slots .hero-slot').first();
  await expect(slot).toBeVisible({ timeout: 20_000 });
  await slot.scrollIntoViewIfNeeded();
  await slot.click({ force: true });
  await page.keyboard.press('Enter');
  if (!(await page.locator('#side-panel').isVisible().catch(() => false))) {
    await slot.click({ force: true });
    await page.keyboard.press('Enter');
  }
  await expect(page.locator('#side-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#chat-input')).toBeVisible();
}

async function openModelPicker(page: Page) {
  await page.locator('#chat-input').fill('/model');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('.slash-picker')).toBeVisible({ timeout: 5_000 });
}

test('/model picker: abre, filtra y aísla Esc del panel', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await openModelPicker(page);

  // 8 modelos de providers disponibles (xai se omite por no-configurado).
  await expect(page.locator('.slash-picker-item')).toHaveCount(8);
  await page.locator('#side-panel').screenshot({ path: 'e2e/_shots/picker-model.png' });

  // Type-ahead: "g" reduce a los dos modelos GPT.
  await page.locator('.slash-picker-filter').fill('g');
  await expect(page.locator('.slash-picker-item')).toHaveCount(2);
  await page.locator('#side-panel').screenshot({ path: 'e2e/_shots/picker-model-filtered.png' });

  // Esc cierra el picker pero NO el panel lateral (no debe filtrarse al
  // handler global de Esc que cierra el side panel).
  await page.locator('.slash-picker-filter').press('Escape');
  await expect(page.locator('.slash-picker')).toBeHidden();
  await expect(page.locator('#side-panel')).toBeVisible();
});

test('/model picker: aísla el teclado global (Tab fija foco; Esc y hotkeys no escapan)', async ({
  page,
}) => {
  await boot(page);
  await openChat(page);
  await openModelPicker(page);

  // Tab no saca el foco del picker: queda fijo en el input de filtro (no salta
  // a una fila <button> ni escapa el modal).
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain(
    'slash-picker-filter',
  );

  // Fuerza el foco a una fila <button> — el vector exacto del bug original: con
  // el keydown sólo en el input, las teclas se filtraban al handler global.
  await page.locator('.slash-picker-item').first().evaluate((el) => (el as HTMLElement).focus());

  // 'h' (hotkey global → panel de Capas) NO debe abrir nada: el handler global
  // se cortocircuita mientras el picker está abierto (isPickerOpen).
  await page.keyboard.press('h');
  await expect(page.locator('#layer-panel')).toBeHidden();
  await expect(page.locator('.slash-picker')).toBeVisible();

  // Esc cierra sólo el picker, no el panel lateral — aun con foco en la fila.
  await page.keyboard.press('Escape');
  await expect(page.locator('.slash-picker')).toBeHidden();
  await expect(page.locator('#side-panel')).toBeVisible();
});

test('/model picker: number-pick aplica y confirma', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await openModelPicker(page);

  // Con el filtro vacío, el dígito 2 elige la 2ª fila (GPT-4o mini) en un gesto.
  await page.locator('.slash-picker-filter').press('2');
  await expect(page.locator('.slash-picker')).toBeHidden();
  await expect(page.locator('#chat-messages')).toContainText('Modelo →');
  await expect(page.locator('#chat-messages')).toContainText('gpt-4o-mini');
  // El dropdown DOM quedó en sync con la elección por slash.
  await expect(page.locator('#model-selector')).toHaveValue('gpt-4o-mini');
  // El chip activo muestra el modelo elegido en su línea (R3).
  await expect(page.locator('.chat-agent-chip.active .chip-model')).toContainText('gpt-4o-mini');
  await page.locator('#chat-agent-selector-row').screenshot({ path: 'e2e/_shots/chip-model-line.png' });
});

test('/model picker: el harness filtra los providers compatibles (R2)', async ({ page }) => {
  await boot(page);
  await openChat(page);

  // Con hermes (default) todos los providers compatibles → 8 modelos.
  await openModelPicker(page);
  await expect(page.locator('.slash-picker-item')).toHaveCount(8);
  await page.keyboard.press('Escape');

  // Cambia a claude-code: ollama-cloud no declara ese harness, así que sus
  // modelos desaparecen del picker (quedan OpenAI + Anthropic = 6).
  await page.locator('#chat-input').fill('/harness claude-code');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('#chat-messages')).toContainText('Harness →');

  await openModelPicker(page);
  await expect(page.locator('.slash-picker-item')).toHaveCount(6);
});

test('/harness picker: marca el harness activo', async ({ page }) => {
  await boot(page);
  await openChat(page);
  await page.locator('#chat-input').fill('/harness');
  await page.locator('#chat-input').press('Enter');
  await expect(page.locator('.slash-picker')).toBeVisible({ timeout: 5_000 });
  // El harness activo (hermes, por defaultHarness) aparece marcado.
  await expect(page.locator('.slash-picker-item.current')).toContainText('Hermes');
  await page.locator('#side-panel').screenshot({ path: 'e2e/_shots/picker-harness.png' });
});
