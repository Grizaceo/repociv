#!/usr/bin/env node
/**
 * Take a 589x391 screenshot matching the user's clip exactly and compare
 * city-feature pixel counts. If the user's clip is "stale" (pre-fix),
 * the user's image will show 0 plaza+spire+landmark pixels, while our
 * fresh capture will show many.
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

// Standard PNG decode (RGB or RGBA)
function decodePng(buf) {
  let pos = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bd = data[8]; ct = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = ct === 2 ? 3 : 4;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const rs = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const l = x >= ch ? out[y * stride + x - ch] : 0;
      const u = y > 0 ? out[(y - 1) * stride + x] : 0;
      const ul = (y > 0 && x >= ch) ? out[(y - 1) * stride + x - ch] : 0;
      let v = raw[rs + x];
      if (f === 1) v = (v + l) & 0xff;
      else if (f === 2) v = (v + u) & 0xff;
      else if (f === 3) v = (v + ((l + u) >> 1)) & 0xff;
      else if (f === 4) {
        const p = l + u - ul;
        const pa = Math.abs(p - l), pb = Math.abs(p - u), pc = Math.abs(p - ul);
        const pred = pa <= pb && pa <= pc ? l : pb <= pc ? u : ul;
        v = (v + pred) & 0xff;
      }
      out[y * stride + x] = v;
    }
  }
  return { width: w, height: h, data: out, channels: ch };
}

function countByColor(arr, w, h, ch) {
  const T = [
    { r: 0xc9, g: 0xbf, b: 0xa6, label: 'plaza'    },
    { r: 0xe4, g: 0xdd, b: 0xca, label: 'spire'    },
    { r: 0xb0, g: 0xa8, b: 0x98, label: 'wall'     },
    { r: 0x9e, g: 0x5a, b: 0x45, label: 'roof'     },
    { r: 0xc8, g: 0xc0, b: 0xb0, label: 'bld'      },
    { r: 0xd9, g: 0xcc, b: 0xa2, label: 'obelisk'  },
  ];
  const counts = Object.fromEntries(T.map(t => [t.label, 0]));
  for (let i = 0; i < arr.length; i += 4) {
    const r = arr[i], g = arr[i + 1], b = arr[i + 2];
    for (const t of T) {
      if (Math.abs(r - t.r) <= 18 && Math.abs(g - t.g) <= 18 && Math.abs(b - t.b) <= 18) {
        counts[t.label]++; break;
      }
    }
  }
  return counts;
}

async function main() {
  const userPath = '/home/gris/.hermes/images/clip_20260615_185155_1.png';
  const userImg = decodePng(readFileSync(userPath));
  console.log(`User clip: ${userImg.width}x${userImg.height}`);
  const userCounts = countByColor(userImg.data, userImg.width, userImg.height, userImg.channels);
  console.log('User clip color counts:', userCounts);

  // Now take a fresh capture at the same dimensions.
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
  await page.goto(`${baseURL}/?cam=auto,1.8&freeze=2&reveal=all`, { waitUntil: 'domcontentloaded' });
  await page.locator('#loading-screen').waitFor({ state: 'hidden', timeout: 20_000 });
  if (await page.locator('#repo-onboarding').isVisible().catch(() => false)) {
    const next = page.locator('#repo-onboarding-next');
    await next.click();
    await page.locator('#repo-onboarding').waitFor({ state: 'hidden', timeout: 20_000 });
  }
  await page.waitForTimeout(5000);

  // Crop the center 589x391 to match the user's clip dimensions
  await page.screenshot({
    path: join(OUT, 'fresh-589x391.png'),
    clip: { x: 640 - 295, y: 360 - 196, width: 589, height: 391 },
  });
  await browser.close();

  const freshImg = decodePng(readFileSync(join(OUT, 'fresh-589x391.png')));
  console.log(`\nFresh capture: ${freshImg.width}x${freshImg.height}`);
  const freshCounts = countByColor(freshImg.data, freshImg.width, freshImg.height, freshImg.channels);
  console.log('Fresh capture color counts:', freshCounts);

  console.log('\nDifferential (fresh − user):');
  for (const k of Object.keys(userCounts)) {
    const d = freshCounts[k] - userCounts[k];
    console.log(`  ${k.padEnd(10)} user=${userCounts[k].toString().padStart(4)} fresh=${freshCounts[k].toString().padStart(4)} diff=${d >= 0 ? '+' : ''}${d}`);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
