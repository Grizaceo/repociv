#!/usr/bin/env python3
"""Rebuild all 25 RepoCiv GLB assets with proper per-asset export.

Each asset is built and exported individually so GLB files contain
ONLY the intended mesh — not every object in the scene.

Run via Blender MCP execute_code (copy-paste chunks) or via:
    blender --background --python rebuild_all_props.py
"""
import bpy
import math
import sys

# ── Helpers ──────────────────────────────────────────────────────────────────

class Lcg:
    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF
    def next01(self):
        self.s = (1664525 * self.s + 1013904223) & 0xFFFFFFFF
        return self.s / 4294967296.0
    def range(self, lo, hi):
        return lo + (hi - lo) * self.next01()

def make_mat(name, bc, rough, metal=0.0, em_c=None, em_s=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (bc[0], bc[1], bc[2], 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if em_c:
        try:
            bsdf.inputs["Emission Color"].default_value = (em_c[0], em_c[1], em_c[2], 1.0)
        except:
            bsdf.inputs["Emission"].default_value = (em_c[0], em_c[1], em_c[2], 1.0)
        bsdf.inputs["Emission Strength"].default_value = em_s
    return mat

EXPORT_DIR = r"\\wsl.localhost\Ubuntu\home\gris\.hermes\workspace\ACTIVE\repociv\public\assets\3d\props"

def export_glb(name):
    out = f"{EXPORT_DIR}\\{name}.glb"
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_materials='EXPORT',
        export_normals=True,
        export_texcoords=False,
        export_tangents=False,
        export_cameras=False,
        export_lights=False,
    )
    print(f"  exported {name}")

def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh)

def add_mesh_to_scene(name, verts, faces, materials_with_slots=None):
    """Create a mesh object, assign materials, link to scene.
    materials_with_slots = list of (material, face_count_for_this_slot)
    """
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    if materials_with_slots:
        for mat, _ in materials_with_slots:
            mesh.materials.append(mat)
        # Assign material indices
        idx = 0
        for slot_i, (mat, count) in enumerate(materials_with_slots):
            for _ in range(count):
                if idx < len(mesh.polygons):
                    mesh.polygons[idx].material_index = slot_i
                    idx += 1
    for poly in mesh.polygons:
        poly.use_smooth = False
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj

# ── Build functions ──────────────────────────────────────────────────────────

def build_mountain(vi, peaks):
    all_v = []; all_lower = []; all_upper = []; all_snow = []
    for (cx, cz, radius, height, seed) in peaks:
        snow_line = 0.72 * height
        rng = Lcg(seed)
        n = 7
        rings_t = (0.0, 0.42, 0.74); ring_r = (1.0, 0.55, 0.27)
        v = []
        for ri, (t, r_scale) in enumerate(zip(rings_t, ring_r)):
            r = radius * r_scale; z = t * height
            for i in range(n):
                angle = (i / n) * math.tau + rng.range(-0.08, 0.08)
                jr = r * rng.range(0.82, 1.18)
                v.append((cx + math.cos(angle) * jr, cz + math.sin(angle) * jr, z))
        apex = len(v)
        v.append((cx + rng.range(-0.05, 0.05), cz + rng.range(-0.05, 0.05), height))
        bc = len(v)
        v.append((cx, cz, 0.0))
        rf = []; sf = []
        for ri in range(len(rings_t) - 1):
            for i in range(n):
                i2 = (i + 1) % n
                v0 = ri*n+i; v1 = ri*n+i2; v2 = (ri+1)*n+i; v3 = (ri+1)*n+i2
                z_avg = (v[v0][2]+v[v1][2]+v[v2][2]+v[v3][2])/4.0
                if z_avg >= snow_line: sf += [(v0,v2,v1),(v1,v2,v3)]
                else: rf += [(v0,v2,v1),(v1,v2,v3)]
        top_start = (len(rings_t)-1)*n
        for i in range(n):
            i2 = (i + 1) % n; sf.append((top_start+i, apex, top_start+i2))
        for i in range(n):
            i2 = (i + 1) % n; rf.append((i, i2, bc))
        threshold = 0.35 * height
        off = len(all_v); all_v.extend(v)
        for f in rf:
            fa = tuple(x+off for x in f)
            z_avg = sum(all_v[x][2] for x in fa) / 3.0
            if z_avg < threshold: all_lower.append(fa)
            else: all_upper.append(fa)
        all_snow.extend(tuple(x+off for x in f) for f in sf)

    palettes = [
        {'lower': (0.16,0.14,0.11), 'upper': (0.52,0.48,0.43), 'snow': (0.78,0.88,0.96)},
        {'lower': (0.12,0.11,0.10), 'upper': (0.46,0.43,0.41), 'snow': (0.75,0.86,0.95)},
        {'lower': (0.08,0.07,0.06), 'upper': (0.36,0.34,0.31), 'snow': (0.76,0.87,0.96)},
    ]
    p = palettes[vi]
    mats = [
        (make_mat(f'mtn-l-{vi}', p['lower'], 0.94, 0.02), len(all_lower)),
        (make_mat(f'mtn-u-{vi}', p['upper'], 0.82, 0.02), len(all_upper)),
        (make_mat(f'mtn-s-{vi}', p['snow'], 0.35, 0.0, (0.10,0.18,0.35), 0.8), len(all_snow)),
    ]
    add_mesh_to_scene(f'mountain-{vi}', all_v, all_lower + all_upper + all_snow, mats)
    export_glb(f'mountain-{vi}')
    clear_scene()

def build_desert_rock(vi):
    rng = Lcg(vi * 100 + 11)
    verts = []; sun_f = []; shadow_f = []
    n = 5
    r_base = rng.range(0.55, 0.85)
    height = rng.range(0.40, 0.65)
    for i in range(n):
        angle = (i / n) * math.tau + rng.range(-0.12, 0.12)
        r = r_base * rng.range(0.80, 1.15)
        verts.append((math.cos(angle) * r, math.sin(angle) * r, 0.0))
    mid_idx = len(verts)
    for i in range(n):
        angle = (i / n) * math.tau + rng.range(-0.15, 0.15) + 0.3
        r = r_base * 0.55 * rng.range(0.80, 1.10)
        verts.append((math.cos(angle) * r, math.sin(angle) * r, height * 0.6))
    top_idx = len(verts)
    verts.append((rng.range(-0.08, 0.08), rng.range(-0.08, 0.08), height))
    for i in range(n):
        i2 = (i + 1) % n
        v0 = i; v1 = i2; v2 = mid_idx + i; v3 = mid_idx + i2
        cx = sum(verts[v][0] for v in (v0,v1,v2,v3)) / 4.0
        if cx > 0: sun_f += [(v0,v2,v1),(v1,v2,v3)]
        else: shadow_f += [(v0,v2,v1),(v1,v2,v3)]
    for i in range(n):
        i2 = (i + 1) % n; sun_f.append((mid_idx+i, top_idx, mid_idx+i2))
    base_c = len(verts); verts.append((0, 0, 0))
    for i in range(n):
        i2 = (i + 1) % n; shadow_f.append((i, i2, base_c))
    
    palettes = [
        {'sun': (0.65,0.52,0.38), 'shadow': (0.32,0.25,0.18)},
        {'sun': (0.58,0.48,0.36), 'shadow': (0.28,0.22,0.16)},
    ]
    p = palettes[vi]
    mats = [
        (make_mat(f'dr-sun-{vi}', p['sun'], 0.85, 0.02), len(sun_f)),
        (make_mat(f'dr-shdw-{vi}', p['shadow'], 0.92, 0.02), len(shadow_f)),
    ]
    add_mesh_to_scene(f'desert-rock-{vi}', verts, sun_f + shadow_f, mats)
    export_glb(f'desert-rock-{vi}')
    clear_scene()

def build_desert_palm(vi):
    rng = Lcg(vi * 200 + 13)
    trunk_h = rng.range(1.2, 1.8); trunk_r = 0.06
    n_trunk = 6; segs = 3
    verts = []; trunk_f = []
    for si in range(segs + 1):
        z = (si / segs) * trunk_h
        cx = math.sin(si * 0.3) * 0.08; cy = math.cos(si * 0.15) * 0.04
        r = trunk_r * (1.0 - si * 0.08)
        for i in range(n_trunk):
            angle = (i / n_trunk) * math.tau
            verts.append((cx + math.cos(angle) * r, cy + math.sin(angle) * r, z))
    for si in range(segs):
        for i in range(n_trunk):
            i2 = (i + 1) % n_trunk
            v0 = si*n_trunk+i; v1 = si*n_trunk+i2; v2 = (si+1)*n_trunk+i; v3 = (si+1)*n_trunk+i2
            trunk_f += [(v0,v2,v1),(v1,v2,v3)]
    frond_f = []
    n_fronds = 5; frond_len = rng.range(0.35, 0.50)
    for fi in range(n_fronds):
        angle = (fi / n_fronds) * math.tau + rng.range(-0.1, 0.1)
        bx = math.sin(segs * 0.3) * 0.08; by = math.cos(segs * 0.15) * 0.04; bz = trunk_h
        tx = bx + math.cos(angle) * frond_len; ty = by + math.sin(angle) * frond_len; tz = bz - frond_len * 0.25
        mx = (bx + tx) / 2 + math.cos(angle + 1.57) * 0.08
        my = (by + ty) / 2 + math.sin(angle + 1.57) * 0.08; mz = bz + 0.05
        bi_v = len(verts); verts.append((bx, by, bz))
        ti_v = len(verts); verts.append((tx, ty, tz))
        mi_v = len(verts); verts.append((mx, my, mz))
        frond_f.append((bi_v, mi_v, ti_v))
    coco_f = []
    n_coco = int(rng.range(1, 4)); coco_r = 0.05
    for ci in range(n_coco):
        angle = rng.range(0, math.tau)
        cx = math.sin(segs * 0.3) * 0.08 + math.cos(angle) * 0.12
        cy = math.cos(segs * 0.15) * 0.04 + math.sin(angle) * 0.12; cz = trunk_h - 0.05
        c0 = len(verts); verts.append((cx, cy, cz + coco_r))
        c1 = len(verts); verts.append((cx + coco_r, cy, cz))
        c2 = len(verts); verts.append((cx, cy + coco_r, cz))
        c3 = len(verts); verts.append((cx - coco_r, cy, cz))
        c4 = len(verts); verts.append((cx, cy - coco_r, cz))
        c5 = len(verts); verts.append((cx, cy, cz - coco_r))
        coco_f += [(c0,c1,c2),(c0,c2,c4),(c0,c4,c3),(c0,c3,c1),(c5,c2,c1),(c5,c4,c2),(c5,c3,c4),(c5,c1,c3)]
    
    mats = [
        (make_mat(f'dp-trunk-{vi}', (0.22,0.14,0.08), 0.92, 0.0), len(trunk_f)),
        (make_mat(f'dp-frond-{vi}', (0.35,0.42,0.22), 0.85, 0.0, (0.08,0.12,0.04), 0.2), len(frond_f)),
        (make_mat(f'dp-coco-{vi}', (0.18,0.10,0.06), 0.80, 0.0), len(coco_f)),
    ]
    add_mesh_to_scene(f'desert-palm-{vi}', verts, trunk_f + frond_f + coco_f, mats)
    export_glb(f'desert-palm-{vi}')
    clear_scene()

def build_ice_shard(vi):
    rng = Lcg(vi * 100 + 7)
    all_v = []; all_f = []
    for si in range(3):
        h = rng.range(0.8, 1.2); r_base = rng.range(0.20, 0.35)
        n = 5; verts = []
        for i in range(n):
            angle = (i / n) * math.tau + rng.range(-0.1, 0.1)
            r = r_base * rng.range(0.80, 1.15)
            verts.append((math.cos(angle) * r, math.sin(angle) * r, 0.0))
        mid_idx = len(verts)
        for i in range(n):
            angle = (i / n) * math.tau + 0.3 + rng.range(-0.1, 0.1)
            r = r_base * 0.35
            verts.append((math.cos(angle) * r, math.sin(angle) * r, h * 0.55))
        tip_idx = len(verts)
        verts.append((rng.range(-0.03, 0.03), rng.range(-0.03, 0.03), h))
        base_c = len(verts); verts.append((0, 0, 0))
        faces = []
        for i in range(n):
            i2 = (i + 1) % n
            faces += [(i, mid_idx+i, i2), (i2, mid_idx+i, mid_idx+i2)]
        for i in range(n):
            i2 = (i + 1) % n; faces.append((mid_idx+i, tip_idx, mid_idx+i2))
        for i in range(n):
            i2 = (i + 1) % n; faces.append((i, i2, base_c))
        off = len(all_v); all_v.extend(verts)
        all_f.extend(tuple(x+off for x in f) for f in faces)
    
    ice_col = (0.55, 0.78, 0.92) if vi == 0 else (0.48, 0.72, 0.88)
    mats = [(make_mat(f'ice-{vi}', ice_col, 0.18, 0.10, (0.08,0.15,0.28), 0.6), len(all_f))]
    add_mesh_to_scene(f'ice-shard-{vi}', all_v, all_f, mats)
    export_glb(f'ice-shard-{vi}')
    clear_scene()

def build_shrub(vi):
    rng = Lcg(vi * 50 + 17)
    verts = []; faces = []
    for bi in range(3):
        cx = rng.range(-0.20, 0.20); cz = rng.range(-0.20, 0.20)
        r = rng.range(0.15, 0.25)
        base = len(verts)
        verts += [(cx, cz, r), (cx+r, cz, 0), (cx, cz+r, 0), (cx-r, cz, 0), (cx, cz-r, 0), (cx, cz, -r*0.3)]
        faces += [(base,base+1,base+2),(base,base+2,base+4),(base,base+4,base+3),(base,base+3,base+1),
                  (base+5,base+2,base+1),(base+5,base+4,base+2),(base+5,base+3,base+4),(base+5,base+1,base+3)]
    col = (0.28, 0.38, 0.20) if vi == 0 else (0.32, 0.35, 0.22)
    mats = [(make_mat(f'shrub-{vi}', col, 0.88, 0.0, (0.06,0.10,0.04), 0.15), len(faces))]
    add_mesh_to_scene(f'shrub-{vi}', verts, faces, mats)
    export_glb(f'shrub-{vi}')
    clear_scene()

def build_crystal():
    rng = Lcg(42)
    verts = []; faces = []
    for ci in range(3):
        angle = ci * (math.tau / 3) + rng.range(-0.1, 0.1)
        cx = math.cos(angle) * 0.15; cy = math.sin(angle) * 0.15
        h = rng.range(0.35, 0.55); r = rng.range(0.08, 0.14)
        base = len(verts)
        verts += [(cx, cy, h), (cx+r, cy, h*0.3), (cx, cy+r, h*0.3), (cx-r, cy, h*0.3), (cx, cy-r, h*0.3), (cx, cy, 0)]
        faces += [(base,base+1,base+2),(base,base+2,base+4),(base,base+4,base+3),(base,base+3,base+1),
                  (base+5,base+2,base+1),(base+5,base+4,base+2),(base+5,base+3,base+4),(base+5,base+1,base+3)]
    mats = [(make_mat('crystal-0', (0.45,0.20,0.65), 0.20, 0.30, (0.30,0.10,0.50), 2.0), len(faces))]
    add_mesh_to_scene('resource-crystal-0', verts, faces, mats)
    export_glb('resource-crystal-0')
    clear_scene()

def build_sacred_marker():
    verts = []; stone_f = []
    n = 6
    for i in range(n):
        angle = (i / n) * math.tau
        cx = math.cos(angle) * 0.375; cy = math.sin(angle) * 0.375
        base = len(verts); s = 0.08; h = 0.15
        verts += [(cx-s,cy-s,0),(cx+s,cy-s,0),(cx+s,cy+s,0),(cx-s,cy+s,0),
                  (cx-s,cy-s,h),(cx+s,cy-s,h),(cx+s,cy+s,h),(cx-s,cy+s,h)]
        stone_f += [(base,base+1,base+2),(base,base+2,base+3),(base+4,base+6,base+5),(base+4,base+7,base+6),
                    (base,base+4,base+5),(base,base+5,base+1),(base+1,base+5,base+6),(base+1,base+6,base+2),
                    (base+2,base+6,base+7),(base+2,base+7,base+3),(base+3,base+7,base+4),(base+3,base+4,base)]
    ob_base = len(verts); h_ob = 0.55; r_ob = 0.08; n_ob = 4
    for i in range(n_ob):
        angle = (i / n_ob) * math.tau
        verts.append((math.cos(angle)*r_ob, math.sin(angle)*r_ob, 0))
    for i in range(n_ob):
        angle = (i / n_ob) * math.tau; r_top = r_ob * 0.4
        verts.append((math.cos(angle)*r_top, math.sin(angle)*r_top, h_ob*0.7))
    tip = len(verts); verts.append((0, 0, h_ob))
    base_c = len(verts); verts.append((0, 0, 0))
    ob_f = []
    for i in range(n_ob):
        i2 = (i + 1) % n_ob
        ob_f += [(ob_base+i, ob_base+n_ob+i, ob_base+i2), (ob_base+i2, ob_base+n_ob+i, ob_base+n_ob+i2)]
    for i in range(n_ob):
        i2 = (i + 1) % n_ob; ob_f.append((ob_base+n_ob+i, tip, ob_base+n_ob+i2))
    for i in range(n_ob):
        i2 = (i + 1) % n_ob; ob_f.append((ob_base+i, i2+ob_base, base_c))
    
    mats = [
        (make_mat('sm-stone', (0.42,0.38,0.33), 0.85, 0.02), len(stone_f)),
        (make_mat('sm-gold', (0.85,0.65,0.25), 0.18, 0.80, (0.20,0.14,0.05), 0.4), len(ob_f)),
    ]
    add_mesh_to_scene('sacred-marker-0', verts, stone_f + ob_f, mats)
    export_glb('sacred-marker-0')
    clear_scene()

def build_worker():
    def box_faces(b):
        return [(b,b+1,b+2),(b,b+2,b+3),(b+4,b+6,b+5),(b+4,b+7,b+6),
                (b,b+4,b+5),(b,b+5,b+1),(b+1,b+5,b+6),(b+1,b+6,b+2),
                (b+2,b+6,b+7),(b+2,b+7,b+3),(b+3,b+7,b+4),(b+3,b+4,b)]
    verts = []
    b = 0  # body
    verts += [(-0.10,-0.06,0.20),(0.10,-0.06,0.20),(0.10,0.06,0.20),(-0.10,0.06,0.20),
              (-0.10,-0.06,0.45),(0.10,-0.06,0.45),(0.10,0.06,0.45),(-0.10,0.06,0.45)]
    body_f = box_faces(b); nb = len(body_f)
    h = len(verts)  # head
    verts += [(-0.07,-0.05,0.45),(0.07,-0.05,0.45),(0.07,0.05,0.45),(-0.07,0.05,0.45),
              (-0.07,-0.05,0.58),(0.07,-0.05,0.58),(0.07,0.05,0.58),(-0.07,0.05,0.58)]
    head_f = box_faces(h); nh = len(head_f)
    leg_f = []
    for lx in [-0.06, 0.04]:
        l = len(verts)
        verts += [(lx-0.03,-0.04,0),(lx+0.03,-0.04,0),(lx+0.03,0.04,0),(lx-0.03,0.04,0),
                  (lx-0.03,-0.04,0.20),(lx+0.03,-0.04,0.20),(lx+0.03,0.04,0.20),(lx-0.03,0.04,0.20)]
        leg_f += box_faces(l)
    nl = len(leg_f)
    arm_f = []
    for ax in [-0.12, 0.10]:
        a = len(verts)
        verts += [(ax-0.025,-0.04,0.25),(ax+0.025,-0.04,0.25),(ax+0.025,0.04,0.25),(ax-0.025,0.04,0.25),
                  (ax-0.025,-0.04,0.42),(ax+0.025,-0.04,0.42),(ax+0.025,0.04,0.42),(ax-0.025,0.04,0.42)]
        arm_f += box_faces(a)
    na = len(arm_f)
    pk = len(verts)  # pick handle
    verts += [(-0.02,-0.02,0.30),(0.02,-0.02,0.30),(0.02,0.02,0.30),(-0.02,0.02,0.30),
              (0.13,-0.02,0.50),(0.17,-0.02,0.50),(0.17,0.02,0.50),(0.13,0.02,0.50)]
    pk_f = box_faces(pk); npk = len(pk_f)
    pkh = len(verts)  # pick head
    verts += [(0.14,-0.06,0.45),(0.18,-0.06,0.45),(0.18,0.06,0.45),(0.14,0.06,0.45),
              (0.14,-0.06,0.55),(0.18,-0.06,0.55),(0.18,0.06,0.55),(0.14,0.06,0.55)]
    pkh_f = box_faces(pkh); npkh = len(pkh_f)
    
    all_f = body_f + head_f + leg_f + arm_f + pk_f + pkh_f
    mats = [
        (make_mat('uw-cloth', (0.35,0.28,0.20), 0.85, 0.0), nb + nl + na),  # body+legs+arms
        (make_mat('uw-skin', (0.65,0.48,0.35), 0.65, 0.0), nh),  # head
        (make_mat('uw-metal', (0.50,0.48,0.42), 0.35, 0.60), npkh),  # pick head
        (make_mat('uw-wood', (0.30,0.18,0.10), 0.85, 0.0), npk),  # pick handle
    ]
    add_mesh_to_scene('unit-worker-0', verts, all_f, mats)
    export_glb('unit-worker-0')
    clear_scene()

def build_pine(vi):
    rng = Lcg(vi * 100 + 5)
    trunk_h = rng.range(0.30, 0.45); trunk_r = 0.035; n_trunk = 5
    verts = []; trunk_f = []
    for si in range(2):
        z = si * trunk_h
        for i in range(n_trunk):
            angle = (i / n_trunk) * math.tau
            verts.append((math.cos(angle)*trunk_r, math.sin(angle)*trunk_r, z))
    for i in range(n_trunk):
        i2 = (i + 1) % n_trunk
        trunk_f += [(i, i2, n_trunk+i), (i2, n_trunk+i2, n_trunk+i)]
    bc = len(verts); verts.append((0, 0, 0))
    for i in range(n_trunk):
        i2 = (i + 1) % n_trunk; trunk_f.append((i, bc, i2))
    canopy_f = []
    n_can = 6
    canopy_base_z = trunk_h
    for ci in range(3):
        r = rng.range(0.18, 0.25) * (1.0 - ci * 0.25)
        h = rng.range(0.20, 0.28)
        z_base = canopy_base_z + ci * h * 0.55; z_top = z_base + h
        ring_base = len(verts)
        for i in range(n_can):
            angle = (i / n_can) * math.tau + rng.range(-0.1, 0.1)
            verts.append((math.cos(angle)*r, math.sin(angle)*r, z_base))
        ring_top = len(verts)
        verts.append((rng.range(-0.02, 0.02), rng.range(-0.02, 0.02), z_top))
        apex = ring_top
        for i in range(n_can):
            i2 = (i + 1) % n_can
            canopy_f.append((ring_base+i, apex, ring_base+i2))
    
    colors = [(0.18,0.32,0.16), (0.22,0.36,0.18), (0.15,0.28,0.14)]
    mats = [
        (make_mat(f'fp-trunk-{vi}', (0.20,0.13,0.07), 0.92, 0.0), len(trunk_f)),
        (make_mat(f'fp-can-{vi}', colors[vi], 0.85, 0.0, (0.04,0.08,0.03), 0.15), len(canopy_f)),
    ]
    add_mesh_to_scene(f'forest-pine-{vi}', verts, trunk_f + canopy_f, mats)
    export_glb(f'forest-pine-{vi}')
    clear_scene()

def build_deciduous(vi):
    rng = Lcg(vi * 100 + 23)
    trunk_h = rng.range(0.25, 0.35); trunk_r = 0.035; n_trunk = 5
    verts = []; trunk_f = []
    for si in range(2):
        z = si * trunk_h
        for i in range(n_trunk):
            angle = (i / n_trunk) * math.tau
            verts.append((math.cos(angle)*trunk_r, math.sin(angle)*trunk_r, z))
    for i in range(n_trunk):
        i2 = (i + 1) % n_trunk
        trunk_f += [(i, n_trunk+i, i2), (i2, n_trunk+i, n_trunk+i2)]
    bc = len(verts); verts.append((0, 0, 0))
    for i in range(n_trunk):
        i2 = (i + 1) % n_trunk; trunk_f.append((i, bc, i2))
    canopy_f = []
    canopy_z = trunk_h + rng.range(0.08, 0.15)
    for bi in range(3):
        cx = rng.range(-0.08, 0.08); cy = rng.range(-0.08, 0.08)
        r = rng.range(0.15, 0.22)
        base = len(verts)
        verts += [(cx, cy, canopy_z+r), (cx+r, cy, canopy_z), (cx, cy+r, canopy_z), (cx-r, cy, canopy_z), (cx, cy-r, canopy_z), (cx, cy, canopy_z-r*0.3)]
        canopy_f += [(base,base+1,base+2),(base,base+2,base+4),(base,base+4,base+3),(base,base+3,base+1),
                     (base+5,base+2,base+1),(base+5,base+4,base+2),(base+5,base+3,base+4),(base+5,base+1,base+3)]
    colors = [(0.30,0.42,0.20), (0.55,0.35,0.15)]
    mats = [
        (make_mat(f'fd-trunk-{vi}', (0.22,0.14,0.08), 0.92, 0.0), len(trunk_f)),
        (make_mat(f'fd-can-{vi}', colors[vi], 0.82, 0.0, (0.06,0.04,0.02), 0.12), len(canopy_f)),
    ]
    add_mesh_to_scene(f'forest-deciduous-{vi}', verts, trunk_f + canopy_f, mats)
    export_glb(f'forest-deciduous-{vi}')
    clear_scene()

def build_bibliotheca():
    verts = []; stone_f = []
    b = 0
    verts += [(-0.40,-0.25,0),(0.40,-0.25,0),(0.40,0.25,0),(-0.40,0.25,0),
              (-0.40,-0.25,0.05),(0.40,-0.25,0.05),(0.40,0.25,0.05),(-0.40,0.25,0.05)]
    stone_f += [(b,b+1,b+2),(b,b+2,b+3),(b+4,b+6,b+5),(b+4,b+7,b+6),(b,b+4,b+5),(b,b+5,b+1),
                (b+1,b+5,b+6),(b+1,b+6,b+2),(b+2,b+6,b+7),(b+2,b+7,b+3),(b+3,b+7,b+4),(b+3,b+4,b)]
    col_h = 0.35; col_r = 0.04; n_col = 6
    for (cx, cy) in [(-0.25,-0.15),(0.25,-0.15),(-0.25,0.15),(0.25,0.15)]:
        c_base = len(verts)
        for si in range(2):
            z = si * col_h
            for i in range(n_col):
                angle = (i / n_col) * math.tau
                verts.append((cx+math.cos(angle)*col_r, cy+math.sin(angle)*col_r, 0.05+z))
        for i in range(n_col):
            i2 = (i + 1) % n_col
            stone_f += [(c_base+i, c_base+i2, c_base+n_col+i), (c_base+i2, c_base+n_col+i2, c_base+n_col+i)]
    r_base = len(verts); rz = 0.05 + col_h
    verts += [(-0.30,-0.20,rz),(0.30,-0.20,rz),(0.30,0.20,rz),(-0.30,0.20,rz),
              (-0.30,-0.20,rz+0.05),(0.30,-0.20,rz+0.05),(0.30,0.20,rz+0.05),(-0.30,0.20,rz+0.05)]
    stone_f += [(r_base,r_base+1,r_base+2),(r_base,r_base+2,r_base+3),(r_base+4,r_base+6,r_base+5),(r_base+4,r_base+7,r_base+6),
                (r_base,r_base+4,r_base+5),(r_base,r_base+5,r_base+1),(r_base+1,r_base+5,r_base+6),(r_base+1,r_base+6,r_base+2),
                (r_base+2,r_base+6,r_base+7),(r_base+2,r_base+7,r_base+3),(r_base+3,r_base+7,r_base+4),(r_base+3,r_base+4,r_base)]
    n_stone = len(stone_f)
    # Dome
    d_base = len(verts); dz = rz + 0.05; dr = 0.12
    verts += [(0,0,dz+0.15), (dr,0,dz), (0,dr,dz), (-dr,0,dz), (0,-dr,dz), (0,0,dz-0.036)]
    gold_f = [(d_base,d_base+1,d_base+2),(d_base,d_base+2,d_base+4),(d_base,d_base+4,d_base+3),(d_base,d_base+3,d_base+1),
              (d_base+5,d_base+2,d_base+1),(d_base+5,d_base+4,d_base+2),(d_base+5,d_base+3,d_base+4),(d_base+5,d_base+1,d_base+3)]
    n_gold = len(gold_f)
    # Door
    door_base = len(verts)
    verts += [(-0.08,-0.20,0.05),(0.08,-0.20,0.05),(0.08,-0.20,0.17),(-0.08,-0.20,0.17)]
    door_f = [(door_base,door_base+1,door_base+2),(door_base,door_base+2,door_base+3)]
    n_door = len(door_f)
    
    mats = [
        (make_mat('wb-stone', (0.72,0.68,0.58), 0.80, 0.02), n_stone),
        (make_mat('wb-gold', (0.82,0.62,0.22), 0.18, 0.78, (0.20,0.14,0.05), 0.4), n_gold),
        (make_mat('wb-door', (0.12,0.08,0.05), 0.90, 0.0, (0.08,0.05,0.02), 0.3), n_door),
    ]
    add_mesh_to_scene('wonder-bibliotheca-0', verts, stone_f + gold_f + door_f, mats)
    export_glb('wonder-bibliotheca-0')
    clear_scene()

def build_institutum():
    verts = []; stone_f = []
    b = 0
    verts += [(-0.35,-0.22,0),(0.35,-0.22,0),(0.35,0.22,0),(-0.35,0.22,0),
              (-0.35,-0.22,0.04),(0.35,-0.22,0.04),(0.35,0.22,0.04),(-0.35,0.22,0.04)]
    stone_f += [(b,b+1,b+2),(b,b+2,b+3),(b+4,b+6,b+5),(b+4,b+7,b+6),(b,b+4,b+5),(b,b+5,b+1),
                (b+1,b+5,b+6),(b+1,b+6,b+2),(b+2,b+6,b+7),(b+2,b+7,b+3),(b+3,b+7,b+4),(b+3,b+4,b)]
    col_h = 0.30; col_r = 0.035; n_col = 6
    for (cx, cy) in [(-0.22,-0.12),(0,-0.12),(0.22,-0.12),(-0.22,0.12),(0,0.12),(0.22,0.12)]:
        c_base = len(verts)
        for si in range(2):
            z = si * col_h
            for i in range(n_col):
                angle = (i / n_col) * math.tau
                verts.append((cx+math.cos(angle)*col_r, cy+math.sin(angle)*col_r, 0.04+z))
        for i in range(n_col):
            i2 = (i + 1) % n_col
            stone_f += [(c_base+i, c_base+i2, c_base+n_col+i), (c_base+i2, c_base+n_col+i2, c_base+n_col+i)]
    r_base = len(verts); rz = 0.04 + col_h
    verts += [(-0.28,-0.18,rz),(0.28,-0.18,rz),(0.28,0.18,rz),(-0.28,0.18,rz),
              (-0.28,-0.18,rz+0.04),(0.28,-0.18,rz+0.04),(0.28,0.18,rz+0.04),(-0.28,0.18,rz+0.04)]
    stone_f += [(r_base,r_base+1,r_base+2),(r_base,r_base+2,r_base+3),(r_base+4,r_base+6,r_base+5),(r_base+4,r_base+7,r_base+6),
                (r_base,r_base+4,r_base+5),(r_base,r_base+5,r_base+1),(r_base+1,r_base+5,r_base+6),(r_base+1,r_base+6,r_base+2),
                (r_base+2,r_base+6,r_base+7),(r_base+2,r_base+7,r_base+3),(r_base+3,r_base+7,r_base+4),(r_base+3,r_base+4,r_base)]
    n_stone = len(stone_f)
    # Obelisk
    ob_base = len(verts); ob_h = 0.35; ob_r = 0.05; n_ob = 4
    for i in range(n_ob):
        angle = (i / n_ob) * math.tau
        verts.append((math.cos(angle)*ob_r, math.sin(angle)*ob_r, rz+0.04))
    ob_mid = len(verts)
    for i in range(n_ob):
        angle = (i / n_ob) * math.tau; r_top = ob_r * 0.5
        verts.append((math.cos(angle)*r_top, math.sin(angle)*r_top, rz+0.04+ob_h*0.7))
    ob_tip = len(verts); verts.append((0, 0, rz+0.04+ob_h))
    gold_f = []
    for i in range(n_ob):
        i2 = (i + 1) % n_ob
        gold_f += [(ob_base+i, ob_mid+i, ob_base+i2), (ob_base+i2, ob_mid+i, ob_mid+i2)]
    for i in range(n_ob):
        i2 = (i + 1) % n_ob; gold_f.append((ob_mid+i, ob_tip, ob_mid+i2))
    n_gold = len(gold_f)
    
    mats = [
        (make_mat('wi-marble', (0.85,0.83,0.78), 0.40, 0.02), n_stone),
        (make_mat('wi-gold', (0.80,0.60,0.20), 0.18, 0.80, (0.18,0.12,0.04), 0.4), n_gold),
    ]
    add_mesh_to_scene('wonder-institutum-0', verts, stone_f + gold_f, mats)
    export_glb('wonder-institutum-0')
    clear_scene()

# ── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    clear_scene()
    
    # Mountains
    print("=== MOUNTAINS ===")
    mountain_variants = [
        [(0.00, 0.00, 1.00, 1.90, 11)],
        [(-0.22, 0.10, 0.85, 1.70, 23), (0.52, -0.30, 0.55, 1.05, 37)],
        [(-0.40, -0.15, 0.70, 1.15, 53), (0.30, 0.05, 0.80, 1.45, 67), (0.05, 0.55, 0.50, 0.85, 79)],
    ]
    for vi, peaks in enumerate(mountain_variants):
        build_mountain(vi, peaks)
    
    # Desert
    print("=== DESERT ===")
    for vi in range(2):
        build_desert_rock(vi)
        build_desert_palm(vi)
    
    # Ice
    print("=== ICE ===")
    for vi in range(2):
        build_ice_shard(vi)
    
    # Shrubs
    print("=== SHRUBS ===")
    for vi in range(2):
        build_shrub(vi)
    
    # Resources
    print("=== RESOURCES ===")
    build_crystal()
    build_sacred_marker()
    
    # Worker
    print("=== WORKER ===")
    build_worker()
    
    # Forests
    print("=== FORESTS ===")
    for vi in range(3):
        build_pine(vi)
    for vi in range(2):
        build_deciduous(vi)
    
    # Wonders
    print("=== WONDERS ===")
    build_bibliotheca()
    build_institutum()
    
    print("\n=== ALL 22 ASSETS REBUILT AND EXPORTED ===")

if __name__ == '__main__':
    main()