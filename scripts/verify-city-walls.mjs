#!/usr/bin/env node
/**
 * Inspect a freshly-captured 3D-audit screenshot to verify the city
 * restoration is visible. We do NOT rely on the SHA-256 vs golden (those
 * are stale). We decode the PNG and sample pixels looking for concrete
 * evidence of the restored city components.
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const OUT = join(REPO_ROOT, '.hermes/artifacts/3d-audit');
mkdirSync(OUT, { recursive: true });

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5273';
const FREEZE = '2';

const T = [
  { r: 0xc9, g: 0xbf, b: 0xa6, label: 'plaza'     },
  { r: 0xe4, g: 0xdd, b: 0xca, label: 'spire'     },
  { r: 0xb0, g: 0xa8, b: 0x98, label: 'wall'      },
  { r: 0xd9, g: 0xcc, b: 0xa2, label: 'landmark'  },
  // Capital fallback building cream (the ivory building boxes)
  { r: 0xc8, g: 0xc0, b: 0xb0, label: 'bld-cream'  },
  // Tile roof terracotta
  { r: 0x9e, g: 0x5a, b: 0x45, label: 'roof'       },
];

const TOL = 14;

function near(c, t, tol = TOL) {
  return Math.abs(c[0] - t.r) <= tol && Math.abs(c[1] - t.g) <= tol && Math.abs(c[2] - t.b) <= tol;
}

// Minimal PNG decode → raw RGBA
function decodePng(buf) {
  if (buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('not PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported colour type ${colorType} (need RGB=2 or RGBA=6)`);
  const channels = colorType === 2 ? 3 : 4;
  const compressed = Buffer.concat(idatChunks);
  const raw = inflateSync(compressed);
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = (y > 0 && x >= channels) ? out[(y - 1) * stride + x - channels] : 0;
      let val = raw[rowStart + x];
      if (filter === 0) {}
      else if (filter === 1) val = (val + left) & 0xff;
      else if (filter === 2) val = (val + up) & 0xff;
      else if (filter === 3) val = (val + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        val = (val + pred) & 0xff;
      }
      out[y * stride + x] = val;
    }
  }
  return { width, height, data: out };
}

function countColors(rgba, w, h) {
  const N = w * h;
  const counts = Object.fromEntries(T.map(t => [t.label, 0]));
  for (let i = 0; i < rgba.length; i += 4) {
    const c = [rgba[i], rgba[i + 1], rgba[i + 2]];
    for (const t of T) {
      if (near(c, t)) { counts[t.label]++; break; }
    }
  }
  return { N, counts };
}

async function captureAndAnalyse(cam, name) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    const SEED = {
      version: 1,
      selectedRepoPaths: [
        '/tmp/repociv-fixtures/repo-alpha',
        '/tmp/repociv-fixtures/repo-beta',
        '/tmp/repociv-fixtures/repo-gamma',
        '/tmp/repociv-fixtures/repo-delta',
        '/tmp/repociv-fixtures/repo-epsilon',
        '/tmp/repociv-fixtures/repo-zeta',
      ],
      filters: { owners: [], topics: [], languages: [] },
    };
    localStorage.setItem('repociv:renderer', 'webgl');
    localStorage.setItem('repociv:selected-repos:v1', JSON.stringify(SEED));
  });
  const page = await ctx.newPage();
  await page.goto(`${baseURL}/?cam=${cam}&freeze=${FREEZE}&reveal=all`, { waitUntil: 'domcontentloaded' });
  await page.locator('#loading-screen').waitFor({ state: 'hidden', timeout: 20_000 });
  if (await page.locator('#repo-onboarding').isVisible().catch(() => false)) {
    const next = page.locator('#repo-onboarding-next');
    await next.click();
    await page.locator('#repo-onboarding').waitFor({ state: 'hidden', timeout: 20_000 });
  }
  await page.waitForTimeout(4000);

  const png = await page.locator('#main-canvas').screenshot({ path: join(OUT, `${name}.png`) });
  await browser.close();
  return join(OUT, `${name}.png`);
}

async function main() {
  const shotPath = await captureAndAnalyse('auto,1.8', 'verify-city-walls-zoom18');
  const buf = readFileSync(shotPath);
  const { width, height, data } = decodePng(buf);
  const { N, counts } = countColors(data, width, height);
  const expected = { plaza: 100, spire: 3, wall: 100, landmark: 3, 'bld-cream': 100, roof: 30 };
  const per = {};
  for (const k of Object.keys(expected)) {
    per[k] = { found: counts[k], expected_min: expected[k], pass: counts[k] >= expected[k] };
  }
  const overall = Object.values(per).every(v => v.pass);
  const result = { shot: shotPath, width, height, N, per, verdict: overall ? 'pass' : 'fail' };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync(join(OUT, 'verify-city-walls.json'), JSON.stringify(result, null, 2));
  process.exit(overall ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
