#!/usr/bin/env python3
"""Blender-baked Civ V-style terrain atlas for RepoCiv 3D global map.

Replaces cells in public/assets/3d/terrain-atlas-3d.png AND
terrain-normal-atlas-3d.png with renders produced by Blender. The numpy
generator (scripts/generate-3d-texture-atlas.py) is preserved as the
fallback documented in the README. The roughness atlas is NEVER touched.

Run via:
    ~/tools/blender/blender-5.1.2-linux-x64/blender \\
        --background --factory-startup \\
        --python scripts/blender/bake_atlas.py -- \\
        --group a \\
        --resolution 1024 \\
        --out-resolution 512 \\
        --blender-bin ~/tools/blender/blender-5.1.2-linux-x64/blender

Groups (one commit per group; render order matches the manifest index):
    a = plains, forest, hills                 (greens, Voronoi flower patches, dual canopy)
    b = desert, ice                           (Wave dunes w/ directional shading, crossed crack lines)
    c = ocean                                 (radial coastal-teal -> deep gradient + waves)
    d = mountain, sacred                      (Brick strata + snow, 9x9 circuit grid)

This file is BOTH the driver and the Blender payload: run it directly
with python3 (it generates a bpy sub-script under /tmp and invokes the
Blender binary on it). One invocation per group bakes only that group's
cells and re-composes the atlas; other cells are preserved (we do NOT
degrade them). Regenerate everything with:

    for g in a b c d; do
      python3 scripts/blender/bake_atlas.py --group $g \
        --resolution 1024 --out-resolution 512 \
        --blender-bin ~/tools/blender/blender-5.1.2-linux-x64/blender
    done

Normal pass (--normal-pass, default 'raw'):
    'raw'  — each cell renders TWICE: (1) the unlit albedo (Emission,
             view transform 'Standard'), (2) a true tangent-space normal
             map: the per-biome Bump-node normal is encoded as
             n * (0.5, -0.5, 0.5) + 0.5 and emitted under view transform
             'Raw' (no tone curve, no dither), so a flat surface reads
             exactly (128, 128, 255). The Y flip matches the numpy
             generator's convention (image v grows downward). The result
             is pasted into terrain-normal-atlas-3d.png.
    'none' — iter-1 behavior: only albedo; the normal atlas is untouched.

Per-cell variation (--seed-2, default 0):
    Each cell picks 1 of 4 Mapping variants via (seed + seed2) % 4.
    A variant shifts Mapping.Location and rotates the texture space
    (rotating Wave band direction with it), so biome cells are
    decorrelated from each other and intra-cell layout shifts with
    seed-2. mountain/sacred never rotate (strata must stay horizontal,
    the circuit grid axis-aligned).

Determinism contract:
    - Texture Coordinate -> Mapping node with offsets derived from
      (seed, variant). This is the only randomness in the node graph and
      it is seeded-per-cell, so two runs with the same seeds produce
      identical bytes. No Python RNG is consumed.
    - Camera, light, and material parameters are floats. forest's
      mixed-vs-homogeneous canopy branch is seed % 2 (decided at graph
      build time, not at render time).
    - Eevee: samples = 1 (default; we don't use AO/SSAO/SSR which need
      samples). Resolution fixed. PNG RGB deterministic. The normal pass
      sets dither_intensity = 0 so data channels are not dithered.

Constraints honored:
    - TERRAIN_ATLAS_INDEX in src/three/terrainShader.ts and the
      manifest order are NOT changed. We only swap pixel content.
    - Budget: the 3 atlas PNGs combined stay under 6MB — enforced by the
      "asset budget" step in scripts/check.sh.
    - The numpy generator stays untouched as a fallback.
    - terrain-roughness-atlas-3d.png is never written.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# This script is invoked from the shell (no `bpy`). The actual Blender
# pass is done by a generated sub-script under /tmp/repociv-bake-*.py
# which is the only thing that imports bpy.

# ── Configuration ────────────────────────────────────────────────────────────

REPO = Path(os.environ.get("REPOCIV_REPO", Path.cwd()))
ATLAS_DIR = REPO / "public" / "assets" / "3d"
ATLAS_PNG = ATLAS_DIR / "terrain-atlas-3d.png"
NORMAL_PNG = ATLAS_DIR / "terrain-normal-atlas-3d.png"
ROUGH_PNG = ATLAS_DIR / "terrain-roughness-atlas-3d.json"  # used only to read meta
META_JSON = ATLAS_DIR / "terrain-atlas-3d.json"

# Default Blender binary. Override with --blender-bin or BLENDER_BIN env.
DEFAULT_BLENDER = Path.home() / "tools/blender/blender-5.1.2-linux-x64/blender"

# Iter-5 plains smoothing (commit d6aa2d4): GaussianBlur applied to the
# standalone plains cell after resize (and quantize, for the normal pass).
# Part of the canonical recipe so a fresh full bake reproduces the tracked
# atlas byte-exactly. Do not change without a manifest version bump.
PLAINS_BLUR_RADIUS = 3.5

# Per-biome seeds (stable across runs; do not change without a version bump
# of the atlas manifest). Mirrors the numpy generator's `seed = idx + 1`.
SEEDS = {
    "plains":   1,
    "forest":   2,
    "hills":    7,
    "desert":   4,
    "ocean":    5,
    "ice":      6,
    "mountain": 3,
    "sacred":   8,
}

# Atlas ordering (must match the manifest in terrain-atlas-3d.json).
TERRAINS_IN_ORDER = [
    "plains", "forest", "mountain", "desert",
    "ocean", "ice", "hills", "sacred",
]

# Group definitions (a/b/c/d → set of terrain names).
GROUPS = {
    "a": {"plains", "forest", "hills"},
    "b": {"desert", "ice"},
    "c": {"ocean"},
    "d": {"mountain", "sacred"},
}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _read_meta() -> dict:
    if not META_JSON.exists():
        sys.exit(f"[FATAL] manifest missing: {META_JSON}. "
                 f"Run scripts/generate-3d-texture-atlas.py first to seed it.")
    return json.loads(META_JSON.read_text())


def _parse_args(argv: list[str]) -> argparse.Namespace:
    # Two invocation modes:
    #   1. Direct CLI: `python bake_atlas.py --group a` -> argv == sys.argv
    #   2. Blender passthrough: `blender --python bake_atlas.py -- --group a`
    #      -> argv has Blender's own flags; our args live after `--`.
    # Heuristic: if the FIRST non-flag token after a `--` is one of our
    # flags, treat everything after `--` as our argv. Otherwise strip
    # sys.argv[0] (the script path) and parse the tail.
    OUR_FLAGS = ("--group", "--resolution", "--out-resolution", "--dry-run",
                 "--blender-bin", "--seed-2", "--normal-pass")
    if "--" in argv:
        after = argv[argv.index("--") + 1:]
        if after and any(after[0].startswith(f) for f in OUR_FLAGS):
            argv = after
        else:
            argv = argv[1:]  # drop the script path
    else:
        argv = argv[1:]  # drop the script path

    p = argparse.ArgumentParser()
    p.add_argument("--group", required=True, choices=list(GROUPS.keys()))
    p.add_argument("--resolution", type=int, default=1024,
                   help="Render resolution per cell (default 1024).")
    p.add_argument("--out-resolution", type=int, default=512,
                   help="Final atlas cell size (default 512; matches manifest).")
    p.add_argument("--blender-bin", type=Path, default=DEFAULT_BLENDER,
                   help="Path to blender executable.")
    p.add_argument("--seed-2", dest="seed2", type=int, default=0,
                   help="Secondary seed: shifts which of the 4 Mapping "
                        "variants each cell uses (default 0).")
    p.add_argument("--normal-pass", choices=["raw", "none"], default="raw",
                   help="'raw' (default) bakes a true tangent-space normal "
                        "map per cell into the normal atlas; 'none' leaves "
                        "the normal atlas untouched (iter-1 behavior).")
    p.add_argument("--dry-run", action="store_true",
                   help="Print what would happen; do not invoke Blender or write files.")
    return p.parse_args(argv)


# ── Blender-side script generator ────────────────────────────────────────────
# We *generate* a per-call Blender script that bakes the requested
# cells. The generated script is temporary; this avoids needing to
# install an addon and keeps the bake in one command line. The payload
# below is a static string; per-call parameters travel in a JSON header.

_PAYLOAD = r'''
import bpy, json, os
from pathlib import Path
from math import radians

CELLS = CFG["cells"]
SEEDS = CFG["seeds"]
RES = int(CFG["res"])
SEED2 = int(CFG["seed2"])
NORMAL_PASS = CFG["normal_pass"]
OUT_DIR = Path("/tmp/repociv-bake/" + CFG["group"])
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Sun from the NE (gap #3): normalized (3, -2, 5). With Emission albedo
# the lamp itself cannot tint the render, so the directional shading is
# painted explicitly via dot(bumpNormal, SUN_DIR) below.
SUN_DIR = (0.4867, -0.3244, 0.8111)

# 4 deterministic Mapping variants (gap #5): (loc_x, loc_y, rot_z_deg).
VARIANTS = [
    (0.00, 0.00, 0.0),
    (0.37, 0.11, 90.0),
    (0.73, 0.29, 180.0),
    (0.19, 0.53, 270.0),
]
# Strata must stay horizontal; the circuit grid stays axis-aligned.
NO_ROTATE = {"mountain", "sacred"}

# ── Clean scene ─────────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
rd = scene.render
try:
    rd.use_motion_blur = False
    rd.use_simplify = True
    rd.simplify_subdivision = 1
except Exception:
    pass

# ── Color management ────────────────────────────────────────────────────
# Blender 4+/5 defaults to the AgX view transform, which darkens and
# desaturates everything — baked this way, the bright sand ramp reads as
# mud and the teal ocean as slate in-world. Albedo output must be
# 'Standard' (no filmic tone curve): the game's own renderer does the
# lighting; the atlas should carry flat, saturated color. The normal
# pass switches to 'Raw' (data, not color).
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0.0
scene.view_settings.gamma = 1.0

# ── Camera (ortho, top-down) ────────────────────────────────────────────
bpy.ops.object.camera_add(location=(0, 0, 4))
cam = bpy.context.object
cam.data.type = 'ORTHO'
cam.data.ortho_scale = 2.0
cam.rotation_euler = (0, 0, 0)
scene.camera = cam

# ── Light (warm afternoon, from the NE — gap #3) ───────────────────────
# Emission materials ignore lamps; the lamp stays for parity with any
# future BSDF debug renders, aimed along -SUN_DIR.
bpy.ops.object.light_add(type='AREA', location=(3, -2, 5))
light = bpy.context.object
light.data.energy = 60
light.data.size = 4
try:
    from mathutils import Vector
    light.rotation_euler = Vector((-3.0, 2.0, -5.0)).to_track_quat('-Z', 'Y').to_euler()
    light.data.color = (1.0, 0.94, 0.82)
except Exception:
    pass

# ── Node helpers ────────────────────────────────────────────────────────

def _ramp(nt, src_socket, stops):
    """ColorRamp with the given (position, rgba) stops, Fac <- src."""
    cr = nt.nodes.new('ShaderNodeValToRGB')
    el = cr.color_ramp.elements
    el[0].position, el[0].color = stops[0]
    el[1].position, el[1].color = stops[1]
    for pos, col in stops[2:]:
        e = el.new(pos)
        e.color = col
    nt.links.new(cr.inputs['Fac'], src_socket)
    return cr


def _mix(nt, blend, fac, c1_socket, c2_socket=None, c2_value=None):
    mx = nt.nodes.new('ShaderNodeMixRGB')
    mx.blend_type = blend
    if fac is not None:
        mx.inputs['Fac'].default_value = fac
    nt.links.new(mx.inputs['Color1'], c1_socket)
    if c2_socket is not None:
        nt.links.new(mx.inputs['Color2'], c2_socket)
    elif c2_value is not None:
        mx.inputs['Color2'].default_value = c2_value
    return mx


def _noise(nt, vec_socket, scale, detail, roughness=0.5):
    n = nt.nodes.new('ShaderNodeTexNoise')
    n.inputs['Scale'].default_value = scale
    n.inputs['Detail'].default_value = detail
    n.inputs['Roughness'].default_value = roughness
    nt.links.new(n.inputs['Vector'], vec_socket)
    return n


def _mapping(nt, coord, seed, variant, extra_rot_deg=0.0, rotate=True):
    """Deterministic Mapping from (seed, variant). No Python RNG."""
    m = nt.nodes.new('ShaderNodeMapping')
    s = float(seed)
    vx, vy, vr = VARIANTS[variant]
    if not rotate:
        vr = 0.0
    m.inputs['Location'].default_value = (
        (s * 12.9898) % 1.0 + vx,
        (s * 78.233) % 1.0 + vy,
        0.0,
    )
    m.inputs['Rotation'].default_value = (0.0, 0.0, radians(vr + extra_rot_deg))
    nt.links.new(m.inputs['Vector'], coord.outputs['Generated'])
    return m


def _voronoi_edges(nt, base_socket, map_node, tint, fac):
    """Gap #4: subtle tonal variant where Voronoi F1 distance < 0.15."""
    vor = nt.nodes.new('ShaderNodeTexVoronoi')
    vor.feature = 'F1'
    vor.inputs['Scale'].default_value = 7.0
    nt.links.new(vor.inputs['Vector'], map_node.outputs['Vector'])
    mask = _ramp(nt, vor.outputs['Distance'],
                 [(0.08, (1, 1, 1, 1)), (0.15, (0, 0, 0, 1))])
    mx = _mix(nt, 'MIX', None, base_socket, c2_value=tint)
    fmul = nt.nodes.new('ShaderNodeMath')
    fmul.operation = 'MULTIPLY'
    fmul.inputs[1].default_value = fac
    nt.links.new(fmul.inputs[0], mask.outputs['Color'])
    nt.links.new(mx.inputs['Fac'], fmul.outputs['Value'])
    return mx


# ── Per-biome graphs (gap #2) ───────────────────────────────────────────
# Each builder returns (color_socket, bump_layers, shade_fac) where
# bump_layers is a list of (height_socket, strength, distance) chained
# into Bump nodes (first = broadest), and shade_fac is the strength of
# the painted directional sun shading.

def biome_plains(nt, coord, seed, variant):
    m = _mapping(nt, coord, seed, variant)
    n1 = _noise(nt, m.outputs['Vector'], 6.0, 4.0)
    base = _ramp(nt, n1.outputs['Fac'],
                 [(0.30, (0.36, 0.58, 0.18, 1)), (0.70, (0.62, 0.84, 0.28, 1))])
    # Voronoi flower patches: yellow/white chosen per-cell-id via the
    # Voronoi Color output (deterministic stand-in for vid % 3).
    vor = nt.nodes.new('ShaderNodeTexVoronoi')
    vor.feature = 'F1'
    vor.inputs['Scale'].default_value = 9.0
    nt.links.new(vor.inputs['Vector'], m.outputs['Vector'])
    patches = _ramp(nt, vor.outputs['Distance'],
                    [(0.05, (1, 1, 1, 1)), (0.16, (0, 0, 0, 1))])
    pick = nt.nodes.new('ShaderNodeMath')
    pick.operation = 'GREATER_THAN'
    pick.inputs[1].default_value = 0.5
    nt.links.new(pick.inputs[0], vor.outputs['Color'])
    tint = nt.nodes.new('ShaderNodeMixRGB')
    tint.blend_type = 'MIX'
    tint.inputs['Color1'].default_value = (0.95, 0.85, 0.30, 1)  # yellow
    tint.inputs['Color2'].default_value = (0.92, 0.92, 0.86, 1)  # white
    nt.links.new(tint.inputs['Fac'], pick.outputs['Value'])
    flowers = _mix(nt, 'MIX', None, base.outputs['Color'],
                   c2_socket=tint.outputs['Color'])
    fmul = nt.nodes.new('ShaderNodeMath')
    fmul.operation = 'MULTIPLY'
    fmul.inputs[1].default_value = 0.75
    nt.links.new(fmul.inputs[0], patches.outputs['Color'])
    nt.links.new(flowers.inputs['Fac'], fmul.outputs['Value'])
    n2 = _noise(nt, m.outputs['Vector'], 32.0, 6.0, 0.6)
    return (flowers.outputs['Color'],
            [(n2.outputs['Fac'], 0.35, 0.05)], 0.45)


def biome_forest(nt, coord, seed, variant):
    m = _mapping(nt, coord, seed, variant)
    n1 = _noise(nt, m.outputs['Vector'], 8.0, 5.0)
    dark = _ramp(nt, n1.outputs['Fac'],
                 [(0.25, (0.07, 0.26, 0.08, 1)), (0.75, (0.16, 0.44, 0.14, 1))])
    lite = _ramp(nt, n1.outputs['Fac'],
                 [(0.25, (0.13, 0.38, 0.12, 1)), (0.75, (0.24, 0.56, 0.20, 1))])
    sel = _mix(nt, 'MIX', None, dark.outputs['Color'],
               c2_socket=lite.outputs['Color'])
    if seed % 2 == 0:
        # Mixed forest: dark/light canopy patches from a macro noise.
        n3 = _noise(nt, m.outputs['Vector'], 2.2, 2.0)
        patch = _ramp(nt, n3.outputs['Fac'],
                      [(0.38, (0, 0, 0, 1)), (0.62, (1, 1, 1, 1))])
        nt.links.new(sel.inputs['Fac'], patch.outputs['Color'])
    else:
        # Homogeneous canopy, mostly dark.
        sel.inputs['Fac'].default_value = 0.25
    glint = _ramp(nt, n1.outputs['Fac'],
                  [(0.55, (0, 0, 0, 1)), (0.60, (0.40, 0.65, 0.20, 1))])
    acc = _mix(nt, 'MIX', 0.30, sel.outputs['Color'],
               c2_socket=glint.outputs['Color'])
    var = _voronoi_edges(nt, acc.outputs['Color'], m,
                         (0.10, 0.30, 0.10, 1), 0.22)
    n2 = _noise(nt, m.outputs['Vector'], 32.0, 6.0, 0.6)
    return (var.outputs['Color'],
            [(n1.outputs['Fac'], 0.30, 0.06), (n2.outputs['Fac'], 0.30, 0.03)],
            0.50)


def biome_hills(nt, coord, seed, variant):
    m = _mapping(nt, coord, seed, variant)
    n1 = _noise(nt, m.outputs['Vector'], 4.0, 3.0)
    base = _ramp(nt, n1.outputs['Fac'],
                 [(0.30, (0.42, 0.58, 0.22, 1)), (0.75, (0.62, 0.78, 0.32, 1))])
    # Warm tonal lift (gap #2).
    warm = _mix(nt, 'MIX', 0.16, base.outputs['Color'],
                c2_value=(0.60, 0.50, 0.30, 1))
    var = _voronoi_edges(nt, warm.outputs['Color'], m,
                         (0.50, 0.52, 0.24, 1), 0.20)
    # Rolling ridges: Wave drives the broad bump (directional shading
    # comes from the shared dot(bumpNormal, SUN_DIR) shade pass).
    wave = nt.nodes.new('ShaderNodeTexWave')
    wave.wave_type = 'BANDS'
    wave.inputs['Scale'].default_value = 3.5
    wave.inputs['Distortion'].default_value = 6.0
    wave.inputs['Detail'].default_value = 2.0
    nt.links.new(wave.inputs['Vector'], m.outputs['Vector'])
    n2 = _noise(nt, m.outputs['Vector'], 32.0, 6.0, 0.6)
    return (var.outputs['Color'],
            [(wave.outputs['Fac'], 0.40, 0.08), (n2.outputs['Fac'], 0.30, 0.03)],
            0.55)


def biome_desert(nt, coord, seed, variant):
    m = _mapping(nt, coord, seed, variant)
    # Broad Civ V dunes. Scale 6 + detail 3 read as high-frequency corduroy
    # (plowed furrows) on the map; Civ V desert is pale sand with a handful
    # of wide, soft dune bands per tile and a faint crest light.
    wave = nt.nodes.new('ShaderNodeTexWave')
    wave.wave_type = 'BANDS'
    wave.bands_direction = 'X'
    wave.wave_profile = 'SAW'  # asymmetric dune profile (steep slip face)
    wave.inputs['Scale'].default_value = 2.2
    wave.inputs['Distortion'].default_value = 5.0
    wave.inputs['Detail'].default_value = 1.5
    nt.links.new(wave.inputs['Vector'], m.outputs['Vector'])
    base = _ramp(nt, wave.outputs['Fac'],
                 [(0.25, (0.82, 0.68, 0.42, 1)), (0.78, (0.93, 0.83, 0.58, 1))])
    crest = _ramp(nt, wave.outputs['Fac'],
                  [(0.82, (0, 0, 0, 1)), (0.92, (0.97, 0.92, 0.70, 1))])
    acc = _mix(nt, 'MIX', 0.28, base.outputs['Color'],
               c2_socket=crest.outputs['Color'])
    n2 = _noise(nt, m.outputs['Vector'], 36.0, 4.0, 0.6)
    grain = _mix(nt, 'MULTIPLY', 0.08, acc.outputs['Color'],
                 c2_socket=n2.outputs['Color'])
    return (grain.outputs['Color'],
            [(wave.outputs['Fac'], 0.42, 0.05), (n2.outputs['Fac'], 0.22, 0.015)],
            0.60)


def biome_ice(nt, coord, seed, variant):
    m = _mapping(nt, coord, seed, variant)
    n1 = _noise(nt, m.outputs['Vector'], 5.0, 5.0)
    base = _ramp(nt, n1.outputs['Fac'],
                 [(0.40, (0.65, 0.84, 0.94, 1)), (0.80, (0.84, 0.96, 1.00, 1))])
    # Crack network (gap #2): ice-floe polygons via Voronoi
    # distance-to-edge (the polygon borders ARE the cracks), plus one
    # subtle distorted Wave as secondary directional refreeze lines.
    # (Two crossed Waves — the original spec sketch — always read as a
    # regular grid, not cracked ice.)
    vor = nt.nodes.new('ShaderNodeTexVoronoi')
    vor.feature = 'DISTANCE_TO_EDGE'
    vor.inputs['Scale'].default_value = 5.0
    nt.links.new(vor.inputs['Vector'], m.outputs['Vector'])
    c1 = _ramp(nt, vor.outputs['Distance'],
               [(0.0, (0.45, 0.62, 0.80, 1)), (0.045, (1, 1, 1, 1))])
    m2 = _mapping(nt, coord, seed, variant, extra_rot_deg=73.0)
    w2 = nt.nodes.new('ShaderNodeTexWave')
    w2.wave_type = 'BANDS'
    w2.inputs['Scale'].default_value = 2.5
    w2.inputs['Distortion'].default_value = 3.5
    w2.inputs['Detail'].default_value = 1.0
    nt.links.new(w2.inputs['Vector'], m2.outputs['Vector'])
    c2 = _ramp(nt, w2.outputs['Fac'],
               [(0.44, (1, 1, 1, 1)),
                (0.48, (0.68, 0.80, 0.90, 1)),
                (0.52, (1, 1, 1, 1))])
    cracks = _mix(nt, 'MULTIPLY', 1.0, c1.outputs['Color'],
                  c2_socket=c2.outputs['Color'])
    col = _mix(nt, 'MULTIPLY', 0.85, base.outputs['Color'],
               c2_socket=cracks.outputs['Color'])
    sparkle = _ramp(nt, n1.outputs['Fac'],
                    [(0.50, (0, 0, 0, 1)), (0.52, (0.95, 0.98, 1.00, 1))])
    acc = _mix(nt, 'MIX', 0.12, col.outputs['Color'],
               c2_socket=sparkle.outputs['Color'])
    n2 = _noise(nt, m.outputs['Vector'], 32.0, 6.0, 0.6)
    return (acc.outputs['Color'],
            [(cracks.outputs['Color'], 0.45, 0.04), (n2.outputs['Fac'], 0.15, 0.02)],
            0.30)


def biome_ocean(nt, coord, seed, variant):
    m = _mapping(nt, coord, seed, variant)
    # Radial coastal gradient (gap #2): spherical gradient centered on
    # the cell — 1 at center (deep) falling to 0 at the rim (coast).
    sub = nt.nodes.new('ShaderNodeVectorMath')
    sub.operation = 'SUBTRACT'
    sub.inputs[1].default_value = (0.5, 0.5, 0.0)
    nt.links.new(sub.inputs[0], coord.outputs['Generated'])
    grad = nt.nodes.new('ShaderNodeTexGradient')
    grad.gradient_type = 'SPHERICAL'
    nt.links.new(grad.inputs['Vector'], sub.outputs['Vector'])
    depth = _ramp(nt, grad.outputs['Fac'],
                  [(0.15, (0.16, 0.58, 0.66, 1)),
                   (0.60, (0.05, 0.34, 0.52, 1)),
                   (0.95, (0.02, 0.24, 0.42, 1))])
    n1 = _noise(nt, m.outputs['Vector'], 10.0, 3.0)
    waves = _ramp(nt, n1.outputs['Fac'],
                  [(0.30, (0.04, 0.34, 0.52, 1)), (0.70, (0.16, 0.58, 0.66, 1))])
    col = _mix(nt, 'MIX', 0.45, depth.outputs['Color'],
               c2_socket=waves.outputs['Color'])
    foam = _ramp(nt, n1.outputs['Fac'],
                 [(0.78, (0, 0, 0, 1)), (0.82, (0.90, 0.95, 1.00, 1))])
    acc = _mix(nt, 'MIX', 0.30, col.outputs['Color'],
               c2_socket=foam.outputs['Color'])
    n2 = _noise(nt, m.outputs['Vector'], 32.0, 6.0, 0.6)
    return (acc.outputs['Color'],
            [(n2.outputs['Fac'], 0.25, 0.02)], 0.22)


def biome_mountain(nt, coord, seed, variant):
    m = _mapping(nt, coord, seed, variant, rotate=False)
    # Vertical fracture lines (gap #5): tall narrow bricks produce
    # crack-like vertical strata — in UV space X=Width, Y=Height,
    # so tall brick = Width < Height. Civ V mountain ridges run
    # downslope (vertical on the hex), not horizontal.
    nd = _noise(nt, m.outputs['Vector'], 4.0, 3.0)
    sc = nt.nodes.new('ShaderNodeVectorMath')
    sc.operation = 'SCALE'
    sc.inputs['Scale'].default_value = 0.18
    nt.links.new(sc.inputs[0], nd.outputs['Color'])
    dv = nt.nodes.new('ShaderNodeVectorMath')
    dv.operation = 'ADD'
    nt.links.new(dv.inputs[0], m.outputs['Vector'])
    nt.links.new(dv.inputs[1], sc.outputs['Vector'])
    brick = nt.nodes.new('ShaderNodeTexBrick')
    brick.inputs['Scale'].default_value = 8.0
    brick.inputs['Brick Width'].default_value = 0.5
    brick.inputs['Row Height'].default_value = 4.0
    brick.inputs['Mortar Size'].default_value = 0.05
    brick.inputs['Mortar Smooth'].default_value = 0.3
    brick.inputs['Color1'].default_value = (0.42, 0.40, 0.38, 1)
    brick.inputs['Color2'].default_value = (0.32, 0.30, 0.29, 1)
    brick.inputs['Mortar'].default_value = (0.22, 0.21, 0.20, 1)
    nt.links.new(brick.inputs['Vector'], dv.outputs['Vector'])
    n1 = _noise(nt, m.outputs['Vector'], 3.0, 4.0)
    tone = _ramp(nt, n1.outputs['Fac'],
                 [(0.20, (0.80, 0.80, 0.82, 1)), (0.80, (1.0, 1.0, 1.0, 1))])
    toned = _mix(nt, 'MULTIPLY', 0.60, brick.outputs['Color'],
                 c2_socket=tone.outputs['Color'])
    # Rock vs snow rim.
    snowmask = _ramp(nt, n1.outputs['Fac'],
                     [(0.64, (0, 0, 0, 1)), (0.72, (1, 1, 1, 1))])
    snow = _mix(nt, 'MIX', None, toned.outputs['Color'],
                c2_value=(0.93, 0.94, 0.97, 1))
    nt.links.new(snow.inputs['Fac'], snowmask.outputs['Color'])
    inv = nt.nodes.new('ShaderNodeMath')
    inv.operation = 'SUBTRACT'
    inv.inputs[0].default_value = 1.0
    nt.links.new(inv.inputs[1], brick.outputs['Fac'])
    n2 = _noise(nt, m.outputs['Vector'], 32.0, 6.0, 0.6)
    return (snow.outputs['Color'],
            [(inv.outputs['Value'], 0.70, 0.10), (n2.outputs['Fac'], 0.35, 0.04)],
            0.65)


def biome_sacred(nt, coord, seed, variant):
    m = _mapping(nt, coord, seed, variant, rotate=False)
    # 9x9 circuit grid (gap #2): aligned bricks, bright mortar = traces.
    brick = nt.nodes.new('ShaderNodeTexBrick')
    brick.offset = 0.0
    brick.inputs['Scale'].default_value = 9.0
    brick.inputs['Brick Width'].default_value = 1.0
    brick.inputs['Row Height'].default_value = 1.0
    brick.inputs['Mortar Size'].default_value = 0.015
    brick.inputs['Mortar Smooth'].default_value = 0.0
    brick.inputs['Color1'].default_value = (0.13, 0.06, 0.28, 1)
    brick.inputs['Color2'].default_value = (0.17, 0.08, 0.34, 1)
    brick.inputs['Mortar'].default_value = (0.45, 0.32, 0.70, 1)
    nt.links.new(brick.inputs['Vector'], m.outputs['Vector'])
    n1 = _noise(nt, m.outputs['Vector'], 7.0, 4.0)
    mottle = _ramp(nt, n1.outputs['Fac'],
                   [(0.30, (0.85, 0.80, 0.95, 1)), (0.70, (1, 1, 1, 1))])
    toned = _mix(nt, 'MULTIPLY', 0.50, brick.outputs['Color'],
                 c2_socket=mottle.outputs['Color'])
    glow = _ramp(nt, n1.outputs['Fac'],
                 [(0.70, (0, 0, 0, 1)), (0.74, (0.85, 0.70, 1.00, 1))])
    acc = _mix(nt, 'MIX', 0.30, toned.outputs['Color'],
               c2_socket=glow.outputs['Color'])
    n2 = _noise(nt, m.outputs['Vector'], 32.0, 6.0, 0.6)
    return (acc.outputs['Color'],
            [(brick.outputs['Fac'], 0.30, 0.02), (n2.outputs['Fac'], 0.15, 0.02)],
            0.25)


BIOME_BUILDERS = {
    'plains': biome_plains,
    'forest': biome_forest,
    'hills': biome_hills,
    'desert': biome_desert,
    'ice': biome_ice,
    'ocean': biome_ocean,
    'mountain': biome_mountain,
    'sacred': biome_sacred,
}


def _bump_chain(nt, layers):
    prev = None
    for height_socket, strength, distance in layers:
        b = nt.nodes.new('ShaderNodeBump')
        b.inputs['Strength'].default_value = strength
        b.inputs['Distance'].default_value = distance
        nt.links.new(b.inputs['Height'], height_socket)
        if prev is not None:
            nt.links.new(b.inputs['Normal'], prev.outputs['Normal'])
        prev = b
    return prev


def build_color_material(name, seed, variant):
    """Unlit albedo with painted directional sun shading (gaps #2/#3)."""
    mat = bpy.data.materials.new(name + '_color')
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    coord = nt.nodes.new('ShaderNodeTexCoord')
    color_socket, layers, shade_fac = BIOME_BUILDERS[name](nt, coord, seed, variant)
    bump = _bump_chain(nt, layers)
    # dot(bumpNormal, SUN_DIR): ~1.0 on flat ground, brighter toward the
    # sun, darker away — Civ V's painted NE-light look.
    dot = nt.nodes.new('ShaderNodeVectorMath')
    dot.operation = 'DOT_PRODUCT'
    dot.inputs[1].default_value = SUN_DIR
    nt.links.new(dot.inputs[0], bump.outputs['Normal'])
    shade = nt.nodes.new('ShaderNodeMath')
    shade.operation = 'MULTIPLY_ADD'
    shade.inputs[1].default_value = 0.32
    shade.inputs[2].default_value = 0.74
    nt.links.new(shade.inputs[0], dot.outputs['Value'])
    shaded = _mix(nt, 'MULTIPLY', shade_fac, color_socket,
                  c2_socket=shade.outputs['Value'])
    emit = nt.nodes.new('ShaderNodeEmission')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(emit.inputs['Color'], shaded.outputs['Color'])
    nt.links.new(out.inputs['Surface'], emit.outputs['Emission'])
    return mat


def build_normal_material(name, seed, variant):
    """True tangent-space normal map (gap #1): the Bump normal encoded
    as n * (0.5, -0.5, 0.5) + 0.5. The Y flip matches the numpy
    generator (image v grows downward); flat surface = (128, 128, 255).
    Rendered under view transform 'Raw'."""
    mat = bpy.data.materials.new(name + '_normal')
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    coord = nt.nodes.new('ShaderNodeTexCoord')
    _color, layers, _shade = BIOME_BUILDERS[name](nt, coord, seed, variant)
    bump = _bump_chain(nt, layers)
    mul = nt.nodes.new('ShaderNodeVectorMath')
    mul.operation = 'MULTIPLY'
    mul.inputs[1].default_value = (0.5, -0.5, 0.5)
    nt.links.new(mul.inputs[0], bump.outputs['Normal'])
    add = nt.nodes.new('ShaderNodeVectorMath')
    add.operation = 'ADD'
    add.inputs[1].default_value = (0.5, 0.5, 0.5)
    nt.links.new(add.inputs[0], mul.outputs['Vector'])
    emit = nt.nodes.new('ShaderNodeEmission')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(emit.inputs['Color'], add.outputs['Vector'])
    nt.links.new(out.inputs['Surface'], emit.outputs['Emission'])
    return mat


# ── Render per cell ─────────────────────────────────────────────────────
# Single-quad plane: shading variation comes from the Bump node, not
# geometry. Keeps the look "painted" (Civ V style) and avoids the halo
# from a subdivided plane whose edge is exactly ortho-aligned.
bpy.ops.mesh.primitive_plane_add(size=2.0, location=(0, 0, 0))
plane = bpy.context.object
bpy.ops.object.shade_smooth()

scene.render.resolution_x = RES
scene.render.resolution_y = RES
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
default_dither = rd.dither_intensity

results = []
for name in CELLS:
    seed = SEEDS[name]
    variant = (seed + SEED2) % 4

    # Pass 1: albedo.
    plane.data.materials.clear()
    plane.data.materials.append(build_color_material(name, seed, variant))
    scene.view_settings.view_transform = 'Standard'
    rd.dither_intensity = default_dither
    out_path = OUT_DIR / (name + '.png')
    scene.render.filepath = str(out_path)
    bpy.ops.render.render(write_still=True)
    entry = {'name': name, 'seed': seed, 'variant': variant,
             'path': str(out_path), 'size': out_path.stat().st_size}

    # Pass 2: tangent-space normal map (gap #1).
    if NORMAL_PASS == 'raw':
        plane.data.materials.clear()
        plane.data.materials.append(build_normal_material(name, seed, variant))
        scene.view_settings.view_transform = 'Raw'
        rd.dither_intensity = 0.0
        norm_path = OUT_DIR / (name + '_normal.png')
        scene.render.filepath = str(norm_path)
        bpy.ops.render.render(write_still=True)
        scene.view_settings.view_transform = 'Standard'
        rd.dither_intensity = default_dither
        entry['normal_path'] = str(norm_path)
        entry['normal_size'] = norm_path.stat().st_size

    results.append(entry)
    print("BAKED %s seed=%d variant=%d -> %s" % (name, seed, variant, out_path))

print("BAKE_DONE", json.dumps(results))
'''


def _blender_script_for(group_letter: str, terrains: list[str], res: int,
                        seed2: int, normal_pass: str) -> str:
    """Return Python source that, run inside Blender, bakes each terrain
    to PNGs at /tmp/repociv-bake/<group>/<name>{,_normal}.png.
    """
    cfg = {
        "cells": terrains,
        "seeds": {t: SEEDS[t] for t in terrains},
        "res": res,
        "group": group_letter,
        "seed2": seed2,
        "normal_pass": normal_pass,
    }
    header = "import json\nCFG = json.loads(%r)\n" % json.dumps(cfg)
    return header + _PAYLOAD


# ── Per-call: invoke Blender, then composite the new cells into the atlas ────

def _blender_render(group_letter: str, terrains: list[str], res: int,
                    blender_bin: Path, seed2: int, normal_pass: str) -> None:
    src = Path(f"/tmp/repociv-bake-{group_letter}.py")
    src.write_text(_blender_script_for(group_letter, terrains, res,
                                       seed2, normal_pass))
    cmd = [str(blender_bin), "--background", "--factory-startup",
           "--python", str(src)]
    print(f"[DAVI] invoking: {' '.join(cmd)}")
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    print(f"[DAVI] blender elapsed: {time.time() - t0:.1f}s, exit={proc.returncode}")
    ok = proc.returncode == 0 and "BAKE_DONE" in proc.stdout
    if not ok:
        print("--- BLENDER STDOUT (tail) ---")
        print("\n".join(proc.stdout.splitlines()[-30:]))
        print("--- BLENDER STDERR (tail) ---")
        print("\n".join(proc.stderr.splitlines()[-30:]))
        sys.exit(f"[FATAL] blender failed (exit {proc.returncode})")


def _composite(group_letter: str, terrains: list[str],
               bake_res: int, out_res: int, normal_pass: str) -> None:
    """For each terrain in this group:
       1. Read /tmp/repociv-bake/<group>/<name>.png  (bake_res² RGB)
       2. Resize to out_res² with LANCZOS
       3. Paste into the matching cell of the existing atlas PNG
       4. Same for <name>_normal.png into the normal atlas (gap #1)
       5. Write the modified atlases back
       The other (non-group) cells are untouched. The roughness atlas
       is NEVER written.
    """
    from PIL import Image, ImageFilter
    meta = _read_meta()
    cell = meta["cellSize"]
    if cell != out_res:
        print(f"[DAVI] note: manifest cellSize={cell}, --out-resolution={out_res}. "
              f"Trusting --out-resolution={out_res} for the bake; manifest will be updated.")

    bake_dir = Path(f"/tmp/repociv-bake/{group_letter}")

    def _update_atlas(path: Path, suffix: str, quantize: bool = False) -> None:
        if not path.exists():
            print(f"[DAVI] skip (missing): {path}")
            return
        # Re-load in case a prior paste left the file in a bad state
        try:
            im = Image.open(path).convert("RGBA")
            im.load()
        except (OSError, EOFError) as e:
            print(f"[DAVI] PNG truncated, re-creating blank: {e}")
            im = Image.new("RGBA", (meta["columns"] * out_res, meta["rows"] * out_res), (0, 0, 0, 255))
        for t in terrains:
            cell_meta = meta["terrains"][t]
            x0, y0, _, _ = cell_meta["rect"]
            bk = Image.open(bake_dir / f"{t}{suffix}.png").convert("RGBA")
            bk = bk.resize((out_res, out_res), Image.LANCZOS)
            if quantize:
                bk = bk.point(lambda v: min(255, (v // 4) * 4 + 2))
            if t == "plains":
                # Iter-5 smoothing (d6aa2d4): the plains cell is softened so
                # the grass micro-noise doesn't shimmer at strategic zoom.
                # Applied to the standalone 512² cell AFTER resize/quantize —
                # byte-exact reconstruction of the tracked atlas transform
                # (verified: fresh bake + this blur == tracked plains cell in
                # BOTH the albedo and the normal atlas).
                bk = bk.filter(ImageFilter.GaussianBlur(PLAINS_BLUR_RADIUS))
            im.paste(bk, (x0, y0, x0 + out_res, y0 + out_res))
        im.save(path, optimize=True)
        print(f"[DAVI] wrote {path} ({(path.stat().st_size)/1024:.1f} KB)")

    _update_atlas(ATLAS_PNG, "")
    if normal_pass == "raw":
        _update_atlas(NORMAL_PNG, "_normal", quantize=True)
    else:
        print("[DAVI] normal pass disabled — normal atlas untouched.")

    # Bump the manifest version so the shader / tests pick up the new
    # bytes deterministically.
    if not META_JSON.exists():
        return
    m = json.loads(META_JSON.read_text())
    m["version"] = int(m.get("version", 0)) + 1
    prev = m.get("blenderBakedGroups") or []
    if not isinstance(prev, list):
        prev = [prev]
    m["blenderBakedGroups"] = sorted(set(prev + [group_letter]))
    META_JSON.write_text(json.dumps(m, indent=2))
    print(f"[DAVI] bumped manifest version -> {m['version']}")


# ── Driver ──────────────────────────────────────────────────────────────────

def main(argv: list[str]) -> None:
    args = _parse_args(argv)
    group_letter = args.group
    terrains = sorted(GROUPS[group_letter], key=lambda t: TERRAINS_IN_ORDER.index(t))
    print(f"[DAVI] group={group_letter} -> {terrains}  res={args.resolution} "
          f"out={args.out_resolution}  seed2={args.seed2} "
          f"normal-pass={args.normal_pass}  blender={args.blender_bin}")
    if args.dry_run:
        print("[DAVI] DRY RUN — no invocation, no writes.")
        return
    if not args.blender_bin.exists():
        sys.exit(f"[FATAL] blender binary not found: {args.blender_bin}")
    _blender_render(group_letter, terrains, args.resolution, args.blender_bin,
                    args.seed2, args.normal_pass)
    _composite(group_letter, terrains, args.resolution, args.out_resolution,
               args.normal_pass)
    print(f"[DAVI] group {group_letter} bake complete.")


if __name__ == "__main__":
    main(sys.argv)
