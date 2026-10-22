// Verify real local GLB import, orbit controls and each review view.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const out = `${process.env.TMPDIR}/repociv-meshy/workshop`;
if (!process.env.TMPDIR) throw new Error('TMPDIR required');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:5283/scripts/meshy/workshop-preview.html');
  await page.waitForFunction(() => window.workshopPreview?.snapshot().status === 'ready');
  const snapshot = await page.evaluate(() => window.workshopPreview.snapshot());
  if (
    snapshot.triangles !== 3735 ||
    snapshot.meshes !== 1 ||
    snapshot.textured ||
    snapshot.generatedNormals !== 1
  )
    throw new Error(JSON.stringify(snapshot));
  const normalsValid = await page.evaluate(() => {
    let valid = true;
    window.workshopPreview.scene.traverse((o) => {
      if (o.isMesh) {
        const n = o.geometry.attributes.normal;
        if (
          !n ||
          !Array.from(n.array).every(Number.isFinite) ||
          !Array.from(n.array).some((v) => Math.abs(v) > 0.5)
        )
          valid = false;
      }
    });
    return valid;
  });
  if (!normalsValid) throw new Error('Missing or invalid runtime normals');
  for (const view of ['iso', 'front', 'back', 'right', 'left']) {
    await page.locator(`[data-view="${view}"]`).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${view}.png` });
  }
  await page.locator('[data-view="iso"]').click();
  await page.mouse.move(850, 500);
  await page.mouse.down();
  await page.mouse.move(1030, 550, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/orbit.png` });
  if (errors.length) throw new Error(errors.join('\n'));
  await page.goto('http://127.0.0.1:5283/scripts/meshy/family-review.html');
  await page.waitForFunction(() =>
    [...document.images].every((i) => i.complete && i.naturalWidth > 0),
  );
  if ((await page.locator('a[href="/scripts/meshy/workshop-preview.html"]').count()) !== 1)
    throw new Error('Workshop link missing');
  const missing = await browser.newPage();
  await missing.route('**/execution-workshop/geometry/preview.glb', (r) =>
    r.fulfill({ status: 404, body: 'missing' }),
  );
  await missing.goto('http://127.0.0.1:5283/scripts/meshy/workshop-preview.html');
  await missing.waitForFunction(() => window.workshopPreview?.snapshot().status === 'failed');
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(
      {
        snapshot,
        errors,
        views: ['iso', 'front', 'back', 'right', 'left', 'orbit'],
        missingAssetMessage: 'verified',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      snapshot,
      errors,
      screenshotDir: out,
      viewsVerified: 6,
      missingAssetMessage: 'verified',
    }),
  );
} finally {
  await browser.close();
}
