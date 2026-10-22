// Exercise the actual WonderProps module in an isolated WebGL scene.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const out = process.env.TMPDIR;
if (!out) throw new Error('TMPDIR required');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:5283/scripts/meshy/archive-preview.html');
  await page.waitForFunction(() => window.archivePreview?.snapshot().archive, { timeout: 30000 });
  const snapshot = await page.evaluate(() => window.archivePreview.snapshot());
  if (snapshot.state !== 'ready' || !snapshot.archive || snapshot.triangles < 3730) throw new Error(JSON.stringify(snapshot));
  await mkdir(`${out}/repociv-meshy`, { recursive: true });
  await page.screenshot({ path: `${out}/repociv-meshy/archive-map.png` });
  await page.mouse.move(820, 500); await page.mouse.down(); await page.mouse.move(1000, 540, { steps: 15 }); await page.mouse.up();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/repociv-meshy/archive-rotated.png` });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ snapshot, errors, screenshot: `${out}/repociv-meshy/archive-map.png` }));
  // Force a missing asset on a fresh page: the ordinary prop must remain usable.
  const fallback = await browser.newPage();
  await fallback.route('**/archive-map.glb', r => r.fulfill({ status: 404, body: 'missing' }));
  await fallback.goto('http://127.0.0.1:5283/scripts/meshy/archive-preview.html');
  await fallback.waitForFunction(() => window.archivePreview?.snapshot().state === 'failed');
  const failed = await fallback.evaluate(() => window.archivePreview.snapshot());
  if (failed.archive || !failed.settled || failed.triangles === 0) throw new Error('Fallback failed');
  await writeFile(`${out}/repociv-meshy/browser-report.json`, JSON.stringify({ snapshot, fallback: failed, errors }, null, 2));
  console.log('Missing-asset fallback verified.');
} finally { await browser.close(); }
