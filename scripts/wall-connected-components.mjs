#!/usr/bin/env node
/**
 * Take a full-screen fresh capture and count connected components of
 * wall-colored pixels per city. If the fix worked, each city should have
 * ONE large wall component (the ring) instead of 6 small disconnected
 * ones.
 */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { execSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const OUT = join(REPO_ROOT, '.hermes/artifacts/3d-audit');
mkdirSync(OUT, { recursive: true });

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5273';

function decodePng(buf) {
  let pos = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
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

function countComponents(mask, w, h) {
  // Simple flood-fill BFS
  const visited = new Uint8Array(w * h);
  const comps = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x] || visited[y * w + x]) continue;
      const stack = [[x, y]];
      let size = 0, minX = x, maxX = x, minY = y, maxY = y;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
        const idx = cy * w + cx;
        if (!mask[idx] || visited[idx]) continue;
        visited[idx] = 1;
        size++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
      }
      if (size >= 30) comps.push({ size, minX, maxX, minY, maxY });
    }
  }
  return comps;
}

async function main() {
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

  // Full canvas shot
  const shotPath = join(OUT, 'fresh-1280x720-after-fix.png');
  await page.locator('#main-canvas').screenshot({ path: shotPath });
  await browser.close();

  const { width, height, data, channels } = decodePng(readFileSync(shotPath));

  // Wall mask: 0xb0a898 ± 14
  const wallR = 0xb0, wallG = 0xa8, wallB = 0x98;
  const wallMask = new Uint8Array(width * height);
  let wallPx = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - wallR) <= 14 && Math.abs(data[i + 1] - wallG) <= 14 && Math.abs(data[i + 2] - wallB) <= 14) {
      wallMask[Math.floor(i / 4)] = 1;
      wallPx++;
    }
  }
  const comps = countComponents(wallMask, width, height);
  comps.sort((a, b) => b.size - a.size);

  console.log(`Wall pixels: ${wallPx}`);
  console.log(`Connected components of wall colour (size ≥ 30): ${comps.length}`);
  for (const c of comps.slice(0, 20)) {
    const w = c.maxX - c.minX;
    const h = c.maxY - c.minY;
    console.log(`  size=${c.size.toString().padStart(5)}  bbox=${w}x${h}  center=(${(c.minX+c.maxX)/2|0},${(c.minY+c.maxY)/2|0})`);
  }

  console.log('\n--- User\'s previous clip (8 sub-clusters was the bug) ---');
  const userPath = '/home/gris/.hermes/images/clip_20260615_185155_1.png';
  const userImg = decodePng(readFileSync(userPath));
  const userWallMask = new Uint8Array(userImg.width * userImg.height);
  let userWallPx = 0;
  for (let i = 0; i < userImg.data.length; i += 4) {
    if (Math.abs(userImg.data[i] - wallR) <= 14 && Math.abs(userImg.data[i + 1] - wallG) <= 14 && Math.abs(userImg.data[i + 2] - wallB) <= 14) {
      userWallMask[Math.floor(i / 4)] = 1;
      userWallPx++;
    }
  }
  const userComps = countComponents(userWallMask, userImg.width, userImg.height);
  console.log(`User clip wall pixels: ${userWallPx}`);
  console.log(`User clip connected components (size ≥ 30): ${userComps.length}`);
  for (const c of userComps.slice(0, 20)) {
    const w = c.maxX - c.minX;
    const h = c.maxY - c.minY;
    console.log(`  size=${c.size.toString().padStart(5)}  bbox=${w}x${h}  center=(${(c.minX+c.maxX)/2|0},${(c.minY+c.maxY)/2|0})`);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
