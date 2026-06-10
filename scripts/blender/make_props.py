#!/usr/bin/env python3
"""Blender-built low-poly mountain props for RepoCiv 3D global map (iter3 gap #3).

Models 3 faceted Civ V-style peak variants and exports deterministic
binary glTF to public/assets/3d/props/mountain-{0,1,2}.glb:

    variant 0 — single tall spire
    variant 1 — twin peak (main + lower secondary)
    variant 2 — broad 3-bump massif

Run via:
    python3 scripts/blender/make_props.py \
        --blender-bin ~/tools/blender/blender-5.1.2-linux-x64/blender

Same driver+payload pattern as bake_atlas.py: this file is run with
plain python3; it writes a bpy sub-script under /tmp and invokes the
Blender binary on it (--background --factory-startup).

Determinism contract:
    - All vertex jitter comes from an explicit LCG (same constants as the
      golden-capture scripts), seeded per (variant, peak, vertex). No
      Python `random`, no `bpy` RNG, no timestamps.
    - Geometry is built from explicit pydata (vertices + faces); no
      modifiers, no booleans, no bmesh ops with internal state.
    - glTF export settings are pinned; same Blender build -> same bytes.

Model space (consumed by src/three/MountainProps3D.ts):
    - Y-up after export (export_yup=True maps Blender Z-up -> glTF Y-up).
    - Footprint radius ~1.0, peak heights ~1.5-1.9. The renderer scales
      uniformly by ~0.4 * HEX_SIZE so a massif fills most of a tile.
    - Base (y=0) sits ON the tile top face.

Budgets / constraints (NO TOCAR list honored):
    - <=300 tris per variant (validated here, hard fail).
    - <=1.5MB total under public/assets/3d/props/ (also gated in check.sh).
    - bake_atlas.py, atlas PNGs, manifest: untouched.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(os.environ.get("REPOCIV_REPO", Path.cwd()))
PROPS_DIR = REPO / "public" / "assets" / "3d" / "props"
DEFAULT_BLENDER = Path.home() / "tools/blender/blender-5.1.2-linux-x64/blender"

MAX_TRIS = 300
MAX_TOTAL_BYTES = 1536 * 1024

# Peak layout per variant: (cx, cz, base_radius, height, seed)
# Coordinates are model-space (footprint ~ radius 1), heights pre-scaled.
VARIANTS = [
    # 0 — single tall spire
    [
        (0.00, 0.00, 1.00, 1.90, 11),
    ],
    # 1 — twin peak
    [
        (-0.22, 0.10, 0.85, 1.70, 23),
        (0.52, -0.30, 0.55, 1.05, 37),
    ],
    # 2 — broad massif, 3 bumps
    [
        (-0.40, -0.15, 0.70, 1.15, 53),
        (0.30, 0.05, 0.80, 1.45, 67),
        (0.05, 0.55, 0.50, 0.85, 79),
    ],
]


_PAYLOAD = r'''
import bpy
import json
import math
import sys

CONFIG = json.loads(CONFIG_JSON)

# ── Deterministic LCG (no Python random) ─────────────────────────────────────
class Lcg:
    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF

    def next01(self):
        self.s = (1664525 * self.s + 1013904223) & 0xFFFFFFFF
        return self.s / 4294967296.0

    def range(self, lo, hi):
        return lo + (hi - lo) * self.next01()


ROCK_LO = (0.336, 0.325, 0.310)   # dark rock crevices
ROCK_HI = (0.522, 0.512, 0.494)   # lit rock
SNOW = (0.945, 0.957, 0.973)


def peak_mesh_data(cx, cz, radius, height, seed, base_index):
    """One faceted spire: 3 jittered rings + apex + base cap.

    Returns (verts, faces, colors) with faces indexed from base_index.
    Blender is Z-up here; export_yup converts to glTF Y-up.
    """
    n = 7
    rng = Lcg(seed)
    rings_t = (0.0, 0.42, 0.74)
    ring_r = (1.0, 0.55, 0.27)
    verts = []
    colors = []

    snow_line = 0.60 * height

    def vcolor(z, jitter):
        if z >= snow_line:
            return (*SNOW, 1.0)
        shade = 0.35 + 0.65 * jitter
        r = ROCK_LO[0] + (ROCK_HI[0] - ROCK_LO[0]) * shade
        g = ROCK_LO[1] + (ROCK_HI[1] - ROCK_LO[1]) * shade
        b = ROCK_LO[2] + (ROCK_HI[2] - ROCK_LO[2]) * shade
        return (r, g, b, 1.0)

    phase = rng.range(0.0, 2.0 * math.pi)
    for t, rr in zip(rings_t, ring_r):
        z = t * height
        for k in range(n):
            ang = phase + (2.0 * math.pi * k) / n + rng.range(-0.10, 0.10)
            rad = radius * rr * (1.0 + rng.range(-0.16, 0.16))
            zz = z + height * rng.range(-0.035, 0.035) if t > 0 else 0.0
            verts.append((cx + rad * math.cos(ang), cz + rad * math.sin(ang), zz))
            colors.append(vcolor(zz, rng.next01()))

    apex_x = cx + radius * rng.range(-0.10, 0.10)
    apex_y = cz + radius * rng.range(-0.10, 0.10)
    verts.append((apex_x, apex_y, height))
    colors.append((*SNOW, 1.0))
    apex = len(verts) - 1

    verts.append((cx, cz, 0.0))
    colors.append(vcolor(0.0, 0.3))
    base_c = len(verts) - 1

    faces = []
    for ring in range(2):
        a0 = ring * n
        b0 = (ring + 1) * n
        for k in range(n):
            k2 = (k + 1) % n
            faces.append((a0 + k, a0 + k2, b0 + k2))
            faces.append((a0 + k, b0 + k2, b0 + k))
    top0 = 2 * n
    for k in range(n):
        faces.append((top0 + k, top0 + (k + 1) % n, apex))
    for k in range(n):
        faces.append((base_c, (k + 1) % n, k))

    faces = [tuple(base_index + i for i in f) for f in faces]
    return verts, faces, colors


def build_variant(variant_index, peaks):
    verts = []
    faces = []
    colors = []
    for (cx, cz, radius, height, seed) in peaks:
        v, f, c = peak_mesh_data(cx, cz, radius, height, seed, len(verts))
        verts.extend(v)
        faces.extend(f)
        colors.extend(c)

    mesh = bpy.data.meshes.new(f"mountain-{variant_index}")
    mesh.from_pydata(verts, [], faces)
    mesh.update()

    attr = mesh.color_attributes.new(name="Col", type='FLOAT_COLOR', domain='POINT')
    for i, c in enumerate(colors):
        attr.data[i].color = c

    # Flat shading for the faceted Civ V look
    for poly in mesh.polygons:
        poly.use_smooth = False

    mat = bpy.data.materials.new(f"mountain-rock-{variant_index}")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    vcol = nodes.new("ShaderNodeVertexColor")
    vcol.layer_name = "Col"
    links.new(vcol.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.92
    bsdf.inputs["Metallic"].default_value = 0.0
    mesh.materials.append(mat)

    obj = bpy.data.objects.new(f"mountain-{variant_index}", mesh)
    bpy.context.collection.objects.link(obj)
    return obj, len(mesh.loop_triangles)


def main():
    # Empty scene
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

    report = []
    for variant_index, peaks in enumerate(CONFIG["variants"]):
        obj, tris = build_variant(variant_index, peaks)

        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj

        out = CONFIG["out_dir"] + f"/mountain-{variant_index}.glb"
        bpy.ops.export_scene.gltf(
            filepath=out,
            export_format='GLB',
            use_selection=True,
            export_yup=True,
            export_apply=True,
            export_animations=False,
            export_skins=False,
            export_morph=False,
            export_materials='EXPORT',
            export_vertex_color='MATERIAL',
            export_normals=True,
            export_texcoords=False,
            export_tangents=False,
            export_extras=False,
            export_cameras=False,
            export_lights=False,
        )
        report.append({"variant": variant_index, "tris": tris, "path": out})
        obj.select_set(False)

    print("PROPS_REPORT=" + json.dumps(report))


main()
'''


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--blender-bin", type=Path,
                        default=Path(os.environ.get("BLENDER_BIN", DEFAULT_BLENDER)))
    return parser.parse_args(argv)


def main(argv: list[str]) -> None:
    args = _parse_args(argv)
    if not args.blender_bin.exists():
        sys.exit(f"[FATAL] blender binary not found: {args.blender_bin}")

    PROPS_DIR.mkdir(parents=True, exist_ok=True)

    config = {"variants": VARIANTS, "out_dir": str(PROPS_DIR)}
    header = f"CONFIG_JSON = {json.dumps(json.dumps(config))}\n"
    with tempfile.NamedTemporaryFile(
        "w", prefix="repociv-props-", suffix=".py", delete=False
    ) as fh:
        fh.write(header + _PAYLOAD)
        script_path = fh.name

    cmd = [str(args.blender_bin), "--background", "--factory-startup",
           "--python", script_path]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    sys.stdout.write(proc.stdout)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(f"[FATAL] blender exited {proc.returncode}")

    report_line = next(
        (ln for ln in proc.stdout.splitlines() if ln.startswith("PROPS_REPORT=")), None)
    if report_line is None:
        sys.exit("[FATAL] payload did not emit PROPS_REPORT")
    report = json.loads(report_line[len("PROPS_REPORT="):])

    total = 0
    for entry in report:
        path = Path(entry["path"])
        if not path.exists():
            sys.exit(f"[FATAL] missing output: {path}")
        size = path.stat().st_size
        total += size
        if entry["tris"] > MAX_TRIS:
            sys.exit(f"[FATAL] variant {entry['variant']}: {entry['tris']} tris > {MAX_TRIS}")
        print(f"[OK] mountain-{entry['variant']}.glb: {entry['tris']} tris, {size} bytes")
    if total > MAX_TOTAL_BYTES:
        sys.exit(f"[FATAL] props total {total} bytes > {MAX_TOTAL_BYTES}")
    print(f"[OK] props total: {total} bytes (budget {MAX_TOTAL_BYTES})")

    os.unlink(script_path)


if __name__ == "__main__":
    main(sys.argv[1:])
