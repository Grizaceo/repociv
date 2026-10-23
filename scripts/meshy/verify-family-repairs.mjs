import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const root = `${process.env.TMPDIR}/repociv-meshy/family-repairs`;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const reports = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const asset of ['coordination-court', 'artifact-vault', 'research-laboratory']) {
    for (const variant of ['original', 'repair']) {
      const folder = variant === 'repair' ? 'repair-v003' : 'geometry';
      const dir = `${root}/${asset}/${variant}`;
      await mkdir(dir, { recursive: true });
      await page.goto(`http://127.0.0.1:5283/scripts/meshy/family-geometry-preview.html?asset=${asset}&variant=${variant}`);
      await page.waitForFunction(() => window.familyPreview?.snapshot().status === 'ready');
      const snapshot = await page.evaluate(() => window.familyPreview.snapshot());
      const audit = JSON.parse(await readFile(`assets-src/meshy/${asset}/${folder}/geometry-audit.json`, 'utf8'));
      if (snapshot.triangles !== audit.triangles || snapshot.textured || snapshot.meshes !== 1) throw Error(JSON.stringify(snapshot));
      for (const view of ['iso', 'front', 'back', 'right', 'left']) {
        await page.locator(`[data-view="${view}"]`).click();
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${dir}/${view}.png` });
      }
      // Unlit, single-sided diagnostic distinguishes surface closure from shadows.
      await page.evaluate(async () => {
        const T = await import('/node_modules/.vite/deps/three.js');
        window.familyPreview.scene.traverse(o => { if (o.isMesh && o.geometry.type !== 'CylinderGeometry') o.material = new T.MeshBasicMaterial({ color: 0xcccccc }); });
      });
      await page.locator('[data-view="iso"]').click();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${dir}/unlit.png` });
      reports.push({asset, variant, snapshot});
    }
  }
  if (errors.length) throw Error(errors.join('\n'));
  await writeFile(`${root}/browser-report.json`, JSON.stringify({ reports, errors }, null, 2));
  console.log(JSON.stringify({reports,errors}));
} finally { await browser.close(); }
