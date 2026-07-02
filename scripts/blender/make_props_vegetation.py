#!/usr/bin/env python3
"""Blender-built low-poly terrain scatter props for RepoCiv 3D global map.

Models Civ V-style vegetation/decor for the empty biomes and exports
deterministic binary glTF to public/assets/3d/props/:

    desert-palm-0/1       — bent-trunk palms with drooping kite fronds
    desert-rock-0/1       — faceted tan boulder clusters
    ice-shard-0/1         — angular blue-white pressure-ridge shards
    shrub-0/1             — low green dome bushes (hills scatter)
    forest-deciduous-0/1  — broadleaf trees (trunk + blobby faceted canopy),
                            mixed in with the pines by ForestProps3D

Run via:
    python3 scripts/blender/make_props_vegetation.py \
        --blender-bin ~/tools/blender/blender-5.1.2-linux-x64/blender

Optional preview contact sheet (all 8 props on a grid, sun + ortho cam):
    python3 scripts/blender/make_props_vegetation.py --preview

Same driver+payload pattern as make_props.py: this file is run with
plain python3; it writes a bpy sub-script under /tmp and invokes the
Blender binary on it (--background --factory-startup).

Determinism contract (same as make_props.py):
    - All jitter from an explicit LCG seeded per (prop, element, vertex).
    - Geometry from explicit pydata; no modifiers, no bmesh state.
    - glTF export settings pinned; same Blender build -> same bytes.

Model space (consumed by src/three/TerrainScatter3D.ts and ForestProps3D.ts):
    - Y-up after export (export_yup=True).
    - Footprint radius ~1.0; heights: palm ~1.7, rock ~0.55,
      shard ~1.1, shrub ~0.45, deciduous ~1.5. Base (y=0) sits ON the
      tile top face.

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
PREVIEW_PATH = REPO / ".hermes" / "artifacts" / "props-vegetation-preview.png"
DEFAULT_BLENDER = Path.home() / "tools/blender/blender-5.1.2-linux-x64/blender"

MAX_TRIS = 300

# (prop_id, kind, seed) — seed drives every LCG in the payload.
PROPS = [
    ("desert-palm-0", "palm", 101),
    ("desert-palm-1", "palm", 211),
    ("desert-rock-0", "rock", 307),
    ("desert-rock-1", "rock", 401),
    ("ice-shard-0", "shard", 503),
    ("ice-shard-1", "shard", 601),
    ("shrub-0", "shrub", 701),
    ("shrub-1", "shrub", 809),
    ("forest-deciduous-0", "deciduous", 907),
    ("forest-deciduous-1", "deciduous", 1013),
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

    def pick(self, items):
        return items[int(self.next01() * len(items)) % len(items)]


# ── Palettes (vertex colors, Civ V painted look) ─────────────────────────────
PALM_TRUNK_LO = (0.42, 0.30, 0.18)
PALM_TRUNK_HI = (0.55, 0.42, 0.26)
PALM_FROND_LO = (0.22, 0.42, 0.18)
PALM_FROND_HI = (0.38, 0.58, 0.24)
ROCK_LO = (0.38, 0.30, 0.20)   # shaded desert sandstone
ROCK_HI = (0.58, 0.47, 0.32)   # sunlit sandstone (ochre — reads tan under the bright sun)
ICE_LO = (0.62, 0.76, 0.88)    # blue base
ICE_HI = (0.93, 0.97, 1.00)    # white crest
SHRUB_LO = (0.26, 0.40, 0.16)
SHRUB_HI = (0.44, 0.58, 0.24)
# Deciduous canopy bakes BRIGHTER than the target on-screen green: the
# renderer multiplies every forest tree by forestCanopyTint (~0.5-0.8 per
# channel), so these values land at the same deep mottled green as the pines.
DECID_TRUNK_LO = (0.34, 0.24, 0.14)
DECID_TRUNK_HI = (0.48, 0.36, 0.22)
DECID_LEAF_LO = (0.40, 0.58, 0.24)
DECID_LEAF_HI = (0.62, 0.80, 0.36)


def lerp3(a, b, t):
    return (a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
            1.0)


class MeshBuilder:
    """Accumulates pydata verts/faces/colors across elements of one prop."""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.colors = []

    def add(self, verts, faces, colors):
        base = len(self.verts)
        self.verts.extend(verts)
        self.faces.extend(tuple(base + i for i in f) for f in faces)
        self.colors.extend(colors)


# ── Palm ─────────────────────────────────────────────────────────────────────
def add_palm_trunk(mb, rng, height):
    """Bent trunk: 5 stacked pentagon rings, radius tapering, curve lean."""
    n = 5
    segs = 5
    lean_ang = rng.range(0.0, 2.0 * math.pi)
    lean_amt = rng.range(0.12, 0.30)
    verts, faces, colors = [], [], []
    for s in range(segs + 1):
        t = s / segs
        z = t * height
        # quadratic lean so the base stays planted
        off = lean_amt * t * t
        cx = off * math.cos(lean_ang)
        cy = off * math.sin(lean_ang)
        rad = 0.085 * (1.0 - 0.45 * t)
        for k in range(n):
            ang = (2.0 * math.pi * k) / n + rng.range(-0.06, 0.06)
            rr = rad * (1.0 + rng.range(-0.12, 0.12))
            verts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang), z))
            colors.append(lerp3(PALM_TRUNK_LO, PALM_TRUNK_HI, 0.3 + 0.7 * rng.next01()))
    for s in range(segs):
        a0, b0 = s * n, (s + 1) * n
        for k in range(n):
            k2 = (k + 1) % n
            faces.append((a0 + k, a0 + k2, b0 + k2))
            faces.append((a0 + k, b0 + k2, b0 + k))
    # crown centre (top ring centroid) returned for frond anchoring
    top = verts[-n:]
    cx = sum(v[0] for v in top) / n
    cy = sum(v[1] for v in top) / n
    mb.add(verts, faces, colors)
    return (cx, cy, height)


def add_palm_frond(mb, rng, anchor, ang):
    """One kite frond: 6 verts, 4 tris — rises then droops from the crown."""
    ax, ay, az = anchor
    length = rng.range(0.55, 0.80)
    width = rng.range(0.16, 0.24)
    rise = rng.range(0.10, 0.18)
    droop = rng.range(0.28, 0.45)
    ca, sa = math.cos(ang), math.sin(ang)
    # centreline: root -> mid (raised) -> tip (drooped)
    mid = (ax + ca * length * 0.5, ay + sa * length * 0.5, az + rise)
    tip = (ax + ca * length, ay + sa * length, az + rise - droop)
    # width direction (perpendicular in XY)
    px, py = -sa, ca
    verts = [
        (ax, ay, az),
        (mid[0] + px * width, mid[1] + py * width, mid[2] - 0.03),
        (mid[0] - px * width, mid[1] - py * width, mid[2] - 0.03),
        (mid[0], mid[1], mid[2] + 0.02),
        tip,
    ]
    faces = [(0, 1, 3), (0, 3, 2), (3, 1, 4), (2, 3, 4)]
    base_c = lerp3(PALM_FROND_LO, PALM_FROND_HI, rng.next01())
    tip_c = lerp3(PALM_FROND_LO, PALM_FROND_HI, rng.next01())
    colors = [base_c, base_c, base_c, tip_c, tip_c]
    mb.add(verts, faces, colors)


def build_palm(rng):
    mb = MeshBuilder()
    height = rng.range(1.45, 1.75)
    crown = add_palm_trunk(mb, rng, height)
    n_fronds = 7
    phase = rng.range(0.0, 2.0 * math.pi)
    for k in range(n_fronds):
        ang = phase + (2.0 * math.pi * k) / n_fronds + rng.range(-0.15, 0.15)
        add_palm_frond(mb, rng, crown, ang)
    return mb


# ── Rock / shard / shrub: jittered dome or spike elements ────────────────────
def add_dome(mb, rng, cx, cy, radius, height, lo, hi, n=6, squash=1.0):
    """Faceted dome: base ring + upper ring + apex. ~3n tris."""
    verts, faces, colors = [], [], []
    phase = rng.range(0.0, 2.0 * math.pi)
    for tier, (tr, tz) in enumerate(((1.0, 0.0), (0.62, 0.62))):
        for k in range(n):
            ang = phase + (2.0 * math.pi * k) / n + rng.range(-0.12, 0.12)
            rr = radius * tr * (1.0 + rng.range(-0.18, 0.18))
            zz = height * tz * (1.0 + rng.range(-0.10, 0.10)) * squash
            verts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang), zz))
            shade = tz + 0.5 * rng.next01()
            colors.append(lerp3(lo, hi, min(1.0, shade)))
    verts.append((cx + radius * rng.range(-0.12, 0.12),
                  cy + radius * rng.range(-0.12, 0.12),
                  height * squash))
    colors.append(lerp3(lo, hi, 0.85 + 0.15 * rng.next01()))
    apex = len(verts) - 1
    verts.append((cx, cy, 0.0))
    colors.append(lerp3(lo, hi, 0.2))
    base_c = len(verts) - 1
    for k in range(n):
        k2 = (k + 1) % n
        faces.append((k, k2, n + k2))
        faces.append((k, n + k2, n + k))
        faces.append((n + k, n + k2, apex))
        faces.append((base_c, k2, k))
    mb.add(verts, faces, colors)


def add_spike(mb, rng, cx, cy, radius, height, tilt_ang, tilt_amt, lo, hi):
    """Angular shard: 5-gon base ring + tilted apex. Sharp ice crystal."""
    n = 5
    verts, faces, colors = [], [], []
    phase = rng.range(0.0, 2.0 * math.pi)
    for k in range(n):
        ang = phase + (2.0 * math.pi * k) / n + rng.range(-0.10, 0.10)
        rr = radius * (1.0 + rng.range(-0.20, 0.20))
        verts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang), 0.0))
        colors.append(lerp3(lo, hi, 0.15 + 0.35 * rng.next01()))
    ax = cx + tilt_amt * math.cos(tilt_ang)
    ay = cy + tilt_amt * math.sin(tilt_ang)
    verts.append((ax, ay, height))
    colors.append(lerp3(lo, hi, 0.9 + 0.1 * rng.next01()))
    apex = n
    verts.append((cx, cy, 0.0))
    colors.append(lerp3(lo, hi, 0.1))
    base_c = n + 1
    for k in range(n):
        k2 = (k + 1) % n
        faces.append((k, k2, apex))
        faces.append((base_c, k2, k))
    mb.add(verts, faces, colors)


def build_rock(rng):
    mb = MeshBuilder()
    n_rocks = 2 + int(rng.next01() * 2)   # 2-3 boulders
    for i in range(n_rocks):
        ang = rng.range(0.0, 2.0 * math.pi)
        dist = 0.0 if i == 0 else rng.range(0.35, 0.65)
        cx, cy = dist * math.cos(ang), dist * math.sin(ang)
        radius = rng.range(0.30, 0.55) * (1.0 if i == 0 else 0.7)
        height = rng.range(0.35, 0.55) * (1.0 if i == 0 else 0.7)
        add_dome(mb, rng, cx, cy, radius, height, ROCK_LO, ROCK_HI, n=6)
    return mb


def build_shard(rng):
    mb = MeshBuilder()
    n_shards = 3 + int(rng.next01() * 2)  # 3-4 crystals
    main_tilt = rng.range(0.0, 2.0 * math.pi)
    for i in range(n_shards):
        ang = rng.range(0.0, 2.0 * math.pi)
        dist = 0.0 if i == 0 else rng.range(0.25, 0.60)
        cx, cy = dist * math.cos(ang), dist * math.sin(ang)
        scale = 1.0 if i == 0 else rng.range(0.45, 0.75)
        radius = rng.range(0.20, 0.32) * scale
        height = rng.range(0.80, 1.15) * scale
        tilt = main_tilt + rng.range(-0.5, 0.5)
        add_spike(mb, rng, cx, cy, radius, height, tilt,
                  rng.range(0.10, 0.30), ICE_LO, ICE_HI)
    # low broken chunks around the base
    for _ in range(2):
        ang = rng.range(0.0, 2.0 * math.pi)
        dist = rng.range(0.45, 0.75)
        add_dome(mb, rng, dist * math.cos(ang), dist * math.sin(ang),
                 rng.range(0.14, 0.22), rng.range(0.10, 0.18),
                 ICE_LO, ICE_HI, n=5)
    return mb


def add_blob(mb, rng, cx, cy, cz, radius, lo, hi, n=6):
    """Closed faceted blob: bottom vertex + 2 rings + apex. 4n tris.

    Unlike add_dome this floats — it has no base cap at z=0 — so it works
    as a leaf cluster hovering on a trunk."""
    verts, faces, colors = [], [], []
    phase = rng.range(0.0, 2.0 * math.pi)
    verts.append((cx, cy, cz - radius * rng.range(0.70, 0.90)))
    colors.append(lerp3(lo, hi, 0.10 + 0.15 * rng.next01()))
    for tier, (tr, tz) in enumerate(((1.0, -0.22), (0.78, 0.42))):
        for k in range(n):
            ang = phase + (2.0 * math.pi * k) / n + rng.range(-0.14, 0.14)
            rr = radius * tr * (1.0 + rng.range(-0.16, 0.16))
            zz = cz + radius * tz * (1.0 + rng.range(-0.12, 0.12))
            verts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang), zz))
            shade = 0.35 + 0.4 * tier + 0.3 * rng.next01()
            colors.append(lerp3(lo, hi, min(1.0, shade)))
    verts.append((cx + radius * rng.range(-0.10, 0.10),
                  cy + radius * rng.range(-0.10, 0.10),
                  cz + radius * rng.range(0.72, 0.92)))
    colors.append(lerp3(lo, hi, 0.88 + 0.12 * rng.next01()))
    bottom, apex = 0, 2 * n + 1
    lo_ring, hi_ring = 1, 1 + n
    for k in range(n):
        k2 = (k + 1) % n
        faces.append((bottom, lo_ring + k2, lo_ring + k))
        faces.append((lo_ring + k, lo_ring + k2, hi_ring + k2))
        faces.append((lo_ring + k, hi_ring + k2, hi_ring + k))
        faces.append((hi_ring + k, hi_ring + k2, apex))
    mb.add(verts, faces, colors)


def add_deciduous_trunk(mb, rng, height):
    """Tapered trunk: 4 stacked pentagon rings with a slight lean.

    Returns the (x, y, z) of the top ring centroid for canopy anchoring."""
    n = 5
    segs = 4
    lean_ang = rng.range(0.0, 2.0 * math.pi)
    lean_amt = rng.range(0.04, 0.12)
    verts, faces, colors = [], [], []
    for s in range(segs + 1):
        t = s / segs
        z = t * height
        off = lean_amt * t * t
        cx = off * math.cos(lean_ang)
        cy = off * math.sin(lean_ang)
        rad = 0.11 * (1.0 - 0.5 * t)
        for k in range(n):
            ang = (2.0 * math.pi * k) / n + rng.range(-0.08, 0.08)
            rr = rad * (1.0 + rng.range(-0.14, 0.14))
            verts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang), z))
            colors.append(lerp3(DECID_TRUNK_LO, DECID_TRUNK_HI,
                                0.3 + 0.7 * rng.next01()))
    for s in range(segs):
        a0, b0 = s * n, (s + 1) * n
        for k in range(n):
            k2 = (k + 1) % n
            faces.append((a0 + k, a0 + k2, b0 + k2))
            faces.append((a0 + k, b0 + k2, b0 + k))
    top = verts[-n:]
    cx = sum(v[0] for v in top) / n
    cy = sum(v[1] for v in top) / n
    mb.add(verts, faces, colors)
    return (cx, cy, height)


def build_deciduous(rng):
    """Broadleaf tree: short trunk + 3-4 clustered leaf blobs. ~150 tris."""
    mb = MeshBuilder()
    trunk_h = rng.range(0.50, 0.65)
    ax, ay, az = add_deciduous_trunk(mb, rng, trunk_h)
    crown_r = rng.range(0.42, 0.52)
    # main crown blob sits directly on the trunk top
    add_blob(mb, rng, ax, ay, az + crown_r * 0.55, crown_r,
             DECID_LEAF_LO, DECID_LEAF_HI)
    n_side = 2 + int(rng.next01() * 2)  # 2-3 side blobs
    for _ in range(n_side):
        ang = rng.range(0.0, 2.0 * math.pi)
        dist = rng.range(0.55, 0.85) * crown_r
        side_r = crown_r * rng.range(0.55, 0.75)
        add_blob(mb, rng,
                 ax + dist * math.cos(ang),
                 ay + dist * math.sin(ang),
                 az + crown_r * rng.range(0.35, 0.75),
                 side_r, DECID_LEAF_LO, DECID_LEAF_HI)
    return mb


def build_shrub(rng):
    mb = MeshBuilder()
    n_blobs = 2 + int(rng.next01() * 2)   # 2-3 blobs
    for i in range(n_blobs):
        ang = rng.range(0.0, 2.0 * math.pi)
        dist = 0.0 if i == 0 else rng.range(0.30, 0.55)
        cx, cy = dist * math.cos(ang), dist * math.sin(ang)
        radius = rng.range(0.30, 0.45) * (1.0 if i == 0 else 0.65)
        height = rng.range(0.32, 0.45) * (1.0 if i == 0 else 0.7)
        add_dome(mb, rng, cx, cy, radius, height, SHRUB_LO, SHRUB_HI, n=6)
    return mb


BUILDERS = {
    "palm": build_palm,
    "rock": build_rock,
    "shard": build_shard,
    "shrub": build_shrub,
    "deciduous": build_deciduous,
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
    bsdf.inputs["Roughness"].default_value = 0.92
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
    """Contact sheet: props on a 4-wide grid, sun light, ortho camera."""
    spacing = 2.6
    cols = 4
    rows = (len(objs) + cols - 1) // cols
    for i, obj in enumerate(objs):
        obj.location = ((i % cols) * spacing, -(i // cols) * spacing, 0.0)

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", type='SUN'))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(55), 0.0, math.radians(30))
    bpy.context.collection.objects.link(sun)

    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = cols * spacing + 1.5
    cam = bpy.data.objects.new("cam", cam_data)
    cx = (cols - 1) * spacing / 2.0
    cy = -(rows - 1) * spacing / 2.0
    cam.location = (cx, cy - 9.0, 7.5)
    cam.rotation_euler = (math.radians(52), 0.0, 0.0)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 32
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 320 * rows
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
        "w", prefix="repociv-veg-", suffix=".py", delete=False
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
