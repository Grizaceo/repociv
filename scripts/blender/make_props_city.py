#!/usr/bin/env python3
"""Blender-built low-poly city-level props for RepoCiv 3D global map.

Civ V grows its city sprawl with population; RepoCiv's procedural cluster
(CityCluster3D.ts) already scales plaza/walls/spires by level, but every
non-capital city shares the same generic box houses. These GLBs give each
level a distinct centrepiece, exported to public/assets/3d/props/:

    city-hamlet-0   — level 0: lone longhouse + lean-to shed
    city-village-0  — level 1: two houses + small watchtower
    city-town-0     — levels 2-3: central bell tower + three houses

Run via:
    python3 scripts/blender/make_props_city.py \
        --blender-bin ~/tools/blender/blender-5.1.2-linux-x64/blender

Optional preview contact sheet:
    python3 scripts/blender/make_props_city.py --preview

Same driver+payload + determinism contract as make_props_vegetation.py
(explicit LCG, pure pydata, pinned glTF export). Model space: Y-up after
export, footprint radius ~1.0, base at y=0 ON the tile top face. Palette
matches the procedural cluster: pale stucco walls, terracotta roofs.
Consumed by src/three/CityProps3D.ts. Budget <=300 tris per prop.
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
PREVIEW_PATH = REPO / ".hermes" / "artifacts" / "props-city-preview.png"
DEFAULT_BLENDER = Path.home() / "tools/blender/blender-5.1.2-linux-x64/blender"

MAX_TRIS = 300

PROPS = [
    ("city-hamlet-0", "hamlet", 1013),
    ("city-village-0", "village", 1109),
    ("city-town-0", "town", 1201),
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


# ── Palette (matches CityCluster3D procedural buildings) ─────────────────────
WALL_LO = (0.62, 0.59, 0.52)   # shaded stucco
WALL_HI = (0.80, 0.77, 0.70)   # sunlit stucco (0xc8c0b0)
ROOF_LO = (0.55, 0.26, 0.17)
ROOF_HI = (0.72, 0.36, 0.24)   # terracotta (0xb0563a)
STONE_LO = (0.55, 0.53, 0.49)
STONE_HI = (0.72, 0.70, 0.65)  # watchtower masonry
TIMBER = (0.36, 0.28, 0.19)


def lerp3(a, b, t):
    return (a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
            1.0)


class MeshBuilder:
    def __init__(self):
        self.verts = []
        self.faces = []
        self.colors = []

    def add(self, verts, faces, colors):
        base = len(self.verts)
        self.verts.extend(verts)
        self.faces.extend(tuple(base + i for i in f) for f in faces)
        self.colors.extend(colors)


def rot2(x, y, ang):
    c, s = math.cos(ang), math.sin(ang)
    return (x * c - y * s, x * s + y * c)


def add_house(mb, rng, cx, cy, w, d, wall_h, roof_h, ang):
    """Stucco box + terracotta gable roof (ridge along the w axis)."""
    hw, hd = w / 2.0, d / 2.0
    corners = [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)]
    verts, colors = [], []
    # walls: bottom ring 0-3, top ring 4-7
    for z in (0.0, wall_h):
        for (x, y) in corners:
            rx, ry = rot2(x, y, ang)
            verts.append((cx + rx, cy + ry, z))
            shade = 0.25 + 0.75 * (z / wall_h if wall_h else 0) * rng.range(0.7, 1.0)
            colors.append(lerp3(WALL_LO, WALL_HI, min(1.0, shade + 0.2 * rng.next01())))
    faces = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (3, 2, 1, 0)]
    # roof: eaves overhang slightly beyond the walls, ridge along w
    eave = 1.12
    ez = wall_h
    rz = wall_h + roof_h
    for (x, y) in corners:
        rx, ry = rot2(x * eave, y * eave, ang)
        verts.append((cx + rx, cy + ry, ez))
        colors.append(lerp3(ROOF_LO, ROOF_HI, 0.25 + 0.3 * rng.next01()))
    for x in (-hw, hw):
        rx, ry = rot2(x * eave, 0.0, ang)
        verts.append((cx + rx, cy + ry, rz))
        colors.append(lerp3(ROOF_LO, ROOF_HI, 0.75 + 0.25 * rng.next01()))
    # eave ring = 8-11 (matches corners order), ridge = 12 (x=-hw), 13 (x=+hw)
    faces.append((8, 9, 13, 12))    # south slope
    faces.append((10, 11, 12, 13))  # north slope
    faces.append((9, 10, 13))       # east gable
    faces.append((11, 8, 12))       # west gable
    mb.add(verts, faces, colors)


def add_tower(mb, rng, cx, cy, radius, body_h, roof_h, lo=STONE_LO, hi=STONE_HI):
    """Hex masonry tower + terracotta cone roof."""
    n = 6
    verts, faces, colors = [], [], []
    phase = rng.range(0.0, 2.0 * math.pi)
    for z, taper in ((0.0, 1.0), (body_h, 0.85)):
        for k in range(n):
            a = phase + (2.0 * math.pi * k) / n
            verts.append((cx + radius * taper * math.cos(a),
                          cy + radius * taper * math.sin(a), z))
            shade = 0.2 + 0.6 * (z / body_h) + 0.2 * rng.next01()
            colors.append(lerp3(lo, hi, min(1.0, shade)))
    for k in range(n):
        k2 = (k + 1) % n
        faces.append((k, k2, n + k2, n + k))
    faces.append(tuple(range(n - 1, -1, -1)))  # base cap
    # cone roof with slight eave
    for k in range(n):
        a = phase + (2.0 * math.pi * k) / n
        verts.append((cx + radius * 1.05 * math.cos(a),
                      cy + radius * 1.05 * math.sin(a), body_h))
        colors.append(lerp3(ROOF_LO, ROOF_HI, 0.3 + 0.3 * rng.next01()))
    verts.append((cx, cy, body_h + roof_h))
    colors.append(lerp3(ROOF_LO, ROOF_HI, 0.9))
    apex = len(verts) - 1
    eave0 = 2 * n
    for k in range(n):
        k2 = (k + 1) % n
        faces.append((eave0 + k, eave0 + k2, apex))
    mb.add(verts, faces, colors)


def add_post(mb, rng, cx, cy, radius, h):
    """Timber post (square) — hamlet shed support / village well frame."""
    hw = radius
    verts, colors = [], []
    for z in (0.0, h):
        for (x, y) in ((-hw, -hw), (hw, -hw), (hw, hw), (-hw, hw)):
            verts.append((cx + x, cy + y, z))
            colors.append((*TIMBER, 1.0))
    faces = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 6, 7)]
    mb.add(verts, faces, colors)


def build_hamlet(rng):
    mb = MeshBuilder()
    add_house(mb, rng, -0.05, 0.05, 0.85, 0.55, 0.30, 0.24, rng.range(-0.2, 0.2))
    # lean-to shed
    add_house(mb, rng, 0.52, -0.42, 0.42, 0.32, 0.18, 0.13, rng.range(0.9, 1.3))
    add_post(mb, rng, -0.55, -0.45, 0.04, 0.28)
    return mb


def build_village(rng):
    mb = MeshBuilder()
    add_house(mb, rng, -0.28, 0.18, 0.80, 0.52, 0.34, 0.26, rng.range(-0.15, 0.15))
    add_house(mb, rng, 0.42, -0.30, 0.55, 0.40, 0.26, 0.20, rng.range(1.0, 1.4))
    add_tower(mb, rng, 0.48, 0.45, 0.16, 0.62, 0.26)
    return mb


def build_town(rng):
    mb = MeshBuilder()
    add_tower(mb, rng, 0.0, 0.0, 0.22, 0.85, 0.34)
    add_house(mb, rng, -0.58, 0.30, 0.62, 0.42, 0.30, 0.22, rng.range(0.3, 0.6))
    add_house(mb, rng, 0.55, 0.42, 0.55, 0.40, 0.28, 0.20, rng.range(-0.5, -0.2))
    add_house(mb, rng, 0.10, -0.62, 0.66, 0.44, 0.32, 0.24, rng.range(-0.1, 0.1))
    return mb


BUILDERS = {
    "hamlet": build_hamlet,
    "village": build_village,
    "town": build_town,
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

    mat = bpy.data.materials.new(f"{prop_id}-mat")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    vcol = nodes.new("ShaderNodeVertexColor")
    vcol.layer_name = "Col"
    links.new(vcol.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Metallic"].default_value = 0.0
    mesh.materials.append(mat)

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
    spacing = 2.8
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
    cam.location = ((len(objs) - 1) * spacing / 2.0, -8.0, 6.5)
    cam.rotation_euler = (math.radians(52), 0.0, 0.0)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 32
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 480
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
                        help="also render a contact sheet PNG of all props")
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
        "w", prefix="repociv-city-", suffix=".py", delete=False
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
