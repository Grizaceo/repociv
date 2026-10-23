// Real GLTFLoader pass over the textured family: counts vs geometry-check, PBR slots,
// five lit views, single-sided and clay diagnostics, lineup, missing-GLB control.
// Dark-pixel counts on the clay renders are computed afterwards by family_contact_sheets.py.
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const BASE = process.env.FAMILY_BASE ?? 'http://127.0.0.1:5283';
const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node verify-family-textured.mjs <output-dir>');
const ROOT = new URL('../../', import.meta.url).pathname;
const NEW = ['coordination-court', 'connection-gateway', 'artifact-vault', 'research-laboratory', 'civic-plaza'];
const ALL = ['memory-archive', 'observatory', ...NEW];
const VIEWS = ['iso', 'front', 'back', 'right', 'left', 'map'];

async function expectedTriangles(id) {
  if (!NEW.includes(id)) return null;
  const check = JSON.parse(await readFile(`${ROOT}assets-src/meshy/${id}/texture-v001/geometry-check.json`, 'utf8'));
  return check.structure.triangles;
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const report = { base: BASE, assets: {}, lineup: {}, errors: [] };
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', (e) => report.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && report.errors.push(m.text()));
  async function open(asset, diag, view = 'iso') {
    await page.goto(`${BASE}/scripts/meshy/family-textured-preview.html?asset=${asset}&diag=${diag}&view=${view}`);
    await page.waitForFunction(() => ['ready', 'failed'].includes(window.familyTextured?.snapshot().status), null, { timeout: 120000 });
    await page.evaluate(() => (document.querySelector('aside').style.display = 'none'));
    return page.evaluate(() => window.familyTextured.snapshot());
  }
  async function shoot(view, path) {
    await page.evaluate((v) => window.familyTextured.setView(v), view);
    await page.waitForTimeout(400);
    return page.screenshot({ path });
  }
  for (const id of ALL) {
    const dir = `${OUT}/${id}`;
    await mkdir(dir, { recursive: true });
    const snap = await open(id, 'lit');
    const info = snap.assets[id];
    const expected = await expectedTriangles(id);
    const problems = [];
    if (snap.status !== 'ready') problems.push(`load ${snap.status}`);
    if (info?.meshes !== 1) problems.push(`meshes ${info?.meshes}`);
    if (expected !== null && info?.triangles !== expected) problems.push(`triangles ${info?.triangles} != ${expected}`);
    const m = info?.materials?.[0];
    if (!(m?.baseColor && m.normal && m.roughness && m.metalness)) problems.push('missing PBR slot');
    if (m?.baseColorSpace !== 'srgb') problems.push(`base color space ${m?.baseColorSpace}`);
    if (!info?.normalsValid) problems.push('invalid normals');
    if (Math.abs(info?.placedMinY ?? 1) > 1e-6) problems.push(`not grounded: minY ${info?.placedMinY}`);
    for (const view of VIEWS) await shoot(view, `${dir}/lit-${view}.png`);
    await open(id, 'single');
    for (const view of VIEWS.slice(0, 5)) await shoot(view, `${dir}/single-${view}.png`);
    await open(id, 'unlit');
    await shoot('iso', `${dir}/unlit-iso.png`);
    await shoot('back', `${dir}/unlit-back.png`);
    await open(id, 'clay');
    for (const view of VIEWS.slice(0, 5)) await shoot(view, `${dir}/clay-${view}.png`);
    report.assets[id] = { info, expectedTriangles: expected, problems };
    console.log(id, JSON.stringify({ triangles: info?.triangles, problems }));
  }
  await mkdir(`${OUT}/lineup`, { recursive: true });
  await page.setViewportSize({ width: 1800, height: 600 });
  for (const diag of ['lit', 'clay']) {
    const snap = await open('lineup', diag);
    report.lineup[diag] = { status: snap.status, calls: snap.calls, triangles: snap.triangles };
    for (const view of ['iso', 'front', 'map']) await shoot(view, `${OUT}/lineup/${diag}-${view}.png`);
  }
  // Negative control: an aborted candidate must surface as failed, never as ready.
  await page.route('**/civic-plaza/texture-v001/textured.glb', (route) => route.abort());
  const failed = await open('civic-plaza', 'lit');
  report.negativeControl = {
    status: failed.status,
    message: await page.locator('#status').innerText(),
  };
  await page.unroute('**/civic-plaza/texture-v001/textured.glb');
} finally {
  await browser.close();
}
const benignErrors = report.errors.filter((e) => /civic-plaza\/texture-v001\/textured\.glb|Failed to load resource/.test(e));
report.unexpectedErrors = report.errors.filter((e) => !benignErrors.includes(e));
report.ok =
  report.unexpectedErrors.length === 0 &&
  report.negativeControl.status === 'failed' &&
  Object.values(report.assets).every((a) => a.problems.length === 0);
await writeFile(`${OUT}/browser-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, negativeControl: report.negativeControl, unexpectedErrors: report.unexpectedErrors }));
if (!report.ok) process.exitCode = 1;
