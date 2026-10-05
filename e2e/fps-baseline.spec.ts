import { expect, test } from '@playwright/test';

// The FPS test asserts against a fixed threshold measured on a quiet CI box.
// This probe measures the ceiling of the machine *itself*, with no RepoCiv
// code, so a red FPS run can be attributed to the environment rather than
// guessed at. Run it on the same machine right after a failure:
//   npx playwright test e2e/fps-baseline.spec.ts --project=chromium
test('baseline: frame rate of a blank page on this machine', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setContent('<!doctype html><body style="background:#123"></body>');

  const result = await page.evaluate(
    () =>
      new Promise<{ fps: number; samples: number }>((resolve) => {
        let frames = 0;
        let last = performance.now();
        const samples: number[] = [];
        function tick(now: number) {
          frames++;
          const delta = now - last;
          if (delta >= 1000) {
            samples.push((frames * 1000) / delta);
            frames = 0;
            last = now;
          }
          if (samples.length < 10) requestAnimationFrame(tick);
          else
            resolve({
              fps: samples.reduce((a, b) => a + b, 0) / samples.length,
              samples: samples.length,
            });
        }
        requestAnimationFrame(tick);
      }),
  );

  console.log(`BLANK PAGE baseline FPS: ${result.fps.toFixed(1)} (samples=${result.samples})`);
  // Not a pass/fail gate: the number is the deliverable. Assert only that the
  // probe itself ran, so a broken measurement cannot masquerade as a result.
  expect(result.samples).toBe(10);
});
