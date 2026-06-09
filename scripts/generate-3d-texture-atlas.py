#!/usr/bin/env python3
"""Reproducible terrain texture + normal-map atlas for RepoCiv 3D global map.
Run via: blender --background --factory-startup --python scripts/generate-3d-texture-atlas.py
Expects to be run from the repo root; writes to public/assets/3d/.

Produces:
  terrain-atlas-3d.png       — colour atlas  (9 terrains × 1024px, 4×3 grid)
  terrain-normal-atlas-3d.png — tangent-space normal atlas (same layout)
  terrain-atlas-3d.json      — atlas metadata
"""
import json, math, sys
from pathlib import Path
import bpy

CELL = 1024
COLS = 4
ROWS = 3
OUT  = Path('public/assets/3d')
OUT.mkdir(parents=True, exist_ok=True)

TERRAINS = [
    ('plains',   (0.40, 0.60, 0.28)),
    ('forest',   (0.10, 0.28, 0.09)),
    ('mountain', (0.42, 0.42, 0.40)),
    ('desert',   (0.82, 0.60, 0.32)),
    ('ocean',    (0.10, 0.36, 0.68)),
    ('ice',      (0.78, 0.88, 0.94)),
    ('hills',    (0.48, 0.60, 0.30)),
    ('sacred',   (0.10, 0.06, 0.20)),
    ('fog',      (0.04, 0.04, 0.09)),
]


# ── Deterministic multi-octave noise ────────────────────────────────────────

def hash_val(x: float, y: float, seed: int) -> float:
    n = math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453
    return n - math.floor(n)


def smooth_noise(x: float, y: float, seed: int) -> float:
    ix, iy = int(math.floor(x)), int(math.floor(y))
    fx, fy = x - ix, y - iy
    # Smooth cubic interpolation
    ux = fx * fx * (3.0 - 2.0 * fx)
    uy = fy * fy * (3.0 - 2.0 * fy)
    a = hash_val(ix,     iy,     seed)
    b = hash_val(ix + 1, iy,     seed)
    c = hash_val(ix,     iy + 1, seed)
    d = hash_val(ix + 1, iy + 1, seed)
    return a + (b - a) * ux + (c - a) * uy + (b - a + d - c - b + a) * ux * uy


def fbm(x: float, y: float, seed: int, octaves: int = 5) -> float:
    """Fractional Brownian Motion — multi-octave noise in [0,1]."""
    val, amp, freq, norm = 0.0, 0.5, 1.0, 0.0
    for _ in range(octaves):
        val  += amp * smooth_noise(x * freq, y * freq, seed)
        norm += amp
        amp  *= 0.5
        freq *= 2.0
    return val / norm


# ── Per-terrain colour ───────────────────────────────────────────────────────

def terrain_rgb(name: str, base: tuple, u: float, v: float, seed: int):
    r, g, b = base
    n  = fbm(u * 6, v * 6, seed, octaves=5)
    n2 = fbm(u * 18, v * 18, seed + 13, octaves=3)
    n3 = fbm(u * 40, v * 40, seed + 29, octaves=2)

    if name == 'plains':
        # Green grass with dry patches and subtle field rows
        grass = 0.10 * (n - 0.5) + 0.04 * (n2 - 0.5)
        dry   = max(0.0, n3 - 0.65) * 0.4          # ochre spots
        stripe = 0.025 * math.sin(v * 28 + seed)     # furrow lines
        return (r + dry * 0.35 + stripe, g + grass + dry * 0.15 + stripe, b + grass * 0.3)

    if name == 'forest':
        # Dark fractal canopy with clearings
        canopy = 0.14 * (n - 0.5) + 0.08 * (n2 - 0.5)
        clearing = max(0.0, 0.55 - n) * 0.22
        return (r + clearing * 0.4, g + canopy + clearing * 0.35, b + canopy * 0.5 + clearing * 0.1)

    if name == 'mountain':
        # Rock strata + snow cap above v=0.65
        strata = 0.10 * math.sin(v * 60 + n * 4 + seed) + 0.05 * (n2 - 0.5)
        snow_t = max(0.0, (v - 0.58) / 0.28)          # fade to white near top
        rock   = 0.08 * (n - 0.5) + strata
        base_r, base_g, base_b = r + rock, g + rock, b + rock
        return (
            base_r + (0.95 - base_r) * snow_t,
            base_g + (0.97 - base_g) * snow_t,
            base_b + (1.00 - base_b) * snow_t,
        )

    if name == 'desert':
        # Sine-wave dunes + warm gradient
        dune  = 0.09 * math.sin(u * 22 + v * 6 + seed) + 0.05 * math.sin(u * 9 - v * 14)
        grain = 0.04 * (n3 - 0.5)
        warm  = 0.06 * (1 - v)                         # cooler (cream) at base, warmer at crest
        return (r + dune + warm + grain, g + dune * 0.75 + grain * 0.5, b + dune * 0.35)

    if name == 'ocean':
        # Deep blue centre → lighter edges; subtle foam dots
        dist  = math.hypot(u - 0.5, v - 0.5) * 2       # 0 centre, 1 edge
        depth = 0.10 * dist                              # lighter at edges
        wave  = 0.06 * math.sin(u * 70 + v * 20) * 0.5 + 0.03 * n2
        foam  = max(0.0, n3 - 0.78) * 0.5               # foam flecks
        return (r + depth * 0.4 + foam * 0.6, g + depth * 0.5 + wave + foam * 0.6, b + depth + wave + foam * 0.7)

    if name == 'ice':
        # White-blue base with crack lines (dark blue fractures)
        crack = 1.0 if (abs((u * 7 + n * 0.3) % 1 - 0.5) < 0.018 or
                         abs((v * 5 - n * 0.4) % 1 - 0.5) < 0.014) else 0.0
        shimmer = 0.05 * math.sin(u * 50 + v * 40 + seed)
        return (
            r - crack * 0.2 + shimmer * 0.3,
            g - crack * 0.1 + shimmer * 0.2,
            b - crack * 0.05 + shimmer,
        )

    if name == 'hills':
        # Rolling green with valley shadows
        roll  = 0.12 * math.sin(u * 12 + n * 2) * math.sin(v * 10 + n2 * 2)
        shadow = -0.06 * max(0.0, -roll)
        return (r + roll * 0.4 + shadow * 0.5, g + roll + shadow, b + roll * 0.5 + shadow * 0.3)

    if name == 'sacred':
        # Deep violet with gold circuit-grid + purple glow
        circuit = (1.0 if abs((u * 9 + n3 * 0.15) % 1 - 0.5) < 0.022 or
                          abs((v * 9 + n3 * 0.15) % 1 - 0.5) < 0.022 else 0.0)
        glow   = max(0.0, n - 0.55) * 0.35
        return (r + circuit * 0.85 + glow * 0.4, g + circuit * 0.65 + glow * 0.25, b + circuit * 0.12 + glow * 0.5)

    if name == 'fog':
        d = (n - 0.5) * 0.10
        return (r + d, g + d * 0.8, b + d)

    # Fallback
    d = (n - 0.5) * 0.12
    return (r + d, g + d, b + d)


# ── Per-terrain normal (tangent space, RGB = normal XYZ mapped [0,1]) ────────

def terrain_normal(name: str, u: float, v: float, seed: int):
    """Return (nx, ny, nz) in [0,1] representing tangent-space normal.
    Flat surface = (0.5, 0.5, 1.0).  Derivations use central differences on fbm."""
    eps = 1.0 / CELL

    def height(uu, vv):
        """Height field used for normal derivation (terrain-specific)."""
        if name == 'plains':
            return fbm(uu * 6, vv * 6, seed, 4) * 0.4
        if name == 'forest':
            return fbm(uu * 8, vv * 8, seed, 5) * 0.55
        if name == 'mountain':
            strata = 0.3 * math.sin(vv * 60 + fbm(uu * 4, vv * 4, seed, 3) * 4)
            return fbm(uu * 5, vv * 5, seed, 4) * 0.3 + strata * 0.4 + vv * 0.5
        if name == 'desert':
            return (0.5 * math.sin(uu * 22 + vv * 6 + seed) + fbm(uu * 12, vv * 12, seed, 3) * 0.3)
        if name == 'ocean':
            return fbm(uu * 20, vv * 20, seed, 3) * 0.12
        if name == 'ice':
            return fbm(uu * 6, vv * 6, seed, 3) * 0.15
        if name == 'hills':
            return (0.6 * math.sin(uu * 12 + fbm(uu * 2, vv * 2, seed, 2) * 2)
                    * math.sin(vv * 10 + fbm(uu * 2, vv * 2, seed + 5, 2) * 2) * 0.5 + 0.5)
        if name == 'sacred':
            return fbm(uu * 4, vv * 4, seed, 3) * 0.1
        return fbm(uu * 4, vv * 4, seed, 3) * 0.2

    dhdx = (height(u + eps, v) - height(u - eps, v)) / (2 * eps)
    dhdv = (height(u, v + eps) - height(u, v - eps)) / (2 * eps)

    # Tangent-space normal from gradient — strength controls bumpiness
    strength = {'mountain': 1.8, 'hills': 1.2, 'desert': 1.0,
                'forest': 0.9, 'plains': 0.6, 'ocean': 0.3,
                'ice': 0.5, 'sacred': 0.4, 'fog': 0.1}.get(name, 0.5)
    nx = -dhdx * strength
    ny = -dhdv * strength
    nz = 1.0
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    nx, ny, nz = nx / length, ny / length, nz / length
    # Map from [-1,1] to [0,1]
    return (nx * 0.5 + 0.5, ny * 0.5 + 0.5, nz * 0.5 + 0.5)


def clamp01(x):
    return max(0.0, min(1.0, x))


# ── Render both atlases ──────────────────────────────────────────────────────

W, H = CELL * COLS, CELL * ROWS

colour_img = bpy.data.images.new('repociv_terrain_atlas_colour', width=W, height=H, alpha=True)
normal_img = bpy.data.images.new('repociv_terrain_atlas_normal', width=W, height=H, alpha=True)

col_pixels  = [0.0] * (W * H * 4)
norm_pixels = [0.0] * (W * H * 4)

meta = {
    'version': 2,
    'kind': 'repociv-3d-terrain-atlas',
    'texture': '/assets/3d/terrain-atlas-3d.png',
    'normalTexture': '/assets/3d/terrain-normal-atlas-3d.png',
    'cellSize': CELL,
    'columns': COLS,
    'rows': ROWS,
    'terrains': {},
}

for idx, (name, base) in enumerate(TERRAINS):
    col = idx % COLS
    row = idx // COLS
    x0, y0 = col * CELL, row * CELL
    meta['terrains'][name] = {
        'index': idx,
        'rect': [x0, y0, CELL, CELL],
        'uvRect': [col / COLS, row / ROWS, 1 / COLS, 1 / ROWS],
    }
    print(f'[DAVI] rendering {name} ({idx+1}/{len(TERRAINS)})…', flush=True)
    for y in range(CELL):
        for x in range(CELL):
            u = x / (CELL - 1)
            v = y / (CELL - 1)
            rr, gg, bb = terrain_rgb(name, base, u, v, idx + 1)
            nr, ng, nb = terrain_normal(name, u, v, idx + 1)
            px  = x0 + x
            py  = y0 + y
            off = (py * W + px) * 4
            col_pixels[off:off + 4]  = [clamp01(rr), clamp01(gg), clamp01(bb), 1.0]
            norm_pixels[off:off + 4] = [clamp01(nr), clamp01(ng), clamp01(nb), 1.0]

colour_img.pixels = col_pixels
colour_img.filepath_raw = str(OUT / 'terrain-atlas-3d.png')
colour_img.file_format = 'PNG'
colour_img.save()
print(f'[DAVI] saved colour atlas → {colour_img.filepath_raw}', flush=True)

normal_img.pixels = norm_pixels
normal_img.filepath_raw = str(OUT / 'terrain-normal-atlas-3d.png')
normal_img.file_format = 'PNG'
normal_img.save()
print(f'[DAVI] saved normal atlas → {normal_img.filepath_raw}', flush=True)

(OUT / 'terrain-atlas-3d.json').write_text(json.dumps(meta, indent=2))
print(f'[DAVI] saved atlas metadata', flush=True)
