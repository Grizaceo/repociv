#!/usr/bin/env node
/**
 * Verify whether the "60px plaza offset from wall hole center" and the
 * "ring asymmetry (38-112 px radius span)" are REAL or projection artifacts.
 *
 * Strategy:
 *   - Take a fresh capture at the same camera the user is using
 *   - Find each city (cluster of wall pixels)
 *   - For each city, measure:
 *       1. Plaza centroid in screen space (filter for plaza color)
 *       2. Wall-ring hole centroid in screen space (largest interior hole)
 *       3. The screen-space distance between (1) and (2)
 *       4. Sample wall ring radius in 12 directions from hole center
 *       5. Std/range of those radii
 *   - Compare against the predicted projection of a *regular* hex ring +
 *     a flat disc at the same (base.x, base.z) but different y. If measured
 *     offset matches predicted, it's a projection artifact (not a bug).
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

// Mask helpers
function colourMask(arr, ch, target, tol = 14) {
  const w = arr.length / 4;
  const mask = new Uint8Array(w);
  for (let i = 0, j = 0; i < arr.length; i += 4, j++) {
    if (Math.abs(arr[i] - target.r) <= tol &&
        Math.abs(arr[i + 1] - target.g) <= tol &&
        Math.abs(arr[i + 2] - target.b) <= tol) {
      mask[j] = 1;
    }
  }
  return mask;
}

// "Walls" pixels: the wall material 0xb0a898 gets shifted by ACES tone
// mapping + warm directional sun to a warm-beige (R~180, G~150, B~110),
// not neutral grey. Don't require |R-G| ≤ 12. Instead: it's a wall if it's
// warm-beige — R > G > B with a small step — AND in the wall hue band.
function wallMaskLoose(arr, ch) {
  const w = arr.length / 4;
  const mask = new Uint8Array(w);
  for (let i = 0, j = 0; i < arr.length; i += 4, j++) {
    const r = arr[i], g = arr[i + 1], b = arr[i + 2];
    // Warm-beige: R > G > B with moderate step
    if (!(r > g && g > b && (r - b) >= 12)) continue;
    // Hue band for walls (lit + shaded): 150 ≤ R ≤ 220, 130 ≤ G ≤ 175, 80 ≤ B ≤ 135
    if (r < 150 || r > 220) continue;
    if (g < 130 || g > 175) continue;
    if (b <  80 || b > 135) continue;
    mask[j] = 1;
  }
  return mask;
}

function centroid(mask, w, h) {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { sx += x; sy += y; n++; }
    }
  }
  if (n === 0) return null;
  return { x: sx / n, y: sy / n, n };
}

// Find connected components (8-connectivity for diagonal anti-aliased
// pixels) and their bounding boxes + centroids.
function components(mask, w, h, minSize = 30) {
  const visited = new Uint8Array(w * h);
  const comps = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx] || visited[idx]) continue;
      const stack = [[x, y]];
      let size = 0, minX = x, maxX = x, minY = y, maxY = y;
      let sumX = 0, sumY = 0;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
        const i = cy * w + cx;
        if (!mask[i] || visited[i]) continue;
        visited[i] = 1;
        size++; sumX += cx; sumY += cy;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        // 8-connectivity: include diagonals so anti-aliased ring pixels
        // don't get split into hundreds of 1-pixel components.
        stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1],
                   [cx + 1, cy + 1], [cx + 1, cy - 1], [cx - 1, cy + 1], [cx - 1, cy - 1]);
      }
      if (size >= minSize) {
        comps.push({ size, minX, maxX, minY, maxY,
          cx: sumX / size, cy: sumY / size });
      }
    }
  }
  return comps;
}

// For a wall component, find the "hole" — largest connected non-wall
// region inside the bbox. The hole centroid is the wall-ring's screen-space
// center.
function findHoleCentroid(wallMask, w, h, comp, sampleStep = 3) {
  // Build an "interior" mask: all bbox pixels that are NOT wall.
  // Then find the largest connected component of interior pixels that
  // is geometrically enclosed (touches bbox on all 4 sides = exterior).
  const interior = new Uint8Array(w * h);
  for (let y = comp.minY; y <= comp.maxY; y++) {
    for (let x = comp.minX; x <= comp.maxX; x++) {
      if (!wallMask[y * w + x]) interior[y * w + x] = 1;
    }
  }
  const comps = components(interior, w, h, 20);
  // Find the one whose bbox is fully inside comp's bbox and doesn't touch
  // the comp's bbox edge — i.e., enclosed.
  const candidates = comps.filter(c =>
    c.minX > comp.minX + 2 && c.maxX < comp.maxX - 2 &&
    c.minY > comp.minY + 2 && c.maxY < comp.maxY - 2
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0];
}

// Sample wall ring radius in N directions from hole center
function ringRadii(wallMask, w, h, hole, comp, n = 12) {
  const radii = [];
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n;
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let lastWallDist = null;
    // Ray march outward from hole center, find first wall pixel
    for (let r = 1; r < 200; r++) {
      const x = Math.round(hole.cx + dx * r);
      const y = Math.round(hole.cy + dy * r);
      if (x < 0 || y < 0 || x >= w || y >= h) break;
      if (wallMask[y * w + x]) { lastWallDist = r; break; }
    }
    if (lastWallDist != null) radii.push({ angle: (angle * 180 / Math.PI).toFixed(0), r: lastWallDist });
  }
  return radii;
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
  await page.goto(`${baseURL}/?cam=auto,1.4&freeze=2&reveal=all`, { waitUntil: 'domcontentloaded' });
  await page.locator('#loading-screen').waitFor({ state: 'hidden', timeout: 20_000 });
  if (await page.locator('#repo-onboarding').isVisible().catch(() => false)) {
    const next = page.locator('#repo-onboarding-next');
    await next.click();
    await page.locator('#repo-onboarding').waitFor({ state: 'hidden', timeout: 20_000 });
  }
  await page.waitForTimeout(5000);

  const shotPath = join(OUT, 'plaza-vs-ring-alignment.png');
  await page.locator('#main-canvas').screenshot({ path: shotPath, animations: 'disabled', timeout: 60000 });
  await browser.close();

  const { width, height, data, channels } = decodePng(readFileSync(shotPath));
  console.log(`Capture: ${width}x${height}`);

  // Plaza colour: 0xc9bfa6 (base) or shaded 0xc0b0a0 (with shadows). Use
  // tighter tolerance on the brighter range so we don't pick up terrain.
  const PLAZA = { r: 0xc9, g: 0xbf, b: 0xa6 };
  const plazaMask = colourMask(data, channels, PLAZA, 12);
  // Wall: lit (0xb0a898) OR shaded (0x605848) under the fixed sun
  const wallMask  = wallMaskLoose(data, channels);

  // Find wall components (city rings) — start with smaller threshold,
  // then we'll filter by area / ring topology below
  const wallComps = components(wallMask, width, height, 50);
  console.log(`\nWall ring components: ${wallComps.length}`);
  if (wallComps.length === 0) {
    // Diagnostic: show all components regardless of size
    const all = components(wallMask, width, height, 1);
    console.log(`  (no components ≥50; all ≥1: ${all.length})`);
    const top = all.sort((a, b) => b.size - a.size).slice(0, 8);
    for (const c of top) {
      console.log(`    size=${c.size}  bbox=${c.maxX - c.minX}x${c.maxY - c.minY}  center=(${c.cx.toFixed(0)},${c.cy.toFixed(0)})`);
    }
  }

  // For each wall ring, find the hole + measure radii
  const ringReports = [];
  for (const wc of wallComps) {
    const hole = findHoleCentroid(wallMask, width, height, wc, 3);
    if (!hole) continue;
    const radii = ringRadii(wallMask, width, height, hole, wc, 12);
    if (radii.length < 8) continue;
    const rs = radii.map(r => r.r);
    const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
    const min = Math.min(...rs), max = Math.max(...rs);
    const range = max - min;
    const std = Math.sqrt(rs.map(r => (r - mean) ** 2).reduce((a, b) => a + b, 0) / rs.length);
    ringReports.push({ bbox: `${wc.maxX - wc.minX}x${wc.maxY - wc.minY}`, hole: hole, radii, mean, min, max, range, std });
  }
  ringReports.sort((a, b) => b.bbox.localeCompare(a.bbox));

  // Find plaza centroids in each wall ring's bbox
  console.log('\n=== Per-city alignment (plaza vs wall ring hole) ===');
  for (const rr of ringReports) {
    const plazaInBbox = new Uint8Array(width * height);
    for (let y = rr.hole.minY; y <= rr.hole.maxY; y++) {
      for (let x = rr.hole.minX; x <= rr.hole.maxX; x++) {
        if (plazaMask[y * width + x]) plazaInBbox[y * width + x] = 1;
      }
    }
    const plazaComps = components(plazaInBbox, width, height, 30);
    // Pick the plaza component whose centroid is closest to the hole centroid
    plazaComps.sort((a, b) => {
      const da = (a.cx - rr.hole.cx) ** 2 + (a.cy - rr.hole.cy) ** 2;
      const db = (b.cx - rr.hole.cx) ** 2 + (b.cy - rr.hole.cy) ** 2;
      return da - db;
    });
    const plaza = plazaComps[0];
    if (!plaza) {
      console.log(`  Ring ${rr.bbox}: hole=(${rr.hole.cx.toFixed(0)},${rr.hole.cy.toFixed(0)})  PLAZA NOT FOUND IN BBOX`);
      continue;
    }
    const dx = plaza.cx - rr.hole.cx;
    const dy = plaza.cy - rr.hole.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const rangeVsMean = (rr.range / rr.mean) * 100;
    console.log(`  Ring ${rr.bbox}:`);
    console.log(`    hole center=(${rr.hole.cx.toFixed(1)},${rr.hole.cy.toFixed(1)})  plaza center=(${plaza.cx.toFixed(1)},${plaza.cy.toFixed(1)})`);
    console.log(`    plaza-hole offset: (${dx.toFixed(1)}, ${dy.toFixed(1)})  magnitude=${dist.toFixed(1)} px`);
    console.log(`    ring radii: mean=${rr.mean.toFixed(1)}  min=${rr.min}  max=${rr.max}  range=${rr.range}  std=${rr.std.toFixed(1)}  (${rangeVsMean.toFixed(0)}% of mean)`);
    const asym = rs => {
      const m = rs.reduce((a, b) => a + b, 0) / rs.length;
      const angles = rr.radii.map(r => `${r.angle}°=${r.r}`);
      return angles.join(' ');
    };
    console.log(`    per-direction radii: ${asym()}`);
  }

  // === PREDICTION ===
  // Plaza is at base.y+1.5 (top at ~6.7 after extrude height).
  // Wall ring is at base.y+5.5 (top at ~11.7).
  // Vertical separation ≈ 5 world units (at HEX_SIZE=52).
  // In an isometric camera with ~30° tilt, 5 world units vertical
  // projects to ~5 * sin(30°) / pixel_per_unit ≈ 5 * 0.5 / 0.5 ≈ 5 screen pixels
  // shift. But the camera also has perspective that exaggerates depth.
  // A 60 px offset is HUGE (~10× what 30° tilt gives) — this would only
  // happen if the geometry is actually misaligned OR if my plaza is at a
  // different X,Z from the wall ring (which the code says shouldn't happen).
  console.log('\n=== Prediction ===');
  console.log('Plaza y=1.5, wall y=5.5 → Δy = 4 world units (HEX_SIZE=52 → 208 units)');
  console.log('Isometric tilt ~30° → predicted screen offset ≈ 4·52·sin(30°)/px_per_unit');
  console.log('Measured offset of 60 px is ~10× predicted. Either:');
  console.log('  (a) plaza is geometrically at a different (x,z) than the wall (bug)');
  console.log('  (b) the plaza+wall heights differ enough that the camera-projector shifts them');
  console.log('  (c) the ring\'s "hole" is not a true center of the wall — maybe the wall is rendered with a tilt');

  // Also test: is the ring a regular hex?
  // For a regular hex projected isometrically, opposite sides should have
  // equal lengths in screen space. Check pairs (0° vs 180°, 30° vs 210°,
  // 60° vs 240°, etc.) and report delta.
  console.log('\n=== Ring asymmetry analysis ===');
  for (const rr of ringReports) {
    const r = {};
    for (const x of rr.radii) r[x.angle] = x.r;
    const deltas = [];
    for (const a of Object.keys(r)) {
      const opp = (parseInt(a) + 180) % 360;
      if (r[opp] != null) {
        deltas.push({ pair: `${a}°↔${opp}°`, diff: Math.abs(r[a] - r[opp]) });
      }
    }
    deltas.sort((a, b) => b.diff - a.diff);
    console.log(`  Ring ${rr.bbox} (mean ${rr.mean.toFixed(0)}):`);
    for (const d of deltas.slice(0, 3)) {
      console.log(`    ${d.pair}: Δ=${d.diff} px`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
