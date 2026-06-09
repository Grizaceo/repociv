#!/usr/bin/env python3
"""Generate a contact-sheet Blender render of the terrain atlas tiles for visual QA.
Run via: blender --background --factory-startup --python scripts/preview-3d-texture-atlas.py
"""
import json
import math
import os
import sys
from pathlib import Path
import bpy

REPO = Path(os.getcwd())
ATLAS = REPO / 'public' / 'assets' / '3d' / 'terrain-atlas-3d.png'
META = REPO / 'public' / 'assets' / '3d' / 'terrain-atlas-3d.json'
OUT = Path(os.environ.get('PREVIEW_OUT', str(REPO / '.hermes' / 'artifacts' / 'terrain-atlas-preview.png')))
OUT.parent.mkdir(parents=True, exist_ok=True)

if not ATLAS.exists() or not META.exists():
    print('[DAVI] atlas or metadata missing; skipping preview', flush=True)
    sys.exit(0)

meta = json.loads(META.read_bytes())
terrains = [(k, v) for k, v in meta['terrains'].items() if k != 'fog']
N = len(terrains)
GRID_COLS = min(4, N)
GRID_ROWS = (N + GRID_COLS - 1) // GRID_COLS

IMG_W = IMG_H = 0  # set after load

# ── Clean scene ─────────────────────────────────────────────────────────
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# ── World ──────────────────────────────────────────────────────────────
world = bpy.data.worlds.new('QA') if not bpy.context.scene.world else bpy.context.scene.world
world.color = (0.05, 0.06, 0.09)
bpy.context.scene.world = world

# ── Load texture atlas into Blender ──────────────────────────────────────
img = bpy.data.images.load(str(ATLAS))
IMG_W, IMG_H = img.size

spacing = 3.2
for idx, (name, cell) in enumerate(terrains):
    # Create quad plane
    bpy.ops.mesh.primitive_plane_add(size=2.4, location=(spacing * (idx % GRID_COLS), -spacing * (idx // GRID_COLS), 0))
    plane = bpy.context.object
    plane.name = f'terrain_{name}'
    bpy.ops.object.shade_smooth()

    # Remap UVs to single atlas cell
    cell_rect = cell['rect']  # [x0, y0, w, h]
    x0, y0, cw, ch = cell_rect
    u0 = x0 / IMG_W
    u1 = (x0 + cw) / IMG_W
    # Blender V: 1 = bottom in UV, but image origin is top-left.
    # PNG y0=0 is the top, which maps to V=1 in Blender texture space.
    v_top = 1.0 - y0 / IMG_H
    v_bot = 1.0 - (y0 + ch) / IMG_H

    mesh = plane.data
    uv_layer = mesh.uv_layers.active or mesh.uv_layers.new()
    for loop in mesh.loops:
        uv = uv_layer.data[loop.index].uv
        uv[0] = u0 + uv[0] * (u1 - u0)
        uv[1] = v_bot + uv[1] * (v_top - v_bot)

    # Simple material with atlas texture — use_nodes avoids deprecation warning
    mat = bpy.data.materials.new(f'mat_{name}')
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial')
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.interpolation = 'Closest'
    mat.node_tree.links.new(bsdf.inputs['Base Color'], tex.outputs['Color'])
    mat.node_tree.links.new(output.inputs['Surface'], bsdf.outputs['BSDF'])
    plane.data.materials.append(mat)

    # Label
    bpy.ops.object.text_add(location=(spacing * (idx % GRID_COLS), -spacing * (idx // GRID_COLS) + 1.8, 0))
    txt = bpy.context.object
    txt.name = f'label_{name}'
    txt.data.body = name
    txt.data.align_x = 'CENTER'
    txt.data.size = 0.28
    txt.data.extrude = 0.02
    txt.rotation_euler = (0, 0, 0)

# ── Camera ───────────────────────────────────────────────────────────────
cx = spacing * (GRID_COLS - 1) / 2
cy = -spacing * (GRID_ROWS - 1) / 2
bpy.ops.object.camera_add(location=(cx, cy - 8, 10), rotation=(math.radians(50), 0, 0))
cam = bpy.context.object
cam.name = 'preview_camera'
cam.data.type = 'ORTHO'
cam.data.ortho_scale = max(GRID_COLS, GRID_ROWS) * spacing * 1.3
bpy.context.scene.camera = cam

# ── Light ─────────────────────────────────────────────────────────────────
bpy.ops.object.light_add(type='AREA', location=(cx, cy - 2, 7))
area_light = bpy.context.object
area_light.data.energy = 500
area_light.data.size = 8

# ── Render ────────────────────────────────────────────────────────────────
scene = bpy.context.scene
scene.render.resolution_x = 1600
scene.render.resolution_y = 900
scene.render.engine = 'BLENDER_EEVEE'
scene.render.filepath = str(OUT)
bpy.ops.render.render(write_still=True)
print(f'[DAVI] preview saved to {OUT}', flush=True)
