import { expect, test } from '@playwright/test';

// The 2D drawing classes cost ~1 ms per frame, but a frame at 5 FPS is 200 ms.
// So ~199 ms per frame are somewhere else, and micro-benchmarks cannot find
// them. This takes a real sampled CPU profile of the live local-view frame via
// CDP, which names the hot functions instead of asking us to guess.
//
// The attribution is the deliverable: the top self-time entries are where the
// frame actually goes. Read it as evidence, not as a pass/fail gate.

test('profile: sampled CPU profile of the live local-view frame', async ({ page }) => {
  test.setTimeout(300_000);

  // Same boot path as the other local-view specs: seed one repo, skip the tour,
  // open the onboarding past, then enter local view through a real double-click.
  const response = await page.request.get('/api/repos');
  expect(response.ok()).toBeTruthy();
  const repos = (await response.json()) as Array<{ path?: string }>;
  const paths = repos
    .map((r) => r.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .slice(0, 1);
  expect(paths.length).toBeGreaterThan(0);
  await page.addInitScript((selected) => {
    window.localStorage.setItem('repociv:tour-seen:v1', '1');
    window.localStorage.setItem(
      'repociv:selected-repos:v1',
      JSON.stringify({
        version: 1,
        selectedRepoPaths: selected,
        filters: { owners: [], topics: [], languages: [] },
      }),
    );
  }, paths);

  await page.goto('/?renderer=flat');
  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 20_000 });
  if (
    await page
      .locator('#repo-onboarding')
      .isVisible()
      .catch(() => false)
  ) {
    await page.locator('#repo-onboarding-next').click();
    await expect(page.locator('#repo-onboarding-title')).toContainText(/Revisa tu seleccion/);
    await page.locator('#repo-onboarding-next').click();
    await expect(page.locator('#repo-onboarding')).toBeHidden({ timeout: 20_000 });
  }
  await expect(page.locator('#main-canvas')).toBeVisible();
  await page.waitForTimeout(3000);

  const positions = await page
    .evaluate(
      () =>
        (
          window as Window & {
            __repocivDebug?: {
              getMacroCityScreenPositions?: () => Array<{ cityId: string; x: number; y: number }>;
            };
          }
        ).__repocivDebug?.getMacroCityScreenPositions?.() ?? [],
    )
    .catch(() => []);

  let entered = false;
  for (const pos of positions as Array<{ cityId: string; x: number; y: number }>) {
    await page.mouse.dblclick(pos.x, pos.y);
    await page.waitForTimeout(300);
    if (
      await page
        .locator('#local-view-frame')
        .isVisible()
        .catch(() => false)
    ) {
      await page.locator('#main-canvas').focus();
      entered = true;
      break;
    }
  }
  if (!entered && positions.length > 0) {
    await page.evaluate(
      (cityId) => {
        (
          window as Window & { __repocivDebug?: { openLocalView?: (id: string) => boolean } }
        ).__repocivDebug?.openLocalView?.(cityId);
      },
      (positions as Array<{ cityId: string }>)[0]!.cityId,
    );
    entered = await page
      .locator('#local-view-frame')
      .isVisible()
      .catch(() => false);
  }
  expect(entered, 'debe entrar a vista local para perfilar').toBeTruthy();
  await expect(page.locator('#main-canvas')).toHaveAttribute('data-local-active', 'true');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  // Discard the first samples: warmup is not what we are profiling.
  await page.waitForTimeout(3000);
  await cdp.send('Profiler.start');

  // Count what the frame actually iterates, so "drawIsoTile is hot" becomes a
  // number rather than a hint. These are cheap counters on the live objects.
  const counts = await page.evaluate(() => {
    const w = window as unknown as {
      __repocivDebug?: {
        getTileStats?: () => Record<string, number>;
        getGlobalUnits?: () => unknown[];
      };
    };
    const stats = w.__repocivDebug?.getTileStats?.() ?? {};
    const units = w.__repocivDebug?.getGlobalUnits?.() ?? [];
    const total = Object.values(stats).filter((v) => typeof v === 'number');
    return {
      tileStatsKeys: Object.keys(stats).slice(0, 20),
      tileCount: total.reduce((a, b) => a + b, 0),
      unitCount: units.length,
    };
  });

  // Sample long enough to cover many frames at ~5 FPS.
  await page.waitForTimeout(15000);
  const { profile } = (await cdp.send('Profiler.stop')) as {
    profile: {
      nodes: Array<{
        id: number;
        callFrame: { functionName: string; url: string; lineNumber: number };
        hitCount?: number;
      }>;
      samples?: number[];
    };
  };

  // Self time per function: hitCount on the node, attributed to its own frame.
  const bySelf = new Map<string, { hits: number; url: string; line: number }>();
  for (const node of profile.nodes) {
    const { functionName, url, lineNumber } = node.callFrame;
    if (!url.includes('/src/') && !url.includes('node_modules')) continue;
    const key = `${functionName || '(anonimo)'} @ ${url.split('/').pop()}:${lineNumber + 1}`;
    const e = bySelf.get(key) ?? { hits: 0, url, line: lineNumber + 1 };
    e.hits += node.hitCount ?? 0;
    bySelf.set(key, e);
  }
  const top = [...bySelf.entries()]
    .sort((a, b) => b[1].hits - a[1].hits)
    .slice(0, 25)
    .map(([fn, e]) => ({ fn, hits: e.hits }));

  const totalSamples = profile.samples?.length ?? 0;
  console.log(
    'CPUPROFILE ' +
      JSON.stringify({ totalSamples, counts, topFrames: top, fpsOverWindow: 'see test output' }),
  );
  expect(top.length).toBeGreaterThan(0);
});
