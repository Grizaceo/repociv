// Family buildings inside the real RepoCiv 3D map (dev server or served build).
// Fixture repos/wonders via page routing: no bridge, no live state is touched.
//   node scripts/meshy/verify-family-map.mjs <baseURL> <outDir> [--expect-off]
// --expect-off: the build was made WITHOUT VITE_MESHY_PREVIEW; assert that no
// family GLB is requested and every wonder keeps its ordinary model.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const [base, out] = process.argv.slice(2);
const expectOff = process.argv.includes('--expect-off');
if (!base || !out) throw new Error('usage: verify-family-map.mjs <baseURL> <outDir> [--expect-off]');
await mkdir(out, { recursive: true });

const EXPECTED = {
  'memory-archive': 'memory-archive',
  grafana: 'observatory',
  airflow: 'coordination-court',
  ghostdesk: 'connection-gateway',
  duckdb: 'artifact-vault',
  'ml-lab': 'research-laboratory',
  ollama: null,
  docker: null,
};
const ROOT = '/tmp/repociv-fixtures';
const repo = (name, population, extensions) => ({
  name, path: `${ROOT}/${name}`, repoPath: `${ROOT}/${name}`, rootPath: ROOT, population,
  extensions, gold: 100, lastCommitDays: 3, isLegacy: false, hasGit: true,
});
const REPOS = [repo('repo-alpha', 820, { ts: 400, md: 20 }), repo('repo-beta', 460, { py: 300 }),
  repo('repo-gamma', 300, { rs: 180 }), repo('repo-delta', 140, { md: 120 })];
const PATHS = REPOS.map((r) => r.path);
const SELECTION = { activeRoot: ROOT, roots: [{ path: ROOT, selectedRepoIds: PATHS, selectedRepoPaths: PATHS }],
  selectedRepoIds: PATHS, selectedRepoPaths: PATHS, hasSelections: true };
const wonder = (id) => ({
  id, title: id, kind: 'iframe', category: 'tools', version: '0.1.0', defaultEnabled: true,
  automationLevel: 'passive', passiveMode: true, agenticMode: false, canSuggest: false, canAct: false,
  requiresConfirmation: false, ui: { url: 'about:blank' },
  permissions: { readRepos: false, writeRepos: false, network: 'none', requiresApprovalForMutations: false },
  optionalFeatures: [], events: { emits: [], accepts: [] }, actions: [], mcp: { enabled: false, server: null },
});
const WONDERS = Object.keys(EXPECTED).map(wonder);

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});

async function run(label, { abort } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(/\/api\/repos(\?.*)?$/, (r) => r.fulfill({ json: REPOS }));
  await context.route(/\/api\/repos\/selected(\?.*)?$/, (r) => r.fulfill({ json: REPOS }));
  await context.route(/\/api\/repo-selections(\?.*)?$/, (r) =>
    r.request().method() === 'GET' ? r.fulfill({ json: SELECTION }) : r.fulfill({ json: { ok: true } }));
  await context.route(/\/api\/files\/[^/?]+(\?.*)?$/, (r) => r.fulfill({ json: { files: ['README.md'] } }));
  await context.route(/\/api\/wonders(\?.*)?$/, (r) => r.fulfill({ json: WONDERS }));
  await context.route(/\/api\/wonders\/[^/?]+\/[^?]+/, (r) => r.fulfill({ json: { ok: true, status: 'offline', ready: false } }));
  if (abort) await context.route(`**/${abort}`, (r) => r.abort());
  const page = await context.newPage();
  const errors = [];
  const glb = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', async (res) => {
    if (/-map\.glb/.test(res.url())) {
      glb.push({ url: new URL(res.url()).pathname, status: res.status(),
        cacheControl: res.headers()['cache-control'], etag: res.headers()['etag'],
        bytes: Number(res.headers()['content-length'] ?? 0) });
    }
  });
  page.on('requestfailed', (req) => /-map\.glb/.test(req.url()) && glb.push({ url: new URL(req.url()).pathname, failed: req.failure()?.errorText }));
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('repociv:tour-seen:v1', '1');
    localStorage.setItem('repociv:renderer', 'webgl');
  });
  await page.goto(`${base}/?renderer=webgl&freeze=2&reveal=all&cam=auto,1.4`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const d = window.__repocivDebug;
    const props = d?.getWonderProps?.();
    return d?.areWonderPropsSettled?.() === true && Array.isArray(props) && props.length >= 8;
  }, null, { timeout: 240000 });
  await page.waitForTimeout(2500);
  const props = await page.evaluate(() => window.__repocivDebug.getWonderProps());
  const shots = [];
  // Overview at the default map zoom, then close-ups centered on each wonder pair.
  const cams = [['overview', 'auto,1.0'], ['ring', '0,0,1.9'],
    ...props.map((p) => [p.wonderType, `${Math.round(p.x)},${Math.round(p.z)},3.4`])];
  for (const [name, cam] of label === 'main' ? cams : cams.slice(0, 2)) {
    await page.goto(`${base}/?renderer=webgl&freeze=2&reveal=all&cam=${cam}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__repocivDebug?.areWonderPropsSettled?.() === true
      && (window.__repocivDebug.getWonderProps() ?? []).length >= 8, null, { timeout: 240000 });
    // The degraded-mode banner is expected without a bridge; hide it for the capture only.
    await page.addStyleTag({ content: '.hermes-degraded-banner{display:none!important}' });
    await page.waitForTimeout(2500);
    const path = `${out}/${label}-${name}.png`;
    await page.screenshot({ path });
    shots.push(path);
  }
  const metrics = await page.evaluate(() => window.__repocivDebug.getWebGLMetrics?.());
  await context.close();
  return { label, props, glb, errors, shots, metrics };
}

function check(result, { offFamily = [] } = {}) {
  const problems = [];
  for (const [type, family] of Object.entries(EXPECTED)) {
    const p = result.props.find((x) => x.wonderType === type);
    if (!p) { problems.push(`${type}: no wonder instance`); continue; }
    const want = expectOff || offFamily.includes(family) ? null : family;
    if (p.family !== want) problems.push(`${type}: rendered ${p.name}, expected ${want ?? 'ordinary model'}`);
    if (p.minY < p.surfaceY - 1e-3) problems.push(`${type}: buried ${p.surfaceY - p.minY}`);
    if (p.family) {
      if (!p.textured) problems.push(`${type}: family model without textures`);
      if (p.materialColors.some((c) => c !== 'ffffff')) problems.push(`${type}: tinted ${p.materialColors}`);
      if (p.drawCalls !== 1) problems.push(`${type}: ${p.drawCalls} draw calls`);
    }
  }
  const families = result.props.filter((p) => p.family).length;
  if (expectOff && result.glb.length) problems.push(`requested family GLBs: ${result.glb.map((g) => g.url)}`);
  for (const g of result.glb) {
    if (g.failed) continue;
    if (g.status !== 200 && g.status !== 304) problems.push(`${g.url}: HTTP ${g.status}`);
    if (g.cacheControl !== 'no-cache' || !g.etag) problems.push(`${g.url}: cache headers ${g.cacheControl} ${g.etag}`);
  }
  if (result.errors.length) problems.push(...result.errors.map((e) => `page error: ${e}`));
  return { families, problems };
}

const report = { base, expectOff, runs: [] };
try {
  const main = await run('main');
  report.runs.push({ ...main, ...check(main) });
  if (!expectOff) {
    const vault = 'assets/3d/props/meshy/artifact-vault-map.glb';
    const aborted = await run('abort-vault', { abort: vault });
    report.runs.push({ ...aborted, ...check(aborted, { offFamily: ['artifact-vault'] }) });
  }
} finally {
  await browser.close();
}
report.ok = report.runs.every((r) => r.problems.length === 0);
await writeFile(`${out}/map-report.json`, JSON.stringify(report, null, 2));
for (const r of report.runs) {
  console.log(r.label, JSON.stringify({ families: r.families, glb: r.glb.length, problems: r.problems }));
  for (const p of r.props) console.log('  ', p.wonderType, '->', p.name, `minY-surface=${(p.minY - p.surfaceY).toFixed(3)}`, `h=${p.height.toFixed(1)}`, `tris=${p.triangles}`, `calls=${p.drawCalls}`);
}
console.log(JSON.stringify({ ok: report.ok }));
if (!report.ok) process.exitCode = 1;
