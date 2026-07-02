#!/usr/bin/env python3
"""Blender-built low-poly wonder props for RepoCiv 3D global map.

Models the two built-in wonders as painted Civ V-style monuments and
exports deterministic binary glTF to public/assets/3d/props/:

    wonder-bibliotheca-0  — classical peripteral temple: 3 stepped stylobate
                            slabs, 12-column colonnade, entablature, gabled
                            terracotta roof with pediments
    wonder-institutum-0   — laboratorium: plinth + main hall, faceted
                            verdigris dome, side wing, twin flue stacks and
                            an emissive crystal finial

Run via:
    python3 scripts/blender/make_props_wonders.py \
        --blender-bin ~/tools/blender/blender-5.1.2-linux-x64/blender

Optional preview contact sheet (both wonders, sun + ortho cam):
    python3 scripts/blender/make_props_wonders.py --preview

Same driver+payload pattern as make_props.py: this file is run with
plain python3; it writes a bpy sub-script under /tmp and invokes the
Blender binary on it (--background --factory-startup).

Determinism contract (same as make_props.py):
    - All jitter from an explicit LCG seeded per prop.
    - Geometry from explicit pydata; no modifiers, no bmesh state.
    - glTF export settings pinned; same Blender build -> same bytes.

Model space (consumed by src/three/WonderProps3D.ts):
    - Y-up after export (export_yup=True).
    - Footprint radius ~1.0; heights: temple ~1.05, laboratorium ~1.15.
      Base (y=0) sits ON the tile top face.
    - Crystal finial uses a second, emissive material (glTF emissive
      factor) so it glows without any renderer-side special-casing.

Budgets: <=300 tris per prop, props dir total gated at 1.5MB in check.sh.
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
PREVIEW_PATH = REPO / ".hermes" / "artifacts" / "props-wonders-preview.png"
DEFAULT_BLENDER = Path.home() / "tools/blender/blender-5.1.2-linux-x64/blender"

MAX_TRIS = 300

# (prop_id, kind, seed) — seed drives every LCG in the payload.
PROPS = [
    ("wonder-bibliotheca-0", "temple", 1103),
    ("wonder-institutum-0", "lab", 1201),
]


_PAYLOAD = r'''
import bpy
import json
import math

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


# ── Palettes (vertex colors, Civ V painted look) ─────────────────────────────
STONE_LO = (0.55, 0.48, 0.36)   # shaded limestone
STONE_HI = (0.82, 0.76, 0.60)   # sunlit limestone
COL_LO = (0.68, 0.62, 0.48)     # column shaft shade
COL_HI = (0.90, 0.86, 0.72)     # column shaft light
ROOF_LO = (0.52, 0.26, 0.14)    # terracotta shade
ROOF_HI = (0.74, 0.42, 0.22)    # terracotta light
LAB_LO = (0.58, 0.55, 0.46)     # lab masonry shade
LAB_HI = (0.80, 0.77, 0.66)     # lab masonry light
DOME_LO = (0.24, 0.42, 0.34)    # verdigris copper shade
DOME_HI = (0.42, 0.62, 0.50)    # verdigris copper light
CRYSTAL = (0.42, 0.85, 0.66)    # emissive material base color


def lerp3(a, b, t):
    return (a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
            1.0)


class MeshBuilder:
    """Accumulates pydata verts/faces/colors; mat_faces marks emissive faces."""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.colors = []
        self.emissive_faces = set()

    def add(self, verts, faces, colors, emissive=False):
        base = len(self.verts)
        start = len(self.faces)
        self.verts.extend(verts)
        self.faces.extend(tuple(base + i for i in f) for f in faces)
        self.colors.extend(colors)
        if emissive:
            self.emissive_faces.update(range(start, len(self.faces)))


def add_box(mb, rng, cx, cy, z0, sx, sy, sz, lo, hi, jitter=0.0):
    """Axis-aligned box, base at z0. 12 tris. Vertex colors shade by height."""
    xs = (cx - sx, cx + sx)
    ys = (cy - sy, cy + sy)
    zs = (z0, z0 + sz)
    verts, colors = [], []
    for z in zs:
        for y in ys:
            for x in xs:
                jx = rng.range(-jitter, jitter)
                jy = rng.range(-jitter, jitter)
                verts.append((x + jx, y + jy, z))
                shade = (0.25 if z == zs[0] else 0.75) + 0.25 * rng.next01()
                colors.append(lerp3(lo, hi, min(1.0, shade)))
    # indices: bit0 = +x, bit1 = +y, bit2 = +z
    quads = [
        (0, 2, 3, 1),  # bottom (z-)
        (4, 5, 7, 6),  # top (z+)
        (0, 1, 5, 4),  # y-
        (2, 6, 7, 3),  # y+
        (0, 4, 6, 2),  # x-
        (1, 3, 7, 5),  # x+
    ]
    faces = []
    for (a, b, c, d) in quads:
        faces.append((a, b, c))
        faces.append((a, c, d))
    mb.add(verts, faces, colors)


def add_column(mb, rng, cx, cy, z0, radius, height):
    """Fluted column: 5-sided open cylinder (no caps, hidden). 10 tris."""
    n = 5
    verts, faces, colors = [], [], []
    phase = rng.range(0.0, 2.0 * math.pi)
    for zi, z in enumerate((z0, z0 + height)):
        for k in range(n):
            ang = phase + (2.0 * math.pi * k) / n
            rr = radius * (1.0 + rng.range(-0.05, 0.05))
            verts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang), z))
            colors.append(lerp3(COL_LO, COL_HI,
                                0.35 + 0.4 * zi + 0.25 * rng.next01()))
    for k in range(n):
        k2 = (k + 1) % n
        faces.append((k, k2, n + k2))
        faces.append((k, n + k2, n + k))
    mb.add(verts, faces, colors)


def add_gable_roof(mb, rng, cx, cy, z0, sx, sy, height, overhang):
    """Gabled roof: rectangular eaves + ridge line along X. 10 tris.

    Two sloped faces, two triangular pediment gables, flat under-eave."""
    ex, ey = sx + overhang, sy + overhang
    verts = [
        (cx - ex, cy - ey, z0),          # 0 eave corner
        (cx + ex, cy - ey, z0),          # 1
        (cx + ex, cy + ey, z0),          # 2
        (cx - ex, cy + ey, z0),          # 3
        (cx - sx * 0.92, cy, z0 + height),  # 4 ridge west
        (cx + sx * 0.92, cy, z0 + height),  # 5 ridge east
    ]
    colors = []
    for i, v in enumerate(verts):
        t = 0.35 if i < 4 else 0.85
        colors.append(lerp3(ROOF_LO, ROOF_HI, t + 0.15 * rng.next01()))
    faces = [
        (0, 1, 5), (0, 5, 4),        # south slope
        (2, 3, 4), (2, 4, 5),        # north slope
        (1, 2, 5),                   # east pediment
        (3, 0, 4),                   # west pediment
        (0, 3, 2), (0, 2, 1),        # under-eave (visible at grazing angles)
    ]
    mb.add(verts, faces, colors)


def add_dome(mb, rng, cx, cy, z0, radius, height, lo, hi, n=8):
    """Faceted dome: base ring + upper ring + apex. 3n tris."""
    verts, faces, colors = [], [], []
    phase = rng.range(0.0, 2.0 * math.pi)
    for (tr, tz) in ((1.0, 0.0), (0.68, 0.62)):
        for k in range(n):
            ang = phase + (2.0 * math.pi * k) / n
            rr = radius * tr * (1.0 + rng.range(-0.04, 0.04))
            verts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang),
                          z0 + height * tz))
            colors.append(lerp3(lo, hi, 0.3 + 0.5 * tz + 0.2 * rng.next01()))
    verts.append((cx, cy, z0 + height))
    colors.append(lerp3(lo, hi, 0.9))
    apex = len(verts) - 1
    for k in range(n):
        k2 = (k + 1) % n
        faces.append((k, k2, n + k2))
        faces.append((k, n + k2, n + k))
        faces.append((n + k, n + k2, apex))
    mb.add(verts, faces, colors)


def add_crystal(mb, rng, cx, cy, cz, radius):
    """Emissive octahedron finial. 8 tris, separate glTF material."""
    verts = [
        (cx + radius, cy, cz), (cx - radius, cy, cz),
        (cx, cy + radius, cz), (cx, cy - radius, cz),
        (cx, cy, cz + radius * 1.35), (cx, cy, cz - radius * 1.35),
    ]
    colors = [(CRYSTAL[0], CRYSTAL[1], CRYSTAL[2], 1.0)] * 6
    faces = [
        (0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4),
        (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5),
    ]
    mb.add(verts, faces, colors, emissive=True)


# ── Bibliotheca: classical peripteral temple ─────────────────────────────────
def build_temple(rng):
    mb = MeshBuilder()
    # 3 stepped stylobate slabs (crepidoma)
    z = 0.0
    for i, (sx, sy, sz) in enumerate(((0.95, 0.72, 0.07),
                                      (0.86, 0.63, 0.07),
                                      (0.77, 0.54, 0.07))):
        add_box(mb, rng, 0.0, 0.0, z, sx, sy, sz, STONE_LO, STONE_HI,
                jitter=0.008)
        z += (0.07, 0.07, 0.07)[i]
    # colonnade: 4 columns per long side, 2 extra per short side (12 total)
    col_h = 0.42
    col_r = 0.055
    xs = (-0.60, -0.20, 0.20, 0.60)
    for x in xs:
        for y in (-0.40, 0.40):
            add_column(mb, rng, x, y, z, col_r, col_h)
    for y in (-0.13, 0.13):
        for x in (-0.60, 0.60):
            add_column(mb, rng, x, y, z, col_r, col_h)
    # cella (inner sanctuary block) — reads through the columns
    add_box(mb, rng, 0.0, 0.0, z, 0.42, 0.26, col_h * 0.94,
            STONE_LO, STONE_HI, jitter=0.006)
    z += col_h
    # entablature slab
    add_box(mb, rng, 0.0, 0.0, z, 0.72, 0.50, 0.08, STONE_LO, STONE_HI,
            jitter=0.005)
    z += 0.08
    # gabled terracotta roof with pediments
    add_gable_roof(mb, rng, 0.0, 0.0, z, 0.72, 0.50, 0.26, 0.06)
    return mb


# ── Institutum: laboratorium with dome + flues ───────────────────────────────
def build_lab(rng):
    mb = MeshBuilder()
    # plinth
    add_box(mb, rng, 0.0, 0.0, 0.0, 0.92, 0.78, 0.10, LAB_LO, LAB_HI,
            jitter=0.008)
    # main hall
    hall_h = 0.42
    add_box(mb, rng, -0.12, 0.0, 0.10, 0.55, 0.48, hall_h, LAB_LO, LAB_HI,
            jitter=0.006)
    # side wing (lower annex, east)
    wing_h = 0.26
    add_box(mb, rng, 0.60, -0.16, 0.10, 0.28, 0.34, wing_h, LAB_LO, LAB_HI,
            jitter=0.006)
    # faceted verdigris dome over the hall
    dome_r = 0.40
    dome_h = 0.34
    add_dome(mb, rng, -0.12, 0.0, 0.10 + hall_h, dome_r, dome_h,
             DOME_LO, DOME_HI, n=8)
    # twin flue stacks on the wing
    for i, (fx, fy) in enumerate(((0.52, -0.30), (0.70, -0.02))):
        fh = (0.34, 0.26)[i]
        add_box(mb, rng, fx, fy, 0.10 + wing_h, 0.045, 0.045, fh,
                LAB_LO, LAB_HI)
    # emissive crystal finial floating just above the dome apex
    add_crystal(mb, rng, -0.12, 0.0, 0.10 + hall_h + dome_h + 0.10, 0.09)
    return mb


BUILDERS = {
    "temple": build_temple,
    "lab": build_lab,
}


def realize(prop_id, mb):
    mesh = bpy.data.meshes.new(prop_id)
    mesh.from_pydata(mb.verts, [], mb.faces)
    mesh.update()

    attr = mesh.color_attributes.new(name="Col", type='FLOAT_COLOR', domain='POINT')
    for i, c in enumerate(mb.colors):
        attr.data[i].color = c

    for poly in mesh.polygons:
        poly.use_smooth = False

    def make_mat(name, emissive):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        bsdf = nodes["Principled BSDF"]
        vcol = nodes.new("ShaderNodeVertexColor")
        vcol.layer_name = "Col"
        links.new(vcol.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = 0.92
        bsdf.inputs["Metallic"].default_value = 0.0
        if emissive:
            bsdf.inputs["Emission Color"].default_value = (*CRYSTAL, 1.0)
            bsdf.inputs["Emission Strength"].default_value = 2.0
            bsdf.inputs["Roughness"].default_value = 0.25
        return mat

    mesh.materials.append(make_mat(f"{prop_id}-mat", False))
    has_emissive = bool(mb.emissive_faces)
    if has_emissive:
        mesh.materials.append(make_mat(f"{prop_id}-glow", True))
        for fi in mb.emissive_faces:
            mesh.polygons[fi].material_index = 1

    obj = bpy.data.objects.new(prop_id, mesh)
    bpy.context.collection.objects.link(obj)
    return obj, len(mesh.loop_triangles)


def export_glb(obj, out):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
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
    obj.select_set(False)


def render_preview(objs, path):
    """Contact sheet: wonders side by side, sun light, ortho camera."""
    spacing = 3.0
    for i, obj in enumerate(objs):
        obj.location = (i * spacing, 0.0, 0.0)

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", type='SUN'))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(55), 0.0, math.radians(30))
    bpy.context.collection.objects.link(sun)

    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = len(objs) * spacing + 1.0
    cam = bpy.data.objects.new("cam", cam_data)
    cx = (len(objs) - 1) * spacing / 2.0
    cam.location = (cx, -9.0, 7.5)
    cam.rotation_euler = (math.radians(52), 0.0, 0.0)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 32
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 640
    scene.render.filepath = path
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.75, 0.82, 0.88, 1.0)
    scene.world = world
    bpy.ops.render.render(write_still=True)


def main():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

    report = []
    objs = []
    for prop_id, kind, seed in CONFIG["props"]:
        rng = Lcg(seed)
        mb = BUILDERS[kind](rng)
        obj, tris = realize(prop_id, mb)
        out = CONFIG["out_dir"] + f"/{prop_id}.glb"
        export_glb(obj, out)
        report.append({"prop": prop_id, "tris": tris, "path": out})
        objs.append(obj)

    if CONFIG.get("preview"):
        render_preview(objs, CONFIG["preview"])

    print("PROPS_REPORT=" + json.dumps(report))


main()
'''


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--blender-bin", type=Path,
                        default=Path(os.environ.get("BLENDER_BIN", DEFAULT_BLENDER)))
    parser.add_argument("--preview", action="store_true",
                        help="also render a contact sheet PNG of both wonders")
    return parser.parse_args(argv)


def main(argv: list[str]) -> None:
    args = _parse_args(argv)
    if not args.blender_bin.exists():
        sys.exit(f"[FATAL] blender binary not found: {args.blender_bin}")

    PROPS_DIR.mkdir(parents=True, exist_ok=True)
    if args.preview:
        PREVIEW_PATH.parent.mkdir(parents=True, exist_ok=True)

    config = {
        "props": PROPS,
        "out_dir": str(PROPS_DIR),
        "preview": str(PREVIEW_PATH) if args.preview else None,
    }
    header = f"CONFIG_JSON = {json.dumps(json.dumps(config))}\n"
    with tempfile.NamedTemporaryFile(
        "w", prefix="repociv-wonders-", suffix=".py", delete=False
    ) as fh:
        fh.write(header + _PAYLOAD)
        script_path = fh.name

    cmd = [str(args.blender_bin), "--background", "--factory-startup",
           "--python", script_path]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    sys.stdout.write(proc.stdout)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(f"[FATAL] blender exited {proc.returncode}")

    report_line = next(
        (ln for ln in proc.stdout.splitlines() if ln.startswith("PROPS_REPORT=")), None)
    if report_line is None:
        sys.exit("[FATAL] payload did not emit PROPS_REPORT")
    report = json.loads(report_line[len("PROPS_REPORT="):])

    for entry in report:
        path = Path(entry["path"])
        if not path.exists():
            sys.exit(f"[FATAL] missing output: {path}")
        if entry["tris"] > MAX_TRIS:
            sys.exit(f"[FATAL] {entry['prop']}: {entry['tris']} tris > {MAX_TRIS}")
        print(f"[OK] {entry['prop']}.glb: {entry['tris']} tris, {path.stat().st_size} bytes")

    total = sum(p.stat().st_size for p in PROPS_DIR.glob("*.glb"))
    print(f"[OK] props dir total: {total} bytes")
    if args.preview:
        print(f"[OK] preview: {PREVIEW_PATH}")

    os.unlink(script_path)


if __name__ == "__main__":
    main(sys.argv[1:])
