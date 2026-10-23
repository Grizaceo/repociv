// Real local GLBs through GLTFLoader, five views each and missing-asset control.
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
if (!process.env.TMPDIR) throw new Error('TMPDIR required');
const out = `${process.env.TMPDIR}/repociv-meshy/family-geometry`;
await mkdir(out, { recursive: true });
const assets = ['coordination-court', 'connection-gateway', 'artifact-vault', 'research-laboratory', 'civic-plaza'];
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const reports = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const asset of assets) {
    await mkdir(`${out}/${asset}`, { recursive: true });
    await page.goto(`http://127.0.0.1:5283/scripts/meshy/family-geometry-preview.html?asset=${asset}`);
    await page.waitForFunction(() => window.familyPreview?.snapshot().status === 'ready');
    const snapshot = await page.evaluate(() => window.familyPreview.snapshot());
    const audit = JSON.parse(await readFile(`assets-src/meshy/${asset}/geometry/geometry-audit.json`, 'utf8'));
    if (snapshot.triangles !== audit.triangles || snapshot.meshes !== audit.meshes || snapshot.textured)
      throw new Error(JSON.stringify({asset, snapshot, audit}));
    const validNormals = await page.evaluate(() => {
      let valid = true;
      window.familyPreview.scene.traverse(o => {
        if (!o.isMesh) return;
        const n = o.geometry.attributes.normal;
        if (!n || !Array.from(n.array).every(Number.isFinite) || !Array.from(n.array).some(x => Math.abs(x) > 0.5)) valid = false;
      });
      return valid;
    });
    if (!validNormals) throw new Error(`${asset}: invalid normals`);
    await page.locator('details').evaluate(d => d.open = true);
    await page.locator('details img').evaluate(i => i.decode());
    for (const view of ['iso', 'front', 'back', 'right', 'left']) {
      await page.locator(`[data-view="${view}"]`).click();
      await page.waitForTimeout(180);
      await page.screenshot({ path: `${out}/${asset}/${view}.png` });
    }
    if (errors.length) throw new Error(errors.join('\n'));
    reports.push({ asset, snapshot, validNormals });
    console.log(JSON.stringify(reports.at(-1)));
  }
  await page.route('**/civic-plaza/geometry/preview.glb', route => route.abort());
  await page.reload();
  await page.waitForFunction(() => window.familyPreview?.snapshot().status === 'failed');
  const failedMessage = await page.locator('#status').innerText();
  const report = {reports, errors, failedMessage};
  await writeFile(`${out}/browser-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({count: reports.length, errors, failedMessage}));
} finally {
  await browser.close();
}
