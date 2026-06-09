#!/usr/bin/env node
/**
 * Generate procedural office-atlas.webp (or .png fallback) without native deps.
 * Uses a minimal PNG encoder (RGBA) — convert to webp via Pillow if available.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'assets');
const CELL_W = 128;
const CELL_H = 64;
const COLS = 5;
const ROWS = 3;
const W = COLS * CELL_W;
const H = ROWS * CELL_H;

const SPRITES = [
  { col: 0, row: 0, primary: [176, 144, 96], accent: [208, 208, 208] },
  { col: 1, row: 0, primary: [176, 144, 96], accent: [208, 208, 208] },
  { col: 2, row: 0, primary: [176, 128, 144], accent: null },
  { col: 3, row: 0, primary: [168, 176, 192], accent: null },
  { col: 4, row: 0, primary: [152, 168, 184], accent: null },
  { col: 0, row: 1, primary: [196, 168, 128], accent: [216, 220, 224] },
  { col: 1, row: 1, primary: [176, 200, 224], accent: [232, 240, 255] },
  { col: 2, row: 1, primary: [96, 136, 96], accent: [144, 176, 144] },
  { col: 3, row: 1, primary: [232, 232, 232], accent: [74, 144, 212] },
  { col: 4, row: 1, primary: [240, 232, 208], accent: [255, 248, 224] },
  { col: 0, row: 2, primary: [154, 138, 122], accent: null },
];

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function setPixel(buf, x, y, r, g, b, a = 255) {
  const i = (y * W + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

function fillRect(buf, x0, y0, x1, y1, [r, g, b]) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x >= 0 && x < W && y >= 0 && y < H) setPixel(buf, x, y, r, g, b);
    }
  }
}

function drawSprite(buf, spec) {
  const x0 = spec.col * CELL_W;
  const y0 = spec.row * CELL_H;
  fillRect(buf, x0, y0, x0 + CELL_W, y0 + CELL_H, [42, 42, 46]);
  const cx = x0 + CELL_W / 2;
  const cy = y0 + CELL_H / 2;
  const p = spec.primary;
  const a = spec.accent;
  if (a) {
    fillRect(buf, cx - 40, cy - 4, cx + 40, cy + 12, p);
    fillRect(buf, cx - 22, cy - 28, cx + 22, cy - 10, a);
    fillRect(buf, cx - 18, cy - 26, cx + 18, cy - 12, [26, 32, 48]);
  } else if (p[0] === 176 && p[1] === 128) {
    fillRect(buf, cx - 18, cy - 4, cx + 18, cy + 16, p);
  } else if (p[0] >= 150 && p[0] <= 175) {
    fillRect(buf, x0 + 20, y0 + 18, x0 + CELL_W - 20, y0 + CELL_H - 18, p);
  } else if (p[0] === 96) {
    fillRect(buf, cx - 14, cy + 4, cx + 14, cy + 20, [139, 115, 85]);
    fillRect(buf, cx - 20, cy - 18, cx + 20, cy + 6, p);
  } else if (p[0] === 176 && p[1] === 200) {
    fillRect(buf, cx - 12, cy - 16, cx + 12, cy + 18, p);
  } else if (p[0] === 232) {
    fillRect(buf, x0 + 16, y0 + 12, x0 + CELL_W - 16, y0 + CELL_H - 12, p);
    fillRect(buf, x0 + 32, y0 + 20, x0 + CELL_W - 32, y0 + CELL_H - 20, spec.accent ?? [74, 144, 212]);
  } else if (p[0] === 240) {
    fillRect(buf, cx - 28, cy - 10, cx + 28, cy + 18, a ?? [255, 248, 224]);
    fillRect(buf, cx - 12, cy - 4, cx + 12, cy + 10, [255, 232, 160]);
  } else {
    fillRect(buf, x0 + 8, y0 + 8, x0 + CELL_W - 8, y0 + CELL_H - 8, p);
  }
}

function encodePng(rgba) {
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 4);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rgba = Buffer.alloc(W * H * 4);
for (const s of SPRITES) drawSprite(rgba, s);
const pngPath = join(OUT_DIR, 'office-atlas.png');
const webpPath = join(OUT_DIR, 'office-atlas.webp');
writeFileSync(pngPath, encodePng(rgba));
console.log(`Wrote ${pngPath}`);

const py = spawnSync('python3', ['-c', `
from PIL import Image
img = Image.open("${pngPath.replace(/\\/g, '/')}")
img.save("${webpPath.replace(/\\/g, '/')}", "WEBP", quality=90)
print("webp ok")
`], { encoding: 'utf8' });

if (py.status === 0) {
  console.log(`Wrote ${webpPath}`);
} else {
  console.warn('Pillow unavailable — using PNG; update office-atlas.json atlas path to .png');
  if (!existsSync(webpPath)) {
    writeFileSync(webpPath, encodePng(rgba));
    console.log(`Wrote ${webpPath} (PNG bytes with .webp extension — browsers still decode)`);
  }
}
