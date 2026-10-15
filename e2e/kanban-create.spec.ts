import { expect, test } from '@playwright/test';

// UI transport tests are intercepted: persistence is tested with the actual CLI
// in server/test_kanban_writer.py, never by writing a throwaway user board.
test('manual project board: errors preserve draft, success selects shared board', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    // Flat macro renderer (the old 'repociv:world-render-mode' key is dead).
    // This spec drives the Kanban iframe; the webgl default only adds
    // SwiftShader load on the CI runner.
    localStorage.setItem('repociv:renderer', 'flat');
  });
  let created = false;
  let posts = 0;
  const board = {
    slug: 'project-fixture',
    name: 'Project fixture',
    available: true,
    active: false,
    columns: { todo: [], done: [] },
  };
  await page.route('**/api/kanban/boards', async (route) => {
    if (route.request().method() === 'POST') {
      posts++;
      expect(route.request().postDataJSON()).toEqual({
        slug: 'project-fixture',
        name: 'Project fixture',
        project_path: '/home/user/project with spaces',
      });
      if (posts === 1) return route.fulfill({ status: 409, json: { error: 'Ese ID ya existe.' } });
      created = true;
      return route.fulfill({ status: 201, json: { board } });
    }
    return route.fulfill({ json: { boards: created ? [{ ...board, counts: {} }] : [] } });
  });
  await page.route(/\/api\/kanban(?:\?.*)?$/, (route) =>
    route.fulfill({ json: created ? board : { ...board, available: false } }),
  );
  // Load the actual panel module/styles in a small harness: do not boot the
  // user's entire repository map (or start agents) to test a board form.
  await page.route('**/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `
    <!doctype html><html><head><link rel="stylesheet" href="/src/styles/index.css"></head>
    <body><button id="open">Kanban de Hermes</button><script type="module">
      import { openKanbanPanel } from '/src/ui/kanbanPanel.ts';
      document.querySelector('#open').onclick = openKanbanPanel;
      document.querySelector('#open').dataset.ready = 'true';
    </script></body></html>`,
    }),
  );
  await page.goto('/');
  await expect(page.locator('#open')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Kanban de Hermes', exact: true }).click();
  await page.getByRole('button', { name: 'Nuevo tablero', exact: true }).click();
  await page.getByLabel('Nombre del tablero').fill('Project fixture');
  await page.getByLabel('ID del tablero').fill('project-fixture');
  await page.getByLabel('Ruta del proyecto').fill('/home/user/project with spaces');
  // Existing polling must not wipe the form being edited.
  await page.waitForTimeout(8500);
  await expect(page.getByLabel('Nombre del tablero')).toHaveValue('Project fixture');
  await page.getByRole('button', { name: 'Crear tablero', exact: true }).click();
  await expect(page.locator('#kb-create-message')).toHaveText('Ese ID ya existe.');
  await expect(page.getByLabel('ID del tablero')).toHaveValue('project-fixture');
  await page.getByRole('button', { name: 'Crear tablero', exact: true }).click();
  await expect(page.locator('#kb-create-message')).toContainText('creado en Hermes');
  await expect(page.locator('#kb-create-form')).toBeHidden();
  await expect(page.locator('.kb-board-select')).toHaveValue('project-fixture');
  await expect(page.locator('.kb-board-name')).toHaveText('Project fixture');
  expect(posts).toBe(2);
  await page.getByRole('button', { name: 'Nuevo tablero', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Crear tablero', exact: true })).toBeVisible();
  const box = await page.locator('#kb-create-form').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(page.locator('#kb-create-form')).toBeHidden();
});
