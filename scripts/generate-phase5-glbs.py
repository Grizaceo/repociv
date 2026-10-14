#!/usr/bin/env python3
"""Deterministic low-poly GLB generator for Phase 5 (Huecos Visuales A & B).

Generates:
1. Role-specific unit figurines under public/assets/3d/props/units/:
   - unit-mage.glb      (hero, claude, openclaw)
   - unit-engineer.glb  (worker, codex, cursor)
   - unit-rogue.glb     (scout, caravan)
   - unit-knight.glb    (praetorian, army, lexo)
   Each figurine keeps material slot 1 (primitive index 1) as the primary
   tintable garment (robe, tunic, cloak, tabard) so UnitMesh3D and LocalAgent3D
   tint it with unit.color while preserving skin, wood, metal, and gem slots.

2. Modern office furniture props under public/assets/3d/props/kenney/:
   - desk.glb            (workbench & standing_desk)
   - chairDesk.glb       (chair)
   - loungeSofa.glb      (sofa)
   - tableConference.glb (meeting_room)
   - bookcaseOpen.glb    (research_bench)

All geometries are Y-up with feet/base at Y=0, <= 300 triangles per model,
and exported as standard binary glTF 2.0 (.glb).
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
UNITS_DIR = REPO_ROOT / "public" / "assets" / "3d" / "props" / "units"
KENNEY_DIR = REPO_ROOT / "public" / "assets" / "3d" / "props" / "kenney"

Vec3 = tuple[float, float, float]
Tri = tuple[int, int, int]


def _sub(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _norm(v: Vec3) -> Vec3:
    length = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if length < 1e-9:
        return (0.0, 1.0, 0.0)
    return (v[0] / length, v[1] / length, v[2] / length)


class PartBuilder:
    """Collects flat-shaded triangles for a single material slot."""

    def __init__(
        self,
        mat_name: str,
        color: tuple[float, float, float],
        roughness: float = 0.75,
        metallic: float = 0.0,
    ) -> None:
        self.mat_name = mat_name
        self.color = color
        self.roughness = roughness
        self.metallic = metallic
        self.positions: list[Vec3] = []
        self.normals: list[Vec3] = []
        self.indices: list[int] = []

    def add_tri(self, p0: Vec3, p1: Vec3, p2: Vec3) -> None:
        n = _norm(_cross(_sub(p1, p0), _sub(p2, p0)))
        base = len(self.positions)
        self.positions.extend((p0, p1, p2))
        self.normals.extend((n, n, n))
        self.indices.extend((base, base + 1, base + 2))

    def add_quad(self, p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3) -> None:
        n = _norm(_cross(_sub(p1, p0), _sub(p2, p0)))
        base = len(self.positions)
        self.positions.extend((p0, p1, p2, p3))
        self.normals.extend((n, n, n, n))
        self.indices.extend((base, base + 1, base + 2, base, base + 2, base + 3))

    def add_box(
        self,
        x0: float,
        y0: float,
        z0: float,
        x1: float,
        y1: float,
        z1: float,
    ) -> None:
        # 6 faces with outward CCW winding (Y-up, right-handed)
        # Front (+Z)
        self.add_quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))
        # Back (-Z)
        self.add_quad((x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0))
        # Right (+X)
        self.add_quad((x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1))
        # Left (-X)
        self.add_quad((x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0))
        # Top (+Y)
        self.add_quad((x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0))
        # Bottom (-Y)
        self.add_quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1))

    def add_frustum(
        self,
        cx: float,
        cz: float,
        y0: float,
        y1: float,
        r0: float,
        r1: float,
        sides: int = 6,
        cap_top: bool = True,
        cap_bottom: bool = True,
    ) -> None:
        ring0: list[Vec3] = []
        ring1: list[Vec3] = []
        for i in range(sides):
            ang = (i / sides) * math.tau
            c, s = math.cos(ang), math.sin(ang)
            ring0.append((cx + c * r0, y0, cz + s * r0))
            ring1.append((cx + c * r1, y1, cz + s * r1))
        for i in range(sides):
            nxt = (i + 1) % sides
            if r1 <= 1e-6:
                self.add_tri(ring0[nxt], ring0[i], (cx, y1, cz))
            else:
                self.add_quad(ring0[nxt], ring0[i], ring1[i], ring1[nxt])
        if cap_top and r1 > 1e-6:
            center_top = (cx, y1, cz)
            for i in range(sides):
                nxt = (i + 1) % sides
                self.add_tri(center_top, ring1[nxt], ring1[i])
        if cap_bottom and r0 > 1e-6:
            center_bot = (cx, y0, cz)
            for i in range(sides):
                nxt = (i + 1) % sides
                self.add_tri(center_bot, ring0[i], ring0[nxt])

    def add_octahedron(self, cx: float, cy: float, cz: float, rx: float, ry: float, rz: float) -> None:
        top = (cx, cy + ry, cz)
        bot = (cx, cy - ry, cz)
        pts = [
            (cx + rx, cy, cz),
            (cx, cy, cz + rz),
            (cx - rx, cy, cz),
            (cx, cy, cz - rz),
        ]
        for i in range(4):
            nxt = (i + 1) % 4
            self.add_tri(pts[nxt], pts[i], top)
            self.add_tri(pts[i], pts[nxt], bot)

    @property
    def tri_count(self) -> int:
        return len(self.indices) // 3


def export_glb(path: Path, node_name: str, parts: list[PartBuilder]) -> int:
    """Serialize parts into a binary glTF 2.0 (.glb) file and return total triangle count."""
    non_empty = [p for p in parts if p.indices]
    if not non_empty:
        raise ValueError(f"Model {node_name} has no geometry")

    materials = []
    primitives = []
    accessors = []
    buffer_views = []
    bin_chunks: list[bytes] = []
    byte_offset = 0
    total_tris = 0

    def append_bin(raw: bytes, target: int) -> int:
        nonlocal byte_offset
        pad = (4 - (len(raw) % 4)) % 4
        padded = raw + (b"\x00" * pad)
        bv_idx = len(buffer_views)
        buffer_views.append(
            {
                "buffer": 0,
                "byteOffset": byte_offset,
                "byteLength": len(raw),
                "target": target,
            }
        )
        bin_chunks.append(padded)
        byte_offset += len(padded)
        return bv_idx

    for mat_idx, part in enumerate(non_empty):
        total_tris += part.tri_count
        materials.append(
            {
                "name": part.mat_name,
                "doubleSided": True,
                "pbrMetallicRoughness": {
                    "baseColorFactor": [part.color[0], part.color[1], part.color[2], 1.0],
                    "roughnessFactor": part.roughness,
                    "metallicFactor": part.metallic,
                },
            }
        )

        xs = [p[0] for p in part.positions]
        ys = [p[1] for p in part.positions]
        zs = [p[2] for p in part.positions]

        pos_bytes = b"".join(struct.pack("<fff", *p) for p in part.positions)
        norm_bytes = b"".join(struct.pack("<fff", *n) for n in part.normals)
        idx_bytes = b"".join(struct.pack("<H", idx) for idx in part.indices)

        pos_bv = append_bin(pos_bytes, 34962)
        norm_bv = append_bin(norm_bytes, 34962)
        idx_bv = append_bin(idx_bytes, 34963)

        pos_acc = len(accessors)
        accessors.append(
            {
                "bufferView": pos_bv,
                "componentType": 5126,
                "count": len(part.positions),
                "type": "VEC3",
                "min": [min(xs), min(ys), min(zs)],
                "max": [max(xs), max(ys), max(zs)],
            }
        )
        norm_acc = len(accessors)
        accessors.append(
            {
                "bufferView": norm_bv,
                "componentType": 5126,
                "count": len(part.normals),
                "type": "VEC3",
            }
        )
        idx_acc = len(accessors)
        accessors.append(
            {
                "bufferView": idx_bv,
                "componentType": 5123,
                "count": len(part.indices),
                "type": "SCALAR",
            }
        )

        primitives.append(
            {
                "attributes": {"POSITION": pos_acc, "NORMAL": norm_acc},
                "indices": idx_acc,
                "material": mat_idx,
            }
        )

    bin_blob = b"".join(bin_chunks)
    gltf = {
        "asset": {"generator": "RepoCiv Phase 5 Deterministic Forge", "version": "2.0"},
        "scene": 0,
        "scenes": [{"name": "Scene", "nodes": [0]}],
        "nodes": [{"mesh": 0, "name": node_name}],
        "materials": materials,
        "meshes": [{"name": node_name, "primitives": primitives}],
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(bin_blob)}],
    }

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_pad = (4 - (len(json_bytes) % 4)) % 4
    json_chunk = json_bytes + (b" " * json_pad)

    total_len = 12 + 8 + len(json_chunk) + 8 + len(bin_blob)
    header = struct.pack("<III", 0x46546C67, 2, total_len)
    chunk0 = struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
    chunk1 = struct.pack("<II", len(bin_blob), 0x004E4942) + bin_blob

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + chunk0 + chunk1)
    return total_tris


# ─── Task 1 (Hueco A): 4 Role-Based Agent Figurines ──────────────────────────


def build_unit_mage() -> list[PartBuilder]:
    """Mage / Coordinator (hero, claude, openclaw): flared robe + pointed wizard hat + staff + orb."""
    skin = PartBuilder("mage-skin", (0.68, 0.52, 0.38), roughness=0.65)
    robe = PartBuilder("mage-robe-tint", (0.34, 0.28, 0.46), roughness=0.78)
    wood = PartBuilder("mage-staff-wood", (0.32, 0.20, 0.11), roughness=0.82)
    gem = PartBuilder("mage-orb-gem", (0.55, 0.82, 0.98), roughness=0.18, metallic=0.45)

    # Boots & head & hands (slot 0)
    skin.add_box(-0.07, 0.0, -0.04, -0.015, 0.08, 0.04)
    skin.add_box(0.015, 0.0, -0.04, 0.07, 0.08, 0.04)
    skin.add_box(-0.065, 0.44, -0.055, 0.065, 0.56, 0.055)
    skin.add_box(-0.15, 0.25, -0.03, -0.10, 0.31, 0.03)
    skin.add_box(0.10, 0.28, -0.03, 0.15, 0.34, 0.03)

    # Flared robe, wide sleeves, pointed wizard hat (slot 1 — tinted with unit.color)
    robe.add_frustum(0.0, 0.0, 0.05, 0.44, 0.145, 0.085, sides=6)
    robe.add_box(-0.14, 0.30, -0.045, -0.08, 0.43, 0.045)
    robe.add_box(0.08, 0.30, -0.045, 0.14, 0.43, 0.045)
    # Wizard hat brim + tall cone
    robe.add_frustum(0.0, 0.0, 0.55, 0.575, 0.15, 0.13, sides=6)
    robe.add_frustum(0.0, -0.01, 0.575, 0.76, 0.095, 0.0, sides=6)

    # Arcane staff + shoulder mantle trim (slot 2)
    wood.add_box(0.125, 0.0, -0.02, 0.155, 0.62, 0.02)
    wood.add_box(-0.095, 0.41, -0.06, 0.095, 0.445, 0.06)

    # Glowing crystal orb atop staff + belt buckle (slot 3)
    gem.add_octahedron(0.14, 0.68, 0.0, 0.055, 0.07, 0.055)
    gem.add_box(-0.03, 0.24, 0.09, 0.03, 0.28, 0.115)

    return [skin, robe, wood, gem]


def build_unit_engineer() -> list[PartBuilder]:
    """Engineer / Builder (worker, codex, cursor): overalls + hardhat + backpack + heavy wrench/hammer."""
    skin = PartBuilder("eng-skin", (0.65, 0.48, 0.35), roughness=0.65)
    tunic = PartBuilder("eng-tunic-tint", (0.35, 0.38, 0.26), roughness=0.80)
    wood = PartBuilder("eng-wood", (0.34, 0.22, 0.12), roughness=0.85)
    metal = PartBuilder("eng-metal", (0.58, 0.60, 0.64), roughness=0.32, metallic=0.65)

    # Legs, boots, head (slot 0)
    skin.add_box(-0.085, 0.0, -0.045, -0.02, 0.20, 0.045)
    skin.add_box(0.02, 0.0, -0.045, 0.085, 0.20, 0.045)
    skin.add_box(-0.07, 0.44, -0.055, 0.07, 0.56, 0.055)

    # Torso tunic, arms, and dome hardhat (slot 1 — tinted with unit.color)
    tunic.add_box(-0.105, 0.20, -0.065, 0.105, 0.45, 0.065)
    tunic.add_box(-0.15, 0.24, -0.04, -0.105, 0.43, 0.04)
    tunic.add_box(0.105, 0.24, -0.04, 0.15, 0.43, 0.04)
    tunic.add_frustum(0.0, 0.0, 0.54, 0.63, 0.105, 0.06, sides=6)
    tunic.add_box(-0.09, 0.535, 0.04, 0.09, 0.555, 0.11)

    # Tool shaft + utility backpack (slot 2)
    wood.add_box(0.125, 0.26, -0.02, 0.16, 0.54, 0.02)
    wood.add_box(-0.08, 0.24, -0.125, 0.08, 0.42, -0.065)

    # Heavy wrench/hammer head + belt buckle (slot 3)
    metal.add_box(0.10, 0.50, -0.07, 0.19, 0.57, 0.07)
    metal.add_box(-0.04, 0.20, 0.06, 0.04, 0.24, 0.08)

    return [skin, tunic, wood, metal]


def build_unit_rogue() -> list[PartBuilder]:
    """Rogue / Ranger (scout, caravan): hooded cloak + swept cape + quiver/pack + twin daggers."""
    skin = PartBuilder("rogue-skin", (0.62, 0.46, 0.34), roughness=0.65)
    cloak = PartBuilder("rogue-cloak-tint", (0.24, 0.36, 0.42), roughness=0.78)
    leather = PartBuilder("rogue-leather", (0.30, 0.19, 0.11), roughness=0.82)
    blade = PartBuilder("rogue-blade", (0.72, 0.75, 0.80), roughness=0.25, metallic=0.75)

    # Agile legs & face (slot 0)
    skin.add_box(-0.075, 0.0, -0.04, -0.02, 0.22, 0.04)
    skin.add_box(0.02, 0.0, -0.04, 0.075, 0.22, 0.04)
    skin.add_box(-0.06, 0.44, -0.045, 0.06, 0.55, 0.05)

    # Tunic, hooded cowl, and swept ranger cape (slot 1 — tinted with unit.color)
    cloak.add_box(-0.095, 0.21, -0.055, 0.095, 0.44, 0.055)
    cloak.add_box(-0.14, 0.25, -0.035, -0.095, 0.42, 0.035)
    cloak.add_box(0.095, 0.25, -0.035, 0.14, 0.42, 0.035)
    cloak.add_frustum(0.0, -0.01, 0.44, 0.63, 0.095, 0.03, sides=6)
    cloak.add_box(-0.10, 0.10, -0.095, 0.10, 0.43, -0.055)

    # Ranger quiver / caravan pack + belt (slot 2)
    leather.add_box(-0.07, 0.25, -0.145, 0.07, 0.47, -0.095)
    leather.add_box(-0.10, 0.21, -0.06, 0.10, 0.24, 0.06)

    # Twin daggers / scout blades (slot 3)
    blade.add_box(-0.16, 0.22, 0.02, -0.12, 0.30, 0.16)
    blade.add_box(0.12, 0.22, 0.02, 0.16, 0.30, 0.16)

    return [skin, cloak, leather, blade]


def build_unit_knight() -> list[PartBuilder]:
    """Knight / Guardian (praetorian, army, lexo): tabard + pauldrons + greathelm + shield + sword."""
    under = PartBuilder("knight-under", (0.24, 0.24, 0.27), roughness=0.60, metallic=0.35)
    tabard = PartBuilder("knight-tabard-tint", (0.42, 0.25, 0.48), roughness=0.72)
    steel = PartBuilder("knight-steel", (0.68, 0.70, 0.75), roughness=0.28, metallic=0.78)
    gold = PartBuilder("knight-gold", (0.85, 0.68, 0.24), roughness=0.25, metallic=0.80)

    # Armored greaves & arms (slot 0)
    under.add_box(-0.085, 0.0, -0.045, -0.02, 0.21, 0.045)
    under.add_box(0.02, 0.0, -0.045, 0.085, 0.21, 0.045)
    under.add_box(-0.15, 0.23, -0.04, -0.105, 0.41, 0.04)
    under.add_box(0.105, 0.23, -0.04, 0.15, 0.41, 0.04)

    # Heraldic tabard/surcoat, broad pauldrons, and helmet crest plume (slot 1 — tinted with unit.color)
    tabard.add_box(-0.11, 0.18, -0.07, 0.11, 0.45, 0.07)
    tabard.add_box(-0.17, 0.38, -0.06, -0.095, 0.46, 0.06)
    tabard.add_box(0.095, 0.38, -0.06, 0.17, 0.46, 0.06)
    tabard.add_box(-0.025, 0.58, -0.07, 0.025, 0.69, 0.05)

    # Greathelm, kite shield on left arm, upright broadsword blade in right hand (slot 2)
    steel.add_frustum(0.0, 0.0, 0.45, 0.59, 0.085, 0.075, sides=6)
    steel.add_box(-0.19, 0.18, -0.07, -0.145, 0.43, 0.09)
    steel.add_box(0.135, 0.32, -0.02, 0.165, 0.68, 0.02)

    # Golden crossguard, pommel, and shield boss (slot 3)
    gold.add_box(0.105, 0.30, -0.05, 0.195, 0.33, 0.05)
    gold.add_box(-0.20, 0.28, -0.01, -0.185, 0.34, 0.03)

    return [under, tabard, steel, gold]


# ─── Task 2 (Hueco B): 5 Modern Office Furniture Props ───────────────────────


def build_furniture_desk() -> list[PartBuilder]:
    """Modern desk with flat-screen monitor and keyboard (workbench & standing_desk).
    Uses light neutral base colors so InstancedMesh.setColorAt tints cleanly by file extension.
    """
    body = PartBuilder("desk-body", (0.86, 0.84, 0.80), roughness=0.58)
    screen = PartBuilder("desk-screen", (0.76, 0.84, 0.92), roughness=0.28, metallic=0.20)

    # Desktop slab
    body.add_box(-0.48, 0.42, -0.28, 0.48, 0.47, 0.28)
    # 4 legs
    for lx in (-0.44, 0.40):
        for lz in (-0.24, 0.20):
            body.add_box(lx, 0.0, lz, lx + 0.04, 0.42, lz + 0.04)
    # Back modesty panel
    body.add_box(-0.40, 0.18, -0.24, 0.40, 0.42, -0.21)
    # Keyboard on desk
    body.add_box(-0.16, 0.47, 0.04, 0.16, 0.49, 0.16)

    # Monitor stand + widescreen display
    screen.add_box(-0.08, 0.47, -0.18, 0.08, 0.49, -0.10)
    screen.add_box(-0.025, 0.49, -0.16, 0.025, 0.56, -0.13)
    screen.add_box(-0.26, 0.55, -0.16, 0.26, 0.82, -0.12)

    return [body, screen]


def build_furniture_chair_desk() -> list[PartBuilder]:
    """Ergonomic swivel office chair (chair)."""
    frame = PartBuilder("chair-frame", (0.26, 0.28, 0.32), roughness=0.50, metallic=0.35)
    cushion = PartBuilder("chair-cushion", (0.58, 0.44, 0.32), roughness=0.72)

    # Star base + center pneumatic cylinder
    frame.add_box(-0.22, 0.0, -0.04, 0.22, 0.04, 0.04)
    frame.add_box(-0.04, 0.0, -0.22, 0.04, 0.04, 0.22)
    frame.add_box(-0.035, 0.04, -0.035, 0.035, 0.28, 0.035)
    # Armrests
    frame.add_box(-0.24, 0.28, -0.14, -0.20, 0.44, 0.14)
    frame.add_box(0.20, 0.28, -0.14, 0.24, 0.44, 0.14)

    # Seat cushion + ergonomic backrest
    cushion.add_box(-0.20, 0.27, -0.20, 0.20, 0.33, 0.20)
    cushion.add_box(-0.19, 0.33, -0.21, 0.19, 0.68, -0.15)

    return [frame, cushion]


def build_furniture_lounge_sofa() -> list[PartBuilder]:
    """Modern 2-seat office lounge sofa (sofa)."""
    fabric = PartBuilder("sofa-fabric", (0.77, 0.48, 0.29), roughness=0.78)
    wood = PartBuilder("sofa-wood", (0.32, 0.22, 0.15), roughness=0.70)

    # Low wooden feet + plinth
    for lx in (-0.46, 0.40):
        for lz in (-0.22, 0.16):
            wood.add_box(lx, 0.0, lz, lx + 0.06, 0.06, lz + 0.06)
    wood.add_box(-0.48, 0.06, -0.24, 0.48, 0.10, 0.24)

    # Base seat + two cushions + backrest + left/right armrests
    fabric.add_box(-0.40, 0.10, -0.20, -0.01, 0.24, 0.22)
    fabric.add_box(0.01, 0.10, -0.20, 0.40, 0.24, 0.22)
    fabric.add_box(-0.42, 0.22, -0.24, 0.42, 0.50, -0.12)
    fabric.add_box(-0.50, 0.10, -0.24, -0.40, 0.38, 0.24)
    fabric.add_box(0.40, 0.10, -0.24, 0.50, 0.38, 0.24)

    return [fabric, wood]


def build_furniture_table_conference() -> list[PartBuilder]:
    """Conference room table with twin pedestal legs and center media console (meeting_room)."""
    top = PartBuilder("conf-top", (0.83, 0.61, 0.23), roughness=0.55)
    base = PartBuilder("conf-base", (0.28, 0.30, 0.35), roughness=0.45, metallic=0.40)

    # Pedestal legs + crossbar
    base.add_box(-0.34, 0.0, -0.16, -0.24, 0.40, 0.16)
    base.add_box(0.24, 0.0, -0.16, 0.34, 0.40, 0.16)
    base.add_box(-0.24, 0.14, -0.04, 0.24, 0.22, 0.04)

    # Wide conference tabletop + center media strip
    top.add_box(-0.50, 0.40, -0.32, 0.50, 0.46, 0.32)
    base.add_box(-0.22, 0.46, -0.05, 0.22, 0.48, 0.05)

    return [top, base]


def build_furniture_bookcase_open() -> list[PartBuilder]:
    """Open research bookcase with shelves and rows of books (research_bench)."""
    frame = PartBuilder("bookcase-frame", (0.46, 0.40, 0.56), roughness=0.68)
    books = PartBuilder("bookcase-books", (0.66, 0.58, 0.84), roughness=0.60)

    # Side uprights + back spine + 4 horizontal shelves
    frame.add_box(-0.42, 0.0, -0.16, -0.36, 0.86, 0.16)
    frame.add_box(0.36, 0.0, -0.16, 0.42, 0.86, 0.16)
    frame.add_box(-0.36, 0.0, -0.16, 0.36, 0.86, -0.12)
    for sy in (0.04, 0.28, 0.54, 0.80):
        frame.add_box(-0.36, sy, -0.12, 0.36, sy + 0.04, 0.16)

    # Book clusters on shelves
    books.add_box(-0.32, 0.08, -0.10, -0.06, 0.25, 0.10)
    books.add_box(0.04, 0.08, -0.10, 0.30, 0.24, 0.10)
    books.add_box(-0.30, 0.32, -0.10, 0.08, 0.50, 0.10)
    books.add_box(0.14, 0.32, -0.10, 0.32, 0.48, 0.10)
    books.add_box(-0.28, 0.58, -0.10, 0.22, 0.76, 0.10)

    return [frame, books]


def main() -> None:
    unit_specs = {
        "unit-mage": build_unit_mage,
        "unit-engineer": build_unit_engineer,
        "unit-rogue": build_unit_rogue,
        "unit-knight": build_unit_knight,
    }
    for name, builder in unit_specs.items():
        out = UNITS_DIR / f"{name}.glb"
        tris = export_glb(out, name, builder())
        size = out.stat().st_size
        assert tris <= 300, f"{name} exceeds 300 tris ({tris})"
        assert size < 60 * 1024, f"{name} exceeds 60 KB ({size} B)"
        print(f"[OK] units/{name}.glb: {tris} tris, {size} bytes")

    furniture_specs = {
        "desk": build_furniture_desk,
        "chairDesk": build_furniture_chair_desk,
        "loungeSofa": build_furniture_lounge_sofa,
        "tableConference": build_furniture_table_conference,
        "bookcaseOpen": build_furniture_bookcase_open,
    }
    for name, builder in furniture_specs.items():
        out = KENNEY_DIR / f"{name}.glb"
        tris = export_glb(out, name, builder())
        size = out.stat().st_size
        assert tris <= 300, f"{name} exceeds 300 tris ({tris})"
        assert size < 60 * 1024, f"{name} exceeds 60 KB ({size} B)"
        print(f"[OK] kenney/{name}.glb: {tris} tris, {size} bytes")


if __name__ == "__main__":
    main()
