// Real GLB, five sides and missing-asset negative control.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
if (!process.env.TMPDIR) throw new Error('TMPDIR required');
const out = `${process.env.TMPDIR}/repociv-meshy/observatory-textured`;
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
  const url = 'http://127.0.0.1:5283/scripts/meshy/observatory-textured-preview.html';
  await page.goto(url);
  await page.waitForFunction(
    () => window.observatoryTexturedPreview?.snapshot().status === 'ready',
  );
  const snapshot = await page.evaluate(() => window.observatoryTexturedPreview.snapshot());
  if (snapshot.triangles !== 3866 || snapshot.meshes !== 1 || !snapshot.textured)
    throw new Error(JSON.stringify(snapshot));
  if (!snapshot.materials?.every((m) => m.baseColor && m.normal && m.roughness && m.metalness))
    throw new Error('Missing PBR texture slots');
  const validNormals = await page.evaluate(() => {
    let valid = true;
    window.observatoryTexturedPreview.scene.traverse((o) => {
      if (!o.isMesh) return;
      const n = o.geometry.attributes.normal;
      if (
        !n ||
        !Array.from(n.array).every(Number.isFinite) ||
        !Array.from(n.array).some((x) => Math.abs(x) > 0.5)
      )
        valid = false;
    });
    return valid;
  });
  if (!validNormals) throw new Error('Invalid normals');
  for (const view of ['iso', 'front', 'back', 'right', 'left']) {
    await page.locator(`[data-view="${view}"]`).click();
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${out}/${view}.png` });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  await page.route('**/observatory/textured/preview.glb', (route) => route.abort());
  await page.reload();
  await page.waitForFunction(
    () => window.observatoryTexturedPreview?.snapshot().status === 'failed',
  );
  const failedMessage = await page.locator('#status').innerText();
  await writeFile(
    `${out}/browser-report.json`,
    JSON.stringify({ snapshot, validNormals, errors, failedMessage }, null, 2),
  );
  console.log(JSON.stringify({ snapshot, validNormals, errors, failedMessage }));
} finally {
  await browser.close();
}
