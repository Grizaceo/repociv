#!/usr/bin/env node
/**
 * Walk the screenshot in a hex-grid sample pattern. For each sample, mark
 * which city-restoration colours it contains. Tells us if those colours
 * are clustered (cities look ordered) or scattered (cities look messy).
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

const COLOURS = [
  { r: 0xc9, g: 0xbf, b: 0xa6, label: 'plaza'    },
  { r: 0xe4, g: 0xdd, b: 0xca, label: 'spire'    },
  { r: 0xb0, g: 0xa8, b: 0x98, label: 'wall'     },
  { r: 0x9e, g: 0x5a, b: 0x45, label: 'roof'     },
  { r: 0xc8, g: 0xc0, b: 0xb0, label: 'bld'      },
  { r: 0xd9, g: 0xcc, b: 0xa2, label: 'obelisk'  },
];
const TOL = 18;

function decodePng(buf) {
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 2 ? 3 : 4;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = (y > 0 && x >= channels) ? out[(y - 1) * stride + x - channels] : 0;
      let v = raw[rowStart + x];
      if (filter === 1) v = (v + left) & 0xff;
      else if (filter === 2) v = (v + up) & 0xff;
      else if (filter === 3) v = (v + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        v = (v + pred) & 0xff;
      }
      out[y * stride + x] = v;
    }
  }
  return { width, height, data: out, channels };
}

function classify(px) {
  for (const c of COLOURS) {
    if (Math.abs(px[0] - c.r) <= TOL && Math.abs(px[1] - c.g) <= TOL && Math.abs(px[2] - c.b) <= TOL) {
      return c.label;
    }
  }
  return null;
}

async function main() {
  const shotPath = process.argv[2] ?? join(OUT, '02-zoomed-mid.png');
  const { width, height, data, channels } = decodePng(readFileSync(shotPath));

  // Sample on a 20x12 grid of cells. For each cell, count which city-
  // restoration colours are dominant.
  const cols = 32, rows = 18;
  const cellW = Math.floor(width / cols), cellH = Math.floor(height / rows);
  const grid = Array.from({ length: rows }, () => Array(cols).fill(null));
  const cellCounts = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const tally = {};
      let total = 0;
      for (let py = cy * cellH; py < (cy + 1) * cellH; py += 3) {
        for (let px = cx * cellW; px < (cx + 1) * cellW; px += 3) {
          const i = (py * width + px) * channels;
          const lbl = classify([data[i], data[i + 1], data[i + 2]]);
          if (lbl) tally[lbl] = (tally[lbl] ?? 0) + 1;
          total++;
        }
      }
      const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      grid[cy][cx] = best ? best[0] : '.';
      cellCounts.push({ cx, cy, total, best, tally });
    }
  }

  // Render a compact map. Width 32 chars.
  const lines = grid.map(row => row.map(v => {
    if (v === 'plaza') return 'P';
    if (v === 'spire') return 'S';
    if (v === 'wall') return 'W';
    if (v === 'roof') return 'R';
    if (v === 'bld') return 'B';
    if (v === 'obelisk') return 'O';
    return '.';
  }).join(' '));
  console.log('Map (cells=32x18, char=dominant city-restoration colour):');
  console.log(lines.join('\n'));
  console.log('Legend: P=plaza  S=spire  W=wall  R=roof  B=building  O=obelisk  .=other');

  // Cluster metric: count isolated vs grouped cells.
  let isolated = 0, grouped = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (grid[cy][cx] === '.') continue;
      let neighbours = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const ny = cy + dy, nx = cx + dx;
          if (ny >= 0 && ny < rows && nx >= 0 && nx < cols && grid[ny][nx] !== '.') neighbours++;
        }
      }
      if (neighbours >= 2) grouped++; else isolated++;
    }
  }
  const ratio = grouped / Math.max(1, grouped + isolated);
  console.log(`\nCluster: grouped=${grouped} isolated=${isolated} ratio=${ratio.toFixed(2)}`);
  console.log('ratio > 0.5 ⇒ city-restoration pixels are clustered (good).');
  console.log('ratio < 0.2 ⇒ city-restoration pixels are scattered (bad).');

  writeFileSync(join(OUT, 'cluster-map.json'), JSON.stringify({ grid, grouped, isolated, ratio }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(2); });
