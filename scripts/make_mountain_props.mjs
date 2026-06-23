#!/usr/bin/env node
// ─── No-blender producer for the low-poly mountain props ─────────────────────
// Regenerates public/assets/3d/props/mountain-{0,1,2}.glb without a Blender
// install, using three.js' own GLTFExporter (the same library the runtime
// loads them with). Replaces the smooth 7-gon cones from make_props.py with
// craggy, flat-shaded, snow-capped peaks in the iter13 relief style (hills and
// dunes already use faceted low-poly crags; the mountains had been left on the
// old smooth silhouette and read as pale paper cones — see issue: "snow
// mountains look sloppy").
//
// Determinism contract (same spirit as make_props.py):
//   - All jitter comes from an explicit mulberry32 PRNG seeded per peak. No
//     Math.random, no timestamps → same input, same bytes.
//   - Geometry is built non-indexed so each triangle carries its own face
//     normal (flat shading) and a single flat face colour (snow or rock).
//
// Model space (consumed by src/three/MountainProps3D.ts):
//   - Y-up, footprint radius ~1.0, peak heights ~1.05–1.90. The renderer
//     scales uniformly by ~0.40·HEX_SIZE and lifts +1.5 in Y, so the base
//     (y=0) sits on the tile top face. Heights match make_props.py's VARIANTS
//     so the on-map scale is unchanged.
//
// Run:  node scripts/make_mountain_props.mjs
import {
  BufferGeometry,
  BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  Scene,
} from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Minimal FileReader polyfill so GLTFExporter's binary path runs in Node ────
// (it only ever calls readAsArrayBuffer on a Blob, then reads .result on
// onloadend). Node 22 already exposes Blob with .arrayBuffer().
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob
        .arrayBuffer()
        .then((buf) => {
          this.result = buf;
          this.onloadend?.();
        })
        .catch((err) => this.onerror?.(err));
    }
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'public', 'assets', '3d', 'props');
const MAX_TRIS = 300;

// Peak layout per variant: [cx, cz, radius, height, seed] — mirrors the
// make_props.py VARIANTS so placement/scale stays identical on the map.
const VARIANTS = [
  // 0 — single tall spire
  [[0.0, 0.0, 1.0, 1.9, 11]],
  // 1 — twin peak
  [
    [-0.22, 0.1, 0.85, 1.7, 23],
    [0.52, -0.3, 0.55, 1.05, 37],
  ],
  // 2 — broad massif, 3 bumps
  [
    [-0.4, -0.15, 0.7, 1.15, 53],
    [0.3, 0.05, 0.8, 1.45, 67],
    [0.05, 0.55, 0.5, 0.85, 79],
  ],
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One faceted spire as an indexed (verts, faces) pair in model space (Y up,
// base at y=0). n radial segments × 4 rings + apex + base cap, with strong
// per-vertex radial/angular/vertical jitter and a few jutting ridge sectors so
// the silhouette is jagged rather than a smooth cone.
function buildPeak(cx, cz, radius, height, seed) {
  const rng = mulberry32(seed);
  const n = 9;
  const ringsT = [0.0, 0.3, 0.55, 0.78];
  const ringR = [1.0, 0.66, 0.4, 0.2];
  const phase = rng() * Math.PI * 2;

  // Per-sector radial multiplier → some directions jut out as ridge arms.
  const ridge = [];
  for (let k = 0; k < n; k++) ridge.push(0.82 + rng() * 0.5);

  const verts = [];
  for (let ri = 0; ri < ringsT.length; ri++) {
    const t = ringsT[ri];
    const y = t * height;
    for (let k = 0; k < n; k++) {
      const ang = phase + (Math.PI * 2 * k) / n + (rng() - 0.5) * 0.18;
      const ridgeMul = 1 + (ridge[k] - 1) * (1 - t * 0.6); // fades toward apex
      const rad = radius * ringR[ri] * ridgeMul * (1 + (rng() - 0.5) * 0.28);
      const yy = ri === 0 ? 0.0 : y + (rng() - 0.5) * height * 0.06;
      verts.push([cx + rad * Math.cos(ang), yy, cz + rad * Math.sin(ang)]);
    }
  }
  const apex = verts.length;
  verts.push([cx + (rng() - 0.5) * radius * 0.14, height, cz + (rng() - 0.5) * radius * 0.14]);
  const baseC = verts.length;
  verts.push([cx, 0.0, cz]);

  const faces = [];
  for (let ring = 0; ring < ringsT.length - 1; ring++) {
    const a0 = ring * n;
    const b0 = (ring + 1) * n;
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      faces.push([a0 + k, b0 + k2, a0 + k2]);
      faces.push([a0 + k, b0 + k, b0 + k2]);
    }
  }
  const top0 = (ringsT.length - 1) * n;
  for (let k = 0; k < n; k++) faces.push([top0 + k, apex, top0 + ((k + 1) % n)]);
  for (let k = 0; k < n; k++) faces.push([baseC, (k + 1) % n, k]);

  return { verts, faces, seed, height };
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Build a non-indexed BufferGeometry from one variant's peaks: each triangle
// gets its own 3 verts, a baked flat face normal, and one flat face colour.
function buildVariantGeometry(peaks) {
  const positions = [];
  const normals = [];
  const colors = [];
  let triCount = 0;

  for (const { verts, faces, seed, height } of peaks) {
    const cx = verts[verts.length - 1][0];
    const cz = verts[verts.length - 1][2];
    // Interior reference point: a star-convex peak is outward-consistent from
    // a point on its axis, so we can fix winding without per-face reasoning.
    const ref = [cx, height * 0.42, cz];
    const cRng = mulberry32((seed * 2654435761) >>> 0);

    for (const f of faces) {
      let [i0, i1, i2] = f;
      const p0 = verts[i0];
      const p1 = verts[i1];
      const p2 = verts[i2];
      const centroid = [(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3, (p0[2] + p1[2] + p2[2]) / 3];
      let nrm = norm(cross(sub(p1, p0), sub(p2, p0)));
      // Flip winding if the face normal points inward.
      if (dot(nrm, sub(centroid, ref)) < 0) {
        [i1, i2] = [i2, i1];
        nrm = [-nrm[0], -nrm[1], -nrm[2]];
      }
      const a = verts[i0];
      const b = verts[i1];
      const c = verts[i2];

      const cy = clamp01(centroid[1] / height);
      const ang = Math.atan2(centroid[2] - cz, centroid[0] - cx);
      // Wavy snow line (≈0.30–0.62) so snow doesn't read as a flat band.
      const snowLine = 0.46 + 0.16 * Math.sin(ang * 3 + seed * 0.7);
      const isApexFace = i0 >= verts.length - 2 || i1 >= verts.length - 2 || i2 >= verts.length - 2;

      let col;
      if ((cy > snowLine || (isApexFace && centroid[1] > 0.4 * height)) && centroid[1] > 0.12 * height) {
        // Snow: bright, faintly cool, slight per-face variation.
        const v = 0.9 + cRng() * 0.08;
        col = [clamp01(v * 0.97), clamp01(v * 0.99), clamp01(v)];
      } else {
        // Warm grey-brown rock: darker in crevices, brighter on sun/up faces,
        // enough contrast with the snow that the cap reads as a cap.
        const shade = clamp01(0.34 + 0.5 * Math.max(0, nrm[1]) + 0.28 * (cRng() - 0.5));
        const lo = [0.3, 0.27, 0.24];
        const hi = [0.5, 0.45, 0.4];
        col = [lo[0] + (hi[0] - lo[0]) * shade, lo[1] + (hi[1] - lo[1]) * shade, lo[2] + (hi[2] - lo[2]) * shade];
      }

      for (const p of [a, b, c]) {
        positions.push(p[0], p[1], p[2]);
        normals.push(nrm[0], nrm[1], nrm[2]);
        colors.push(col[0], col[1], col[2]);
      }
      triCount++;
    }
  }

  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geom.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geom.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  return { geom, triCount };
}

async function exportGLB(scene) {
  const exporter = new GLTFExporter();
  return await new Promise((resolveP, rejectP) => {
    exporter.parse(
      scene,
      (result) => resolveP(Buffer.from(result)),
      (err) => rejectP(err),
      { binary: true },
    );
  });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  let totalBytes = 0;
  for (let vi = 0; vi < VARIANTS.length; vi++) {
    const peaks = VARIANTS[vi].map((p) => buildPeak(...p));
    const { geom, triCount } = buildVariantGeometry(peaks);
    if (triCount > MAX_TRIS) {
      throw new Error(`variant ${vi}: ${triCount} tris > ${MAX_TRIS}`);
    }
    const mat = new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.0,
      flatShading: true,
    });
    mat.name = `mountain-rock-${vi}`;
    const mesh = new Mesh(geom, mat);
    mesh.name = `mountain-${vi}`;
    const scene = new Scene();
    scene.add(mesh);
    const buf = await exportGLB(scene);
    const out = resolve(OUT_DIR, `mountain-${vi}.glb`);
    writeFileSync(out, buf);
    totalBytes += buf.length;
    console.log(`[OK] mountain-${vi}.glb: ${triCount} tris, ${buf.length} bytes`);
  }
  console.log(`[OK] props total (mountains): ${totalBytes} bytes`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
