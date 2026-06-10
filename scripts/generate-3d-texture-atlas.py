#!/usr/bin/env python3
"""Reproducible terrain texture + normal-map + roughness atlas for RepoCiv 3D global map.
Runs standalone with Python + numpy + PIL (no Blender required).
Expects to be run from the repo root; writes to public/assets/3d/.

Produces:
  terrain-atlas-3d.png         — colour atlas  (9 terrains × 1024px, 4×3 grid)
  terrain-normal-atlas-3d.png — tangent-space normal atlas (same layout)
  terrain-roughness-atlas-3d.png — roughness atlas (single channel, greyscale)
  terrain-atlas-3d.json      — atlas metadata

v6: standalone PIL output — removed Blender dependency while keeping full vectorised generation.
"""
import json
from pathlib import Path
import numpy as np

try:
    from PIL import Image
except ImportError:
    raise SystemExit("Pillow is required: pip install Pillow")

CELL = 1024
COLS = 4
ROWS = 3
OUT  = Path('public/assets/3d')
OUT.mkdir(parents=True, exist_ok=True)

TERRAINS = [
    ('plains',   (0.42, 0.74, 0.26)),  # warmer, more saturated green
    ('forest',   (0.12, 0.42, 0.14)),  # deep green but not black
    ('mountain', (0.44, 0.42, 0.40)),  # darker rock base for stronger contrast
    ('desert',   (0.84, 0.64, 0.32)),  # warmer sand, less harsh orange
    ('ocean',    (0.08, 0.40, 0.58)),  # teal base, Civ V coastal tone
    ('ice',      (0.70, 0.88, 0.96)),  # cooler ice with more blue
    ('hills',    (0.52, 0.68, 0.28)),  # earthier olive-green
    ('sacred',   (0.12, 0.04, 0.28)),
    ('fog',      (0.04, 0.04, 0.09)),
]

ROUGHNESS = {
    'plains':   0.82,
    'forest':   0.75,
    'mountain': 0.92,
    'desert':   0.88,
    'ocean':    0.18,
    'ice':      0.22,
    'hills':    0.78,
    'sacred':   0.45,
    'fog':      0.95,
}

# ── Vectorised noise primitives (operate on full 2-D arrays) ─────────────────

def hash_np(x, y, seed: int):
    n = np.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453
    return n - np.floor(n)


def smooth_noise_np(x, y, seed: int):
    ix = np.floor(x).astype(np.float64)
    iy = np.floor(y).astype(np.float64)
    fx = x - ix
    fy = y - iy
    ux = fx * fx * (3.0 - 2.0 * fx)
    uy = fy * fy * (3.0 - 2.0 * fy)
    a = hash_np(ix,     iy,     seed)
    b = hash_np(ix + 1, iy,     seed)
    c = hash_np(ix,     iy + 1, seed)
    d = hash_np(ix + 1, iy + 1, seed)
    return a + (b - a) * ux + (c - a) * uy + (b - a + d - c - b + a) * ux * uy


def fbm_np(x, y, seed: int, octaves: int = 5):
    val  = np.zeros_like(x)
    amp, freq, norm = 0.5, 1.0, 0.0
    for _ in range(octaves):
        val  += amp * smooth_noise_np(x * freq, y * freq, seed)
        norm += amp
        amp  *= 0.5
        freq *= 2.0
    return val / norm


def voronoi_dist_np(x, y, seed: int):
    """Approximate Voronoi distance (vectorised). Returns (dist, cell_id) arrays."""
    ix = np.floor(x).astype(np.float64)
    iy = np.floor(y).astype(np.float64)
    min_dist = np.full_like(x, 1e9)
    cell_id  = np.zeros_like(x, dtype=np.float64)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            cx = ix + dx + hash_np(ix + dx, iy + dy, seed)
            cy = iy + dy + hash_np(ix + dx, iy + dy, seed + 7)
            d  = np.hypot(x - cx, y - cy)
            closer = d < min_dist
            min_dist = np.where(closer, d, min_dist)
            cid = np.floor(hash_np(cx, cy, seed + 13) * 997)
            cell_id = np.where(closer, cid, cell_id)
    return min_dist, cell_id


def clamp01(a):
    return np.clip(a, 0.0, 1.0)


# ── Per-terrain colour (vectorised) ─────────────────────────────────────────

def terrain_rgb_np(name: str, base: tuple, U, V, seed: int):
    r0, g0, b0 = base
    n  = fbm_np(U * 6,  V * 6,  seed,      5)
    n2 = fbm_np(U * 18, V * 18, seed + 13, 3)
    n3 = fbm_np(U * 40, V * 40, seed + 29, 2)

    if name == 'plains':
        grass  = 0.12 * (n - 0.5) + 0.05 * (n2 - 0.5)
        dry    = np.maximum(0.0, n3 - 0.55) * 0.50
        stripe = 0.035 * np.sin(V * 28 + seed)
        vd, vid = voronoi_dist_np(U * 8, V * 8, seed + 41)
        # Yellow flowers
        yf = np.where((vd < 0.12) & ((vid.astype(int) % 3) == 0),
                      1.0 - (vd / 0.12), 0.0)
        # White flowers
        wf = np.where((vd < 0.10) & ((vid.astype(int) % 3) == 1),
                      1.0 - (vd / 0.10), 0.0)
        R = r0 + dry * 0.40 + stripe + yf * 0.32 + wf * 0.28
        G = g0 + grass + dry * 0.12 + stripe + yf * 0.26 + wf * 0.28
        B = b0 + grass * 0.25 + yf * 0.04 + wf * 0.26
        return R, G, B

    if name == 'forest':
        forest_type = seed % 2
        if forest_type == 0:
            canopy  = 0.16 * (n - 0.5) + 0.10 * (n2 - 0.5)
            clearing = np.maximum(0.0, 0.55 - n) * 0.28
            return (r0 + clearing * 0.45 + 0.02,
                    g0 + canopy + clearing * 0.40 + 0.03,
                    b0 + canopy * 0.5 + clearing * 0.12 + 0.01)
        else:
            canopy   = 0.12 * (n - 0.5) + 0.14 * np.maximum(0.0, n2 - 0.4) * 0.5
            leaf_var = 0.10 * np.sin(U * 25 + V * 18 + seed)
            return (r0 + canopy * 0.55 + leaf_var * 0.35 + 0.02,
                    g0 + canopy * 1.3 + leaf_var * 0.45 + 0.04,
                    b0 + canopy * 0.45 + leaf_var * 0.12 + 0.02)

    if name == 'mountain':
        dist    = np.hypot(U - 0.5, V - 0.5) * 2.0
        strata  = 0.14 * np.sin(dist * 55 + n * 4 + seed) + 0.07 * (n2 - 0.5)
        snow_t  = np.where(dist < 0.24, 1.0, np.maximum(0.0, (0.40 - dist) / 0.16))
        volcanic = np.maximum(0.0, (dist - 0.72) / 0.28)
        rock    = 0.10 * (n - 0.5) + strata
        # Darker rock with warm shadow
        br      = (r0 + rock - 0.02) * (1.0 - volcanic * 0.25)
        bg      = (g0 + rock - 0.02) * (1.0 - volcanic * 0.20)
        bb      = (b0 + rock - 0.02) * (1.0 - volcanic * 0.15)
        # Snow: creamy white with slight blue shadow, not pure white
        return (br + (0.92 - br) * snow_t,
                bg + (0.94 - bg) * snow_t,
                bb + (0.98 - bb) * snow_t)

    if name == 'desert':
        dune_raw = np.sin(U * 22 + V * 6 + seed) + 0.6 * np.sin(U * 9 - V * 14)
        dune     = 0.18 * dune_raw
        grain    = 0.05 * (n3 - 0.5)
        warm     = 0.05 * (1 - V)
        shadow   = -0.03 * np.minimum(0.0, dune_raw)
        return (r0 + dune + warm + grain + shadow * 0.5,
                g0 + dune * 0.65 + grain * 0.5 + shadow * 0.3,
                b0 + dune * 0.25 + shadow * 0.15)

    if name == 'ocean':
        dist  = np.hypot(U - 0.5, V - 0.5) * 2
        # Coastal banding: edges lighter (shallow/turquoise), centre darker (deep)
        depth = 0.18 * dist
        wave  = 0.05 * np.sin(U * 70 + V * 20) * 0.5 + 0.03 * n2
        foam  = np.maximum(0.0, n3 - 0.75) * 0.55
        glint = np.where(n3 > 0.86, (n3 - 0.86) / 0.14 * 0.40, 0.0)
        # Teal push: more green in shallows, deep blue in centre
        return (r0 + depth * 0.25 + foam * 0.55 + glint * 0.8,
                g0 + depth * 0.35 + wave + foam * 0.50 + glint * 0.75,
                b0 + depth * 0.85 + wave + foam * 0.65 + glint * 0.65)

    if name == 'ice':
        crack   = np.where(
            (np.abs((U * 7 + n * 0.3) % 1 - 0.5) < 0.022) |
            (np.abs((V * 5 - n * 0.4) % 1 - 0.5) < 0.018),
            1.0, 0.0)
        shimmer = 0.06 * np.sin(U * 50 + V * 40 + seed)
        layer   = 0.04 * np.sin(V * 12 + U * 8 + seed)
        frost   = 0.03 * (n2 - 0.5)
        return (r0 - crack * 0.25 + shimmer * 0.35 + layer + frost * 0.5,
                g0 - crack * 0.15 + shimmer * 0.25 + layer * 0.8 + frost * 0.4,
                b0 - crack * 0.08 + shimmer * 0.9 + layer * 1.2 + frost * 0.6)

    if name == 'hills':
        roll   = 0.18 * np.sin(U * 12 + n * 2) * np.sin(V * 10 + n2 * 2)
        shadow = -0.08 * np.minimum(0.0, roll)
        warm   = 0.04 * (1.0 - V)
        return (r0 + roll * 0.45 + shadow * 0.5 + warm,
                g0 + roll * 1.05 + shadow + warm * 0.6,
                b0 + roll * 0.45 + shadow * 0.3 + warm * 0.3)

    if name == 'sacred':
        circuit = np.where(
            (np.abs((U * 9 + n3 * 0.15) % 1 - 0.5) < 0.022) |
            (np.abs((V * 9 + n3 * 0.15) % 1 - 0.5) < 0.022),
            1.0, 0.0)
        glow    = np.maximum(0.0, n - 0.55) * 0.35
        return (r0 + circuit * 0.85 + glow * 0.4,
                g0 + circuit * 0.65 + glow * 0.25,
                b0 + circuit * 0.12 + glow * 0.5)

    # fog / fallback
    d = (n - 0.5) * 0.10
    return (r0 + d, g0 + d * 0.8, b0 + d)


# ── Per-terrain roughness (vectorised) ───────────────────────────────────────

def terrain_roughness_np(name: str, U, V, seed: int):
    base = ROUGHNESS.get(name, 0.8)
    n    = fbm_np(U * 8, V * 8, seed + 53, 3)
    var  = (n - 0.5) * 0.16
    if name == 'ocean':
        var += np.sin(U * 20 + V * 8 + seed) * 0.06
    if name == 'mountain':
        dist     = np.hypot(U - 0.5, V - 0.5) * 2.0
        snow_zone = np.where(dist < 0.28, 1.0, np.maximum(0.0, (0.38 - dist) / 0.10))
        var -= snow_zone * 0.10
    return clamp01(base + var)


# ── Per-terrain normal (vectorised central differences) ──────────────────────

def terrain_normal_np(name: str, U, V, seed: int):
    eps = 1.0 / CELL

    def height(uu, vv):
        if name == 'plains':
            return fbm_np(uu * 6, vv * 6, seed, 4) * 0.4
        if name == 'forest':
            if seed % 2 == 0:
                return fbm_np(uu * 8, vv * 8, seed, 5) * 0.55
            else:
                return fbm_np(uu * 6, vv * 6, seed, 4) * 0.35 + fbm_np(uu * 14, vv * 14, seed + 3, 2) * 0.15
        if name == 'mountain':
            strata = 0.3 * np.sin(vv * 60 + fbm_np(uu * 4, vv * 4, seed, 3) * 4)
            return fbm_np(uu * 5, vv * 5, seed, 4) * 0.3 + strata * 0.4 + vv * 0.5
        if name == 'desert':
            return (0.5 * np.sin(uu * 22 + vv * 6 + seed) + fbm_np(uu * 12, vv * 12, seed, 3) * 0.3)
        if name == 'ocean':
            return fbm_np(uu * 20, vv * 20, seed, 3) * 0.12
        if name == 'ice':
            return fbm_np(uu * 6, vv * 6, seed, 3) * 0.15
        if name == 'hills':
            h1 = fbm_np(uu * 2, vv * 2, seed, 2)
            h2 = fbm_np(uu * 2, vv * 2, seed + 5, 2)
            return (0.6 * np.sin(uu * 12 + h1 * 2) * np.sin(vv * 10 + h2 * 2) * 0.5 + 0.5)
        if name == 'sacred':
            return fbm_np(uu * 4, vv * 4, seed, 3) * 0.1
        return fbm_np(uu * 4, vv * 4, seed, 3) * 0.2

    dhdx = (height(U + eps, V) - height(U - eps, V)) / (2 * eps)
    dhdy = (height(U, V + eps) - height(U, V - eps)) / (2 * eps)

    strength = {'mountain': 1.8, 'hills': 1.2, 'desert': 1.0, 'forest': 0.9,
                'plains': 0.6, 'ocean': 0.3, 'ice': 0.5, 'sacred': 0.4, 'fog': 0.1}.get(name, 0.5)
    nx = -dhdx * strength
    ny = -dhdy * strength
    nz = np.ones_like(nx)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx /= length
    ny /= length
    nz /= length
    return nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5


# ── Build coordinate grids (shared across all terrains) ──────────────────────

u_line = np.linspace(0.0, 1.0, CELL)
v_line = np.linspace(0.0, 1.0, CELL)
U, V   = np.meshgrid(u_line, v_line)   # shape: (CELL, CELL)

W, H = CELL * COLS, CELL * ROWS

# Pixel buffers: [H, W, 4] — row 0 is the top of the image in memory.
# We will write row_i terrains into y0 = row_i * CELL from the top.
col_pixels   = np.zeros((H, W, 4), dtype=np.float32)
norm_pixels  = np.zeros((H, W, 4), dtype=np.float32)
rough_pixels = np.zeros((H, W, 4), dtype=np.float32)
col_pixels[..., 3]   = 1.0
norm_pixels[..., 3]  = 1.0
rough_pixels[..., 3] = 1.0

meta = {
    'version': 6,
    'kind': 'repociv-3d-terrain-atlas',
    'texture': '/assets/3d/terrain-atlas-3d.png',
    'normalTexture': '/assets/3d/terrain-normal-atlas-3d.png',
    'roughnessTexture': '/assets/3d/terrain-roughness-atlas-3d.png',
    'cellSize': CELL,
    'columns': COLS,
    'rows': ROWS,
    'terrains': {},
}

for idx, (name, base) in enumerate(TERRAINS):
    col_i  = idx % COLS
    row_i  = idx // COLS
    x0     = col_i * CELL
    y0     = row_i * CELL
    meta['terrains'][name] = {
        'index': idx,
        'rect': [x0, y0, CELL, CELL],
        'uvRect': [col_i / COLS, row_i / ROWS, 1 / COLS, 1 / ROWS],
        'roughness': ROUGHNESS.get(name, 0.8),
    }
    print(f'[DAVI] rendering {name} ({idx+1}/{len(TERRAINS)})…', flush=True)

    seed = idx + 1
    R, G, B = terrain_rgb_np(name, base, U, V, seed)
    col_pixels[y0:y0+CELL, x0:x0+CELL, 0] = clamp01(R).astype(np.float32)
    col_pixels[y0:y0+CELL, x0:x0+CELL, 1] = clamp01(G).astype(np.float32)
    col_pixels[y0:y0+CELL, x0:x0+CELL, 2] = clamp01(B).astype(np.float32)

    NX, NY, NZ = terrain_normal_np(name, U, V, seed)
    norm_pixels[y0:y0+CELL, x0:x0+CELL, 0] = clamp01(NX).astype(np.float32)
    norm_pixels[y0:y0+CELL, x0:x0+CELL, 1] = clamp01(NY).astype(np.float32)
    norm_pixels[y0:y0+CELL, x0:x0+CELL, 2] = clamp01(NZ).astype(np.float32)

    RGH = terrain_roughness_np(name, U, V, seed)
    rough_pixels[y0:y0+CELL, x0:x0+CELL, 0] = RGH.astype(np.float32)
    rough_pixels[y0:y0+CELL, x0:x0+CELL, 1] = RGH.astype(np.float32)
    rough_pixels[y0:y0+CELL, x0:x0+CELL, 2] = RGH.astype(np.float32)


# ── Save via PIL ────────────────────────────────────────────────────────────
# PIL Image.fromarray expects [H, W, channels] in uint8, row 0 = top.
# Our pixel buffers are already in that layout.

def save_float_rgba(arr, path):
    # Convert float [0,1] → uint8 [0,255]
    uint_arr = (np.clip(arr, 0.0, 1.0) * 255.0).astype(np.uint8)
    img = Image.fromarray(uint_arr, mode='RGBA')
    img.save(path)
    print(f'[DAVI] saved → {path}', flush=True)


def save_float_rgb(arr, path):
    uint_arr = (np.clip(arr, 0.0, 1.0) * 255.0).astype(np.uint8)
    img = Image.fromarray(uint_arr, mode='RGBA')
    # For roughness, store single-channel grayscale as RGB to keep consistency,
    # or we can store as greyscale PNG. Let's keep RGB for Three.js ease.
    img.save(path)
    print(f'[DAVI] saved → {path}', flush=True)


save_float_rgba(col_pixels,   OUT / 'terrain-atlas-3d.png')
save_float_rgba(norm_pixels,  OUT / 'terrain-normal-atlas-3d.png')
save_float_rgb(rough_pixels, OUT / 'terrain-roughness-atlas-3d.png')

with open(OUT / 'terrain-atlas-3d.json', 'w') as f:
    json.dump(meta, f, indent=2)
print(f'[DAVI] saved metadata → {OUT}/terrain-atlas-3d.json  (version {meta["version"]})', flush=True)
