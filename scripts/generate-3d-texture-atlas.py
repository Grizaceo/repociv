#!/usr/bin/env python3
"""Reproducible terrain texture + normal-map + roughness atlas for RepoCiv 3D global map.
Run via: blender --background --factory-startup --python scripts/generate-3d-texture-atlas.py
Expects to be run from the repo root; writes to public/assets/3d/.

Produces:
  terrain-atlas-3d.png         — colour atlas  (9 terrains × 1024px, 4×3 grid)
  terrain-normal-atlas-3d.png — tangent-space normal atlas (same layout)
  terrain-roughness-atlas-3d.png — roughness atlas (single channel, greyscale)
  terrain-atlas-3d.json      — atlas metadata

v5: full numpy vectorisation — ~100× faster than pixel-by-pixel Python loops.
"""
import json
from pathlib import Path
import bpy
import numpy as np

CELL = 1024
COLS = 4
ROWS = 3
OUT  = Path('public/assets/3d')
OUT.mkdir(parents=True, exist_ok=True)

TERRAINS = [
    ('plains',   (0.38, 0.68, 0.22)),
    ('forest',   (0.08, 0.32, 0.07)),
    ('mountain', (0.50, 0.48, 0.45)),
    ('desert',   (0.88, 0.62, 0.28)),
    ('ocean',    (0.06, 0.30, 0.72)),
    ('ice',      (0.80, 0.92, 0.98)),
    ('hills',    (0.42, 0.66, 0.24)),
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
        grass  = 0.10 * (n - 0.5) + 0.04 * (n2 - 0.5)
        dry    = np.maximum(0.0, n3 - 0.65) * 0.4
        stripe = 0.025 * np.sin(V * 28 + seed)
        vd, vid = voronoi_dist_np(U * 8, V * 8, seed + 41)
        # Yellow flowers
        yf = np.where((vd < 0.12) & ((vid.astype(int) % 3) == 0),
                      1.0 - (vd / 0.12), 0.0)
        # White flowers
        wf = np.where((vd < 0.10) & ((vid.astype(int) % 3) == 1),
                      1.0 - (vd / 0.10), 0.0)
        R = r0 + dry * 0.35 + stripe + yf * 0.35 + wf * 0.30
        G = g0 + grass + dry * 0.15 + stripe + yf * 0.28 + wf * 0.30
        B = b0 + grass * 0.3 + yf * 0.05 + wf * 0.28
        return R, G, B

    if name == 'forest':
        forest_type = seed % 2
        if forest_type == 0:
            canopy  = 0.14 * (n - 0.5) + 0.08 * (n2 - 0.5)
            clearing = np.maximum(0.0, 0.55 - n) * 0.22
            return (r0 + clearing * 0.4,
                    g0 + canopy + clearing * 0.35,
                    b0 + canopy * 0.5 + clearing * 0.1)
        else:
            canopy   = 0.10 * (n - 0.5) + 0.12 * np.maximum(0.0, n2 - 0.4) * 0.5
            leaf_var = 0.08 * np.sin(U * 25 + V * 18 + seed)
            return (r0 + canopy * 0.5 + leaf_var * 0.3,
                    g0 + canopy * 1.2 + leaf_var * 0.4 + 0.06,
                    b0 + canopy * 0.4 + leaf_var * 0.1)

    if name == 'mountain':
        dist    = np.hypot(U - 0.5, V - 0.5) * 2.0
        strata  = 0.10 * np.sin(dist * 60 + n * 4 + seed) + 0.05 * (n2 - 0.5)
        snow_t  = np.where(dist < 0.28, 1.0, np.maximum(0.0, (0.38 - dist) / 0.10))
        volcanic = np.maximum(0.0, (dist - 0.70) / 0.30)
        rock    = 0.08 * (n - 0.5) + strata
        br      = (r0 + rock) * (1.0 - volcanic * 0.30)
        bg      = (g0 + rock) * (1.0 - volcanic * 0.25)
        bb      = (b0 + rock) * (1.0 - volcanic * 0.20)
        return (br + (0.95 - br) * snow_t,
                bg + (0.97 - bg) * snow_t,
                bb + (1.00 - bb) * snow_t)

    if name == 'desert':
        dune_raw = np.sin(U * 22 + V * 6 + seed) + 0.6 * np.sin(U * 9 - V * 14)
        dune     = 0.20 * dune_raw
        grain    = 0.04 * (n3 - 0.5)
        warm     = 0.06 * (1 - V)
        shadow   = -0.04 * np.minimum(0.0, dune_raw)
        return (r0 + dune + warm + grain + shadow * 0.5,
                g0 + dune * 0.70 + grain * 0.5 + shadow * 0.3,
                b0 + dune * 0.30 + shadow * 0.2)

    if name == 'ocean':
        dist  = np.hypot(U - 0.5, V - 0.5) * 2
        depth = 0.10 * dist
        wave  = 0.06 * np.sin(U * 70 + V * 20) * 0.5 + 0.03 * n2
        foam  = np.maximum(0.0, n3 - 0.78) * 0.5
        glint = np.where(n3 > 0.88, (n3 - 0.88) / 0.12 * 0.45, 0.0)
        return (r0 + depth * 0.4 + foam * 0.6 + glint * 0.9,
                g0 + depth * 0.5 + wave + foam * 0.6 + glint * 0.85,
                b0 + depth + wave + foam * 0.7 + glint * 0.7)

    if name == 'ice':
        crack   = np.where(
            (np.abs((U * 7 + n * 0.3) % 1 - 0.5) < 0.018) |
            (np.abs((V * 5 - n * 0.4) % 1 - 0.5) < 0.014),
            1.0, 0.0)
        shimmer = 0.05 * np.sin(U * 50 + V * 40 + seed)
        layer   = 0.03 * np.sin(V * 12 + U * 8 + seed)
        return (r0 - crack * 0.2 + shimmer * 0.3 + layer,
                g0 - crack * 0.1 + shimmer * 0.2 + layer * 0.8,
                b0 - crack * 0.05 + shimmer + layer * 1.2)

    if name == 'hills':
        roll   = 0.12 * np.sin(U * 12 + n * 2) * np.sin(V * 10 + n2 * 2)
        shadow = -0.06 * np.minimum(0.0, roll)
        return (r0 + roll * 0.4 + shadow * 0.5,
                g0 + roll + shadow,
                b0 + roll * 0.5 + shadow * 0.3)

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

colour_img = bpy.data.images.new('repociv_terrain_atlas_colour',    width=W, height=H, alpha=True)
normal_img = bpy.data.images.new('repociv_terrain_atlas_normal',    width=W, height=H, alpha=True)
rough_img  = bpy.data.images.new('repociv_terrain_atlas_roughness', width=W, height=H, alpha=True)

# Blender pixel buffer: flat list [R,G,B,A, ...] in bottom-left-origin order
col_pixels   = np.zeros((H, W, 4), dtype=np.float32)
norm_pixels  = np.zeros((H, W, 4), dtype=np.float32)
rough_pixels = np.zeros((H, W, 4), dtype=np.float32)
col_pixels[..., 3]   = 1.0
norm_pixels[..., 3]  = 1.0
rough_pixels[..., 3] = 1.0

meta = {
    'version': 5,
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

# Blender images use flattened [R,G,B,A, ...] in row-major bottom-left order
colour_img.pixels = col_pixels.flatten().tolist()
colour_img.filepath_raw = str(OUT / 'terrain-atlas-3d.png')
colour_img.file_format = 'PNG'
colour_img.save()
print(f'[DAVI] saved colour atlas → {colour_img.filepath_raw}', flush=True)

normal_img.pixels = norm_pixels.flatten().tolist()
normal_img.filepath_raw = str(OUT / 'terrain-normal-atlas-3d.png')
normal_img.file_format = 'PNG'
normal_img.save()
print(f'[DAVI] saved normal atlas → {normal_img.filepath_raw}', flush=True)

rough_img.pixels = rough_pixels.flatten().tolist()
rough_img.filepath_raw = str(OUT / 'terrain-roughness-atlas-3d.png')
rough_img.file_format = 'PNG'
rough_img.save()
print(f'[DAVI] saved roughness atlas → {rough_img.filepath_raw}', flush=True)

with open(OUT / 'terrain-atlas-3d.json', 'w') as f:
    json.dump(meta, f, indent=2)
print(f'[DAVI] saved metadata → {OUT}/terrain-atlas-3d.json  (version {meta["version"]})', flush=True)
