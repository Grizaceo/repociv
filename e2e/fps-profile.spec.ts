import { expect, test, type Page } from '@playwright/test';

// Where do the frames go? The FPS test measures 2.8 on a machine whose blank-page
// ceiling is 57, so the cost is inside the local-view render, not the environment.
// This probe attributes it by measurement: it first samples the LIVE render loop
// (the number the failing test reports), then re-times the same 2D context with
// individual drawing classes isolated, so each one is a measured cost rather than
// a guess from reading the code.
//
// The numbers are the deliverable, not a pass/fail gate. A machine under load
// gives a bad live FPS, so the stage costs are what generalise.
test('profile: cost of each drawing class in the local-view frame', async ({ page }) => {
  test.setTimeout(240_000);

  // The helpers below are duplicated per spec on purpose: this repo's e2e files
  // each carry their own, and importing across specs would couple them.
  const seedRepoSelection = async () => {
    const response = await page.request.get('/api/repos');
    expect(response.ok(), await response.text()).toBeTruthy();
    const repos = (await response.json()) as Array<{ path?: string }>;
    const paths = repos
      .map((repo) => repo.path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .slice(0, 1);
    expect(paths.length, 'expected /api/repos to return selectable repos').toBeGreaterThan(0);
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
  };

  await seedRepoSelection();
  await page.goto('/?renderer=flat');
  await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 20_000 });
  if (
    await page
      .locator('#repo-onboarding')
      .isVisible()
      .catch(() => false)
  ) {
    await expect(page.locator('#repo-onboarding-next')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#repo-onboarding-next').click();
    await expect(page.locator('#repo-onboarding-title')).toContainText(/Revisa tu seleccion/);
    await page.locator('#repo-onboarding-next').click();
    await expect(page.locator('#repo-onboarding')).toBeHidden({ timeout: 20_000 });
  }
  await expect(page.locator('#main-canvas')).toBeVisible();
  await page.waitForTimeout(3000);

  // Enter local view through the real interaction: double-click a city, with the
  // debug hook as the documented fallback the other specs also use.
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

  const result = await page.evaluate(async () => {
    // 1. The live loop. This is the number the failing FPS test reports.
    const live = await new Promise<number>((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      function tick() {
        frames++;
        const dt = performance.now() - t0;
        if (dt < 4000) requestAnimationFrame(tick);
        else resolve(+((frames * 1000) / dt).toFixed(1));
      }
      requestAnimationFrame(tick);
    });

    const canvas = document.querySelector('#main-canvas') as HTMLCanvasElement | null;
    if (!canvas) return { error: 'no #main-canvas', live };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { error: 'no 2d context', live };
    const cw = canvas.width;
    const ch = canvas.height;

    // Time a WHOLE batch against the wall clock, not each call: headless
    // Chromium coarsens performance.now(), so per-call timings round to 0 and
    // report impossible numbers (2000 fills costing less than one clearRect).
    // A batch long enough to outlast the clock resolution gives real figures.
    function timeBatch(
      body: () => void,
      calls: number,
      reps = 12,
    ): { totalMs: number; perCallUs: number } {
      const batch: number[] = [];
      for (let r = 0; r < reps; r++) {
        const t0 = performance.now();
        for (let i = 0; i < calls; i++) body();
        batch.push(performance.now() - t0);
      }
      batch.sort((a, b) => a - b);
      const totalMs = batch[Math.floor(batch.length / 2)]!;
      return { totalMs: +totalMs.toFixed(2), perCallUs: +((totalMs * 1000) / calls).toFixed(3) };
    }

    const clear = timeBatch(() => ctx.clearRect(0, 0, cw, ch), 1, 40);
    const fullRectFill = timeBatch(
      () => {
        ctx.fillStyle = '#1a1712';
        ctx.fillRect(0, 0, cw, ch);
      },
      1,
      40,
    );

    // 2000 small fills: the cost class of a dense per-tile floor/wall pass.
    const tileFills = timeBatch(
      () => {
        for (let i = 0; i < 2000; i++) {
          ctx.fillStyle = i % 2 ? '#222' : '#2a2620';
          ctx.fillRect((i * 37) % cw, (i * 53) % ch, 24, 24);
        }
      },
      1,
      12,
    );

    // State churn with no drawing at all: how much is save/restore itself.
    const saveRestore = timeBatch(
      () => {
        for (let i = 0; i < 2000; i++) {
          ctx.save();
          ctx.fillStyle = '#333';
          ctx.restore();
        }
      },
      1,
      12,
    );

    // Text: the cost class the activity glyph belongs to.
    const fillText = timeBatch(
      () => {
        ctx.font = '20px monospace';
        for (let i = 0; i < 2000; i++) ctx.fillText('*', (i * 31) % cw, (i * 29) % ch);
      },
      1,
      12,
    );

    // 5. Attribute the frame cost without touching product code. The minimap
    //    draw ends in a drawImage() onto #minimap-canvas every frame, and
    //    computeBounds() walks the whole tile map twice per call before its
    //    own dirty check. Wrapping the 2D prototype catches that drawImage by
    //    target, and wrapping Map.prototype.values catches the tile walk —
    //    neither needs a debug hook that does not exist today.
    const protoDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    const perTarget = new Map<string, { calls: number; totalMs: number }>();
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      ...args: unknown[]
    ) {
      const cnv = args[0] as HTMLCanvasElement | undefined;
      const id = (cnv && (cnv as HTMLCanvasElement & { id?: string }).id) || 'unnamed';
      const t0 = performance.now();
      const out = protoDrawImage.apply(this, args as never);
      const e = perTarget.get(id) ?? { calls: 0, totalMs: 0 };
      e.calls++;
      e.totalMs += performance.now() - t0;
      perTarget.set(id, e);
      return out;
    };

    // Sample the live loop with the wrappers in place.
    const liveWithWrap = await new Promise<number>((resolve) => {
      let frames = 0;
      const t0 = performance.now();
      function tick() {
        frames++;
        const dt = performance.now() - t0;
        if (dt < 4000) requestAnimationFrame(tick);
        else resolve(+((frames * 1000) / dt).toFixed(1));
      }
      requestAnimationFrame(tick);
    });

    CanvasRenderingContext2D.prototype.drawImage = protoDrawImage;
    const drawImageByTarget: Record<string, { calls: number; avgUs: number }> = {};
    for (const [id, e] of perTarget) {
      drawImageByTarget[id] = { calls: e.calls, avgUs: +((e.totalMs * 1000) / e.calls).toFixed(1) };
    }

    // 6. The decisive experiment. MinimapRenderer.draw() returns immediately when
    //    #minimap-canvas is absent, and the render loop calls it every frame. So
    //    removing the element removes the whole call, including computeBounds()'s
    //    two full walks of the tile map — with no change to product code.
    //
    //    Order matters: measure the control SECOND, after the treatment. The
    //    first sample of any rAF probe on this page lands during warmup (JIT,
    //    first paint, asset decode) and reads artificially low — a control
    //    measured first can make a no-op look like a 9x win.
    const sampleFps = () =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        function tick() {
          frames++;
          const dt = performance.now() - t0;
          if (dt < 4000) requestAnimationFrame(tick);
          else resolve(+((frames * 1000) / dt).toFixed(1));
        }
        requestAnimationFrame(tick);
      });

    // Warm up before any measurement is recorded, so no sample is contaminated.
    await sampleFps();

    const mm = document.getElementById('minimap-canvas');
    const mmParent = mm?.parentElement ?? null;
    const mmNext = mm?.nextSibling ?? null;
    mm?.remove();
    const fpsNoMinimap1 = await sampleFps();
    const fpsNoMinimap2 = await sampleFps();
    if (mm && mmParent) {
      mmParent.insertBefore(mm, mmNext);
    }
    // Control, measured last and on the restored page.
    const fpsWithMinimap1 = await sampleFps();
    const fpsWithMinimap2 = await sampleFps();

    return {
      live,
      liveWithWrap,
      fpsNoMinimap1,
      fpsNoMinimap2,
      fpsWithMinimap1,
      fpsWithMinimap2,
      canvas: { w: cw, h: ch },
      clearMs: clear.totalMs,
      fullRectFillMs: fullRectFill.totalMs,
      tileBatchMs: tileFills.totalMs,
      saveRestoreBatchMs: saveRestore.totalMs,
      textBatchMs: fillText.totalMs,
      perTileUs: +(((tileFills.totalMs - clear.totalMs) * 1000) / 2000).toFixed(3),
      perSaveRestoreUs: +(((saveRestore.totalMs - clear.totalMs) * 1000) / 2000).toFixed(3),
      perTextUs: +(((fillText.totalMs - clear.totalMs) * 1000) / 2000).toFixed(3),
      drawImageByTarget,
    };
  });

  console.log('PROFILE ' + JSON.stringify(result));
  expect(result).toBeTruthy();
});
