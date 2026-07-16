import { expect, test, type Page, type Route } from '@playwright/test';

const oldRepo = {
  name: 'old-repo',
  path: 'repo:old',
  repoPath: '/workspace/OLD/old-repo',
  rootPath: '/workspace/OLD',
  population: 8,
  extensions: { ts: 4 },
  gold: 10,
  lastCommitDays: 1,
  isLegacy: false,
  hasGit: true,
};

const parentRepos = [
  {
    ...oldRepo,
    name: 'alpha-city',
    path: 'repo:alpha',
    repoPath: '/workspace/ACTIVE/alpha-city',
    rootPath: '/workspace/ACTIVE',
  },
  {
    ...oldRepo,
    name: 'beta-city',
    path: 'repo:beta',
    repoPath: '/workspace/ACTIVE/beta-city',
    rootPath: '/workspace/ACTIVE',
  },
];

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function boot(page: Page) {
  await page.goto('/');
  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('html[data-app-ready="1"]')).toBeAttached({ timeout: 20_000 });
  await expect(page.locator('#main-canvas')).toBeVisible();
}

test('inspected folder can replace the map with its parent siblings', async ({ page }) => {
  let applied = false;
  let applyPayload: unknown = null;
  let applyTokenHeader = '';

  await page.addInitScript(() => {
    window.localStorage.setItem('repociv:tour-seen:v1', '1');
    window.localStorage.setItem('repociv:renderer', 'flat');
    window.localStorage.setItem('repociv:hud-mode', 'advanced');
    window.localStorage.setItem(
      'repociv:selected-repos:v1',
      JSON.stringify({
        version: 1,
        selectedRepoPaths: ['/workspace/OLD/old-repo'],
        filters: { owners: [], topics: [], languages: [] },
      }),
    );
  });

  await page.route('**/api/repo-selections', (route) => {
    const repos = applied ? parentRepos : [oldRepo];
    const rootPath = applied ? '/workspace/ACTIVE' : '/workspace/OLD';
    return json(route, {
      activeRoot: rootPath,
      roots: [
        {
          path: rootPath,
          selectedRepoIds: repos.map((repo) => repo.path),
          selectedRepoPaths: repos.map((repo) => repo.repoPath),
        },
      ],
      selectedRepoIds: repos.map((repo) => repo.path),
      selectedRepoPaths: repos.map((repo) => repo.repoPath),
      hasSelections: true,
    });
  });
  await page.route('**/api/repos', (route) => json(route, applied ? parentRepos : [oldRepo]));
  await page.route('**/api/repos/selected', (route) =>
    json(route, applied ? parentRepos : [oldRepo]),
  );
  await page.route('**/api/files/**', (route) => json(route, { files: [] }));
  await page.route('**/api/skill-health/**', (route) => json(route, { health: 'ok' }));
  await page.route('**/api/session-tint/**', (route) => json(route, { tint: 'bright' }));
  await page.route('**/api/repo/inspect', (route) =>
    json(route, {
      ok: true,
      repo: parentRepos[0],
      parentMap: { rootPath: '/workspace/ACTIVE', repos: parentRepos },
    }),
  );
  await page.route('**/api/map-from-parent', async (route) => {
    applyPayload = route.request().postDataJSON();
    applyTokenHeader = route.request().headers()['x-repociv-token'] ?? '';
    applied = true;
    return json(route, {
      ok: true,
      rootPath: '/workspace/ACTIVE',
      repos: parentRepos,
      selectedRepoIds: parentRepos.map((repo) => repo.path),
      selectedRepoPaths: parentRepos.map((repo) => repo.repoPath),
    });
  });

  await boot(page);
  await page.locator('#btn-construction').click();
  await expect(page.locator('#construction-panel')).toBeVisible();
  await expect(page.locator('#construction-panel')).toHaveAttribute('role', 'dialog');
  await expect(page.locator('#construction-panel')).toHaveAttribute('aria-modal', 'true');

  await page.locator('#construction-repo-path').fill('/workspace/ACTIVE/alpha-city');
  await page.locator('#construction-inspect-repo').click();

  const parentMap = page.locator('#construction-parent-map');
  await expect(parentMap).toBeVisible();
  await expect(parentMap).toContainText('/workspace/ACTIVE');
  await expect(parentMap).toContainText('2 carpetas');
  await expect(parentMap).toContainText('alpha-city');
  await expect(parentMap).toContainText('beta-city');

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.locator('#construction-load-parent-map').click(),
  ]);
  await expect(page.locator('html[data-app-ready="1"]')).toBeAttached({ timeout: 20_000 });

  expect(applyPayload).toEqual({ path: '/workspace/ACTIVE/alpha-city' });
  expect(Boolean(applyTokenHeader)).toBe(true);
  const selectedPaths = await page.evaluate(() => {
    const raw = window.localStorage.getItem('repociv:selected-repos:v1');
    return raw ? (JSON.parse(raw).selectedRepoPaths as string[]) : [];
  });
  expect(selectedPaths).toEqual(parentRepos.map((repo) => repo.repoPath));

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __repocivDebug?: { getMacroCityScreenPositions(): Array<{ cityId: string }> };
            }
          ).__repocivDebug?.getMacroCityScreenPositions().length ?? 0,
      ),
    )
    .toBe(2);

  await page.locator('#btn-construction').click();
  await expect(page.locator('#construction-pick-tile')).toBeVisible();
});

test('empty parents are non-actionable and stale inspections cannot overwrite the latest path', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('repociv:tour-seen:v1', '1');
    window.localStorage.setItem('repociv:renderer', 'flat');
    window.localStorage.setItem('repociv:hud-mode', 'advanced');
    window.localStorage.setItem(
      'repociv:selected-repos:v1',
      JSON.stringify({
        version: 1,
        selectedRepoPaths: ['/workspace/OLD/old-repo'],
        filters: { owners: [], topics: [], languages: [] },
      }),
    );
  });
  await page.route('**/api/repo-selections', (route) =>
    json(route, {
      activeRoot: '/workspace/OLD',
      roots: [
        {
          path: '/workspace/OLD',
          selectedRepoIds: [oldRepo.path],
          selectedRepoPaths: [oldRepo.repoPath],
        },
      ],
      selectedRepoIds: [oldRepo.path],
      selectedRepoPaths: [oldRepo.repoPath],
      hasSelections: true,
    }),
  );
  await page.route('**/api/repos', (route) => json(route, [oldRepo]));
  await page.route('**/api/repos/selected', (route) => json(route, [oldRepo]));
  await page.route('**/api/files/**', (route) => json(route, { files: [] }));
  await page.route('**/api/skill-health/**', (route) => json(route, { health: 'ok' }));
  await page.route('**/api/session-tint/**', (route) => json(route, { tint: 'bright' }));
  await page.route('**/api/repo/inspect', async (route) => {
    const { path } = route.request().postDataJSON() as { path: string };
    const repo = {
      ...oldRepo,
      name: path.split('/').pop() ?? path,
      path: `repo:${path}`,
      repoPath: path,
      rootPath: path.toLowerCase().includes('/fast/') ? '/workspace/FAST' : '/workspace/SLOW',
    };
    if (path.endsWith('/empty')) {
      return json(route, {
        ok: true,
        repo,
        parentMap: { rootPath: '/workspace/EMPTY', repos: [] },
      });
    }
    if (path.endsWith('/slow')) await new Promise((resolve) => setTimeout(resolve, 180));
    return json(route, {
      ok: true,
      repo,
      parentMap: { rootPath: repo.rootPath, repos: [repo] },
    });
  });

  await boot(page);
  await page.locator('#btn-construction').click();
  const pathInput = page.locator('#construction-repo-path');
  const parentMap = page.locator('#construction-parent-map');

  await pathInput.fill('/workspace/EMPTY/empty');
  await page.locator('#construction-inspect-repo').click();
  await expect(parentMap).toContainText('0 carpetas');
  await expect(parentMap).toContainText('No hay subcarpetas elegibles');
  await expect(page.locator('#construction-load-parent-map')).toHaveCount(0);
  await expect(page.locator('#construction-pick-tile')).toBeVisible();

  await pathInput.fill('/workspace/SLOW/slow');
  await expect(parentMap).toBeHidden();
  await page.locator('#construction-inspect-repo').click();
  await page.waitForTimeout(20);
  await pathInput.fill('/workspace/FAST/fast');
  await page.locator('#construction-inspect-repo').click();
  await expect(parentMap).toContainText('/workspace/FAST');
  await page.waitForTimeout(220);
  await expect(parentMap).toContainText('/workspace/FAST');
  await expect(parentMap).not.toContainText('/workspace/SLOW');

  await pathInput.fill('/workspace/SLOW/slow');
  await page.locator('#construction-inspect-repo').click();
  await page.locator('#construction-close').click();
  await page.waitForTimeout(220);
  await page.locator('#btn-construction').click();
  await expect(parentMap).toBeHidden();
});
