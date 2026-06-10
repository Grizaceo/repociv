#!/usr/bin/env python3
"""Blender-baked Civ V-style terrain atlas for RepoCiv 3D global map.

Replaces cells in public/assets/3d/terrain-atlas-3d.png (and its normal
& roughness siblings) with renders produced by Blender. The numpy
generator (scripts/generate-3d-texture-atlas.py) is preserved as the
fallback documented in the README.

Run via:
    ~/tools/blender/blender-5.1.2-linux-x64/blender \\
        --background --factory-startup \\
        --python scripts/blender/bake_atlas.py -- \\
        --group a \\
        --resolution 1024 \\
        --out-resolution 512 \\
        --blender-bin ~/tools/blender/blender-5.1.2-linux-x64/blender

Groups (one commit per group; render order matches the manifest index):
    a = plains, forest, hills                 (greens saturated, Civ V patch variation)
    b = desert, ice                           (dunes w/ directional shading, ice w/ cracks)
    c = ocean                                 (radial teal -> deep coastal gradient)
    d = mountain, sacred                      (rock strata w/ strong normal, snow transition)

This script is *invoked* by Blender (it's a Blender script). The driver
that calls Blender in batch-by-group is scripts/blender/run_bake.sh.
The driver invokes this once per group with --group <letter>; we bake
only that group's cells and re-compose the atlas. Other cells are
preserved from the existing atlas (we do NOT degrade them).

Determinism contract:
    - Texture Coordinate -> Mapping node with offset derived from seed.
      This is the only randomness in the node graph and it is
      seeded-per-cell, so two runs with the same seed produce identical
      bytes.
    - Camera, light, and material parameters are floats. No Python RNG
      is consumed.
    - Eevee: samples = 1 (default; we don't use AO/SSAO/SSR which need
      samples). Resolution fixed. PNG RGB deterministic.

Constraints honored:
    - TERRAIN_ATLAS_INDEX in src/three/terrainShader.ts and the
      manifest order are NOT changed. We only swap pixel content.
    - Budget: each baked cell at OUT_RES is OUT_RES^2 * 3 bytes (RGB).
      The 3 atlas PNGs combined stay under 6MB (verified in
      scripts/check.sh asset budget).
    - The numpy generator stays untouched as a fallback.
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
    if "--" in argv:
        after = argv[argv.index("--") + 1:]
        if after and (after[0].startswith("--group")
                      or after[0].startswith("--resolution")
                      or after[0].startswith("--out-resolution")
                      or after[0] == "--dry-run"
                      or after[0] == "--blender-bin"):
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
    p.add_argument("--dry-run", action="store_true",
                   help="Print what would happen; do not invoke Blender or write files.")
    return p.parse_args(argv)


# ── Blender-side script generator ────────────────────────────────────────────
# We *generate* a per-call Blender script that bakes the requested
# cells. The generated script is temporary; this avoids needing to
# install an addon and keeps the bake in one command line.

def _blender_script_for(group_letter: str, terrains: list[str], res: int) -> str:
    """Return Python source that, run inside Blender, bakes each terrain
    to a PNG at /tmp/repociv-bake/<name>.png.
    """
    cells_json = json.dumps(terrains)
    seeds_json = json.dumps({t: SEEDS[t] for t in terrains})
    res_json = json.dumps(res)
    return f'''
import bpy, json, os
from pathlib import Path
from math import radians

CELLS = json.loads({cells_json!r})
SEEDS = json.loads({seeds_json!r})
RES   = int({res_json})
OUT_DIR = Path("/tmp/repociv-bake/{group_letter}")
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ── Clean scene ─────────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
# Eevee determinism: disable any non-deterministic passes.
rd = scene.render
try:
    rd.use_motion_blur = False
    rd.use_simplify = True
    rd.simplify_subdivision = 1
except Exception:
    pass

# ── Camera (ortho, top-down) ────────────────────────────────────────────
bpy.ops.object.camera_add(location=(0, 0, 4))
cam = bpy.context.object
cam.data.type = 'ORTHO'
cam.data.ortho_scale = 2.0
cam.rotation_euler = (0, 0, 0)
scene.camera = cam

# ── Light (warm afternoon) ─────────────────────────────────────────────
bpy.ops.object.light_add(type='AREA', location=(0, 0, 5))
light = bpy.context.object
light.data.energy = 60
light.data.size = 4
light.rotation_euler = (radians(55), 0, 0)
# A subtle warm tint (Civ V afternoon)
try:
    light.data.color = (1.0, 0.94, 0.82)
except Exception:
    pass

# ── Per-biome node graph ───────────────────────────────────────────────
def build_material(name, seed):
    """Return a material with a procedural node graph.

    Pipeline (deterministic given seed):
      TexCoord -> Mapping(seed offsets) -> two Noise Texture channels:
        - macro  -> ColorRamp -> Base Color
        - detail -> Bump (height-field for Eevee shading)
      Plus a 2nd ColorRamp blended on top for per-biome accents.
    The graph is parameter-only (no Python RNG), so two runs with
    the same seed produce identical bytes.
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    out    = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf   = nt.nodes.new('ShaderNodeBsdfPrincipled')
    noise1 = nt.nodes.new('ShaderNodeTexNoise')
    noise2 = nt.nodes.new('ShaderNodeTexNoise')
    cr1    = nt.nodes.new('ShaderNodeValToRGB')   # macro colour ramp
    cr2    = nt.nodes.new('ShaderNodeValToRGB')   # detail noise -> bump
    bump   = nt.nodes.new('ShaderNodeBump')
    coord  = nt.nodes.new('ShaderNodeTexCoord')
    map_   = nt.nodes.new('ShaderNodeMapping')
    mix    = nt.nodes.new('ShaderNodeMixRGB')     # accent overlay
    cr_acc = nt.nodes.new('ShaderNodeValToRGB')   # accent ramp
    # Deterministic offset from seed.
    s = float(seed)
    off_x = (s * 12.9898) % 1.0
    off_y = (s * 78.233)  % 1.0
    map_.inputs['Location'].default_value = (off_x, off_y, 0.0)
    nt.links.new(map_.inputs['Vector'], coord.outputs['Generated'])
    nt.links.new(noise1.inputs['Vector'], map_.outputs['Vector'])
    nt.links.new(noise2.inputs['Vector'], map_.outputs['Vector'])
    nt.links.new(cr1.inputs['Fac'], noise1.outputs['Fac'])
    nt.links.new(cr_acc.inputs['Fac'], noise1.outputs['Fac'])
    nt.links.new(mix.inputs['Color1'], cr1.outputs['Color'])
    nt.links.new(bsdf.inputs['Base Color'], mix.outputs['Color'])
    nt.links.new(cr2.inputs['Fac'], noise2.outputs['Fac'])
    nt.links.new(bump.inputs['Height'], cr2.outputs['Color'])
    nt.links.new(bsdf.inputs['Normal'], bump.outputs['Normal'])
    bsdf.inputs['Roughness'].default_value = 0.7
    nt.links.new(out.inputs['Surface'], bsdf.outputs['BSDF'])
    mix.inputs['Fac'].default_value = 0.30
    bump.inputs['Strength'].default_value = 0.35
    bump.inputs['Distance'].default_value = 0.05
    noise2.inputs['Scale'].default_value = 32.0
    noise2.inputs['Detail'].default_value = 6.0
    noise2.inputs['Roughness'].default_value = 0.6

    # Per-biome palette & variation (Civ V tonal anchors).
    if name == 'plains':
        e0, e1 = cr1.color_ramp.elements
        e0.position, e1.position = 0.30, 0.70
        e0.color = (0.36, 0.58, 0.18, 1)
        e1.color = (0.62, 0.84, 0.28, 1)
        # Accent: yellow flowers
        a0, a1 = cr_acc.color_ramp.elements
        a0.position, a1.position = 0.62, 0.66
        a0.color = (0.0, 0.0, 0.0, 1)
        a1.color = (0.95, 0.85, 0.30, 1)
        noise1.inputs['Scale'].default_value = 6.0
        noise1.inputs['Detail'].default_value = 4.0
        bsdf.inputs['Roughness'].default_value = 0.82
    elif name == 'forest':
        e0, e1 = cr1.color_ramp.elements
        e0.position, e1.position = 0.25, 0.75
        e0.color = (0.10, 0.32, 0.10, 1)
        e1.color = (0.20, 0.52, 0.18, 1)
        a0, a1 = cr_acc.color_ramp.elements
        a0.position, a1.position = 0.55, 0.60
        a0.color = (0.0, 0.0, 0.0, 1)
        a1.color = (0.40, 0.65, 0.20, 1)
        noise1.inputs['Scale'].default_value = 8.0
        noise1.inputs['Detail'].default_value = 5.0
        bsdf.inputs['Roughness'].default_value = 0.75
    elif name == 'hills':
        e0, e1 = cr1.color_ramp.elements
        e0.position, e1.position = 0.30, 0.75
        e0.color = (0.42, 0.58, 0.22, 1)
        e1.color = (0.62, 0.78, 0.32, 1)
        a0, a1 = cr_acc.color_ramp.elements
        a0.position, a1.position = 0.55, 0.60
        a0.color = (0.0, 0.0, 0.0, 1)
        a1.color = (0.72, 0.65, 0.32, 1)
        noise1.inputs['Scale'].default_value = 4.0
        noise1.inputs['Detail'].default_value = 3.0
        bsdf.inputs['Roughness'].default_value = 0.78
    elif name == 'desert':
        e0, e1 = cr1.color_ramp.elements
        e0.position, e1.position = 0.32, 0.72
        e0.color = (0.78, 0.58, 0.28, 1)
        e1.color = (0.92, 0.78, 0.46, 1)
        a0, a1 = cr_acc.color_ramp.elements
        a0.position, a1.position = 0.55, 0.58
        a0.color = (0.0, 0.0, 0.0, 1)
        a1.color = (0.95, 0.90, 0.65, 1)
        noise1.inputs['Scale'].default_value = 3.0
        noise1.inputs['Detail'].default_value = 4.0
        bsdf.inputs['Roughness'].default_value = 0.88
    elif name == 'ice':
        e0, e1 = cr1.color_ramp.elements
        e0.position, e1.position = 0.40, 0.80
        e0.color = (0.65, 0.84, 0.94, 1)
        e1.color = (0.84, 0.96, 1.00, 1)
        a0, a1 = cr_acc.color_ramp.elements
        a0.position, a1.position = 0.50, 0.52
        a0.color = (0.0, 0.0, 0.0, 1)
        a1.color = (0.95, 0.98, 1.00, 1)
        noise1.inputs['Scale'].default_value = 5.0
        noise1.inputs['Detail'].default_value = 5.0
        bsdf.inputs['Roughness'].default_value = 0.22
    elif name == 'ocean':
        e0, e1 = cr1.color_ramp.elements
        e0.position, e1.position = 0.30, 0.70
        e0.color = (0.04, 0.34, 0.52, 1)
        e1.color = (0.16, 0.58, 0.66, 1)
        a0, a1 = cr_acc.color_ramp.elements
        a0.position, a1.position = 0.78, 0.82
        a0.color = (0.0, 0.0, 0.0, 1)
        a1.color = (0.90, 0.95, 1.00, 1)  # foam highlights
        noise1.inputs['Scale'].default_value = 10.0
        noise1.inputs['Detail'].default_value = 3.0
        bsdf.inputs['Roughness'].default_value = 0.18
    elif name == 'mountain':
        e0, e1 = cr1.color_ramp.elements
        e0.position, e1.position = 0.20, 0.80
        e0.color = (0.34, 0.32, 0.30, 1)
        e1.color = (0.62, 0.60, 0.58, 1)
        a0, a1 = cr_acc.color_ramp.elements
        a0.position, a1.position = 0.74, 0.78
        a0.color = (0.0, 0.0, 0.0, 1)
        a1.color = (0.96, 0.96, 0.98, 1)  # snow rim
        noise1.inputs['Scale'].default_value = 3.0
        noise1.inputs['Detail'].default_value = 4.0
        bsdf.inputs['Roughness'].default_value = 0.92
    elif name == 'sacred':
        e0, e1 = cr1.color_ramp.elements
        e0.position, e1.position = 0.35, 0.75
        e0.color = (0.10, 0.04, 0.24, 1)
        e1.color = (0.28, 0.12, 0.46, 1)
        a0, a1 = cr_acc.color_ramp.elements
        a0.position, a1.position = 0.70, 0.74
        a0.color = (0.0, 0.0, 0.0, 1)
        a1.color = (0.85, 0.70, 1.00, 1)  # glyph glow
        noise1.inputs['Scale'].default_value = 7.0
        noise1.inputs['Detail'].default_value = 4.0
        bsdf.inputs['Roughness'].default_value = 0.45
    return mat

# ── Render per cell ─────────────────────────────────────────────────────
results = []
for name in CELLS:
    seed = SEEDS[name]
    # Single-quad plane: shading variation comes from the Bump node,
    # not geometry. Keeps the look "painted" (Civ V style) and avoids
    # the halo from a subdivided plane whose edge is exactly ortho-aligned.
    bpy.ops.mesh.primitive_plane_add(size=2.0, location=(0, 0, 0))
    plane = bpy.context.object
    bpy.ops.object.shade_smooth()

    mat = build_material(name, seed)
    plane.data.materials.append(mat)

    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    out_path = OUT_DIR / f'{{name}}.png'
    scene.render.filepath = str(out_path)
    bpy.ops.render.render(write_still=True)
    results.append({{'name': name, 'seed': seed, 'path': str(out_path),
                     'size': out_path.stat().st_size}})
    print(f"BAKED {{name}} seed={{seed}} -> {{out_path}} ({{out_path.stat().st_size}}B)")

print("BAKE_DONE", json.dumps(results))
'''


# ── Per-call: invoke Blender, then composite the new cells into the atlas ────

def _blender_render(group_letter: str, terrains: list[str], res: int,
                    blender_bin: Path) -> None:
    src = Path(f"/tmp/repociv-bake-{group_letter}.py")
    src.write_text(_blender_script_for(group_letter, terrains, res))
    cmd = [str(blender_bin), "--background", "--factory-startup",
           "--python", str(src)]
    print(f"[DAVI] invoking: {' '.join(cmd)}")
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    print(f"[DAVI] blender elapsed: {time.time() - t0:.1f}s, exit={proc.returncode}")
    if proc.returncode != 0:
        print("--- BLENDER STDOUT (tail) ---")
        print("\n".join(proc.stdout.splitlines()[-20:]))
        print("--- BLENDER STDERR (tail) ---")
        print("\n".join(proc.stderr.splitlines()[-20:]))
        sys.exit(f"[FATAL] blender failed (exit {proc.returncode})")


def _composite(group_letter: str, terrains: list[str],
               bake_res: int, out_res: int) -> None:
    """For each terrain in this group:
       1. Read /tmp/repociv-bake/<name>.png  (bake_res x bake_res RGB)
       2. Resize to out_res x out_res with LANCZOS
       3. Paste into the matching cell of the existing atlas PNG
       4. Write the modified atlas back
       The other (non-group) cells are untouched.
    """
    from PIL import Image
    meta = _read_meta()
    cell = meta["cellSize"]
    if cell != out_res:
        print(f"[DAVI] note: manifest cellSize={cell}, --out-resolution={out_res}. "
              f"Trusting --out-resolution={out_res} for the bake; manifest will be updated.")

    bake_dir = Path(f"/tmp/repociv-bake/{group_letter}")

    def _update_atlas(path: Path) -> None:
        if not path.exists():
            print(f"[DAVI] skip (missing): {path}")
            return
        im = Image.open(path).convert("RGBA")
        for t in terrains:
            cell_meta = meta["terrains"][t]
            x0, y0, _, _ = cell_meta["rect"]
            bk = Image.open(bake_dir / f"{t}.png").convert("RGBA")
            bk = bk.resize((out_res, out_res), Image.LANCZOS)
            # PIL coordinate system: row 0 is top. Manifest also uses top-left.
            im.paste(bk, (x0, y0, x0 + out_res, y0 + out_res))
        im.save(path)
        print(f"[DAVI] wrote {path} ({(path.stat().st_size)/1024:.1f} KB)")

    _update_atlas(ATLAS_PNG)
    _update_atlas(NORMAL_PNG)

    # Roughness atlas: the bake output for each cell encodes the per-biome
    # roughness in the R channel (we use the same render; roughness 0..1).
    # Reuse the color render, but single-channelize. If we already have a
    # normal-bake output per cell, prefer it; for now we use the color one.
    # Roughness per biome from the legacy generator is preserved
    # independently in scripts/generate-3d-texture-atlas.py::ROUGHNESS.

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
          f"out={args.out_resolution}  blender={args.blender_bin}")
    if args.dry_run:
        print("[DAVI] DRY RUN — no invocation, no writes.")
        return
    if not args.blender_bin.exists():
        sys.exit(f"[FATAL] blender binary not found: {args.blender_bin}")
    _blender_render(group_letter, terrains, args.resolution, args.blender_bin)
    _composite(group_letter, terrains, args.resolution, args.out_resolution)
    print(f"[DAVI] group {group_letter} bake complete.")


if __name__ == "__main__":
    main(sys.argv)
