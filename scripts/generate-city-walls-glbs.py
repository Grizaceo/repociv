#!/usr/bin/env python3
"""Deterministic knowledge-city wall kit (0 Meshy credits).

Emits four low-poly GLBs for the hex ring in CityWalls3D:

  wall-straight.glb   → wall_straight
  wall-gate.glb       → wall_straight_gate
  wall-tower-a.glb    → building_tower_A_red
  wall-tower-b.glb    → building_tower_B_red

Each piece is Y-up, grounded at Y=0, POSITION+NORMAL only, 42° crease
normals, and three PBR factors matching the living-knowledge-city grammar:

  limestone  #d8ccb8  matte
  slate      #343d48  moderately rough
  copper     #8c6244  metallic cap / cornice / frames

Straight-wall proportions keep KayKit's depth/length ≈ 0.40 so the
RING_R=0.42 / STRAIGHT_SPAN=0.4 layout math still holds after bbox
normalization (longest side is length X for walls, height Y for towers).
Triangle budget: ≤ 250 per piece. Binary layout matches
scripts/meshy/optimize_glb.py (GLB v2, JSON+BIN, 4-byte padding).
"""
from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "public" / "assets" / "3d" / "props" / "knowledge-city"

GLB_MAGIC = b"glTF"
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
FLOAT = 5126
UNSIGNED_SHORT = 5123
CREASE_DEGREES = 42
MAX_TRIANGLES = 250

# Visual grammar (sRGB 8-bit → linear-ish factors; Three.js MeshStandard
# multiplies these as baseColorFactor).
LIMESTONE = "#d8ccb8"
SLATE = "#343d48"
COPPER = "#8c6244"

Vec3 = tuple[float, float, float]
Tri = tuple[int, int, int]


def hex_rgb(value: str) -> tuple[float, float, float]:
    raw = value.lstrip("#")
    return (int(raw[0:2], 16) / 255.0, int(raw[2:4], 16) / 255.0, int(raw[4:6], 16) / 255.0)


def _sub(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _dot(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _length(v: Vec3) -> float:
    return math.sqrt(_dot(v, v))


def _norm(v: Vec3) -> Vec3:
    size = _length(v)
    if size < 1e-30:
        return (0.0, 1.0, 0.0)
    return (v[0] / size, v[1] / size, v[2] / size)


def _add(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _scale(v: Vec3, s: float) -> Vec3:
    return (v[0] * s, v[1] * s, v[2] * s)


def build_glb(doc: dict, binary: bytes) -> bytes:
    """Serialize ``(doc, binary)`` into a padded GLB v2 container (optimize_glb)."""
    payload = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload += b" " * (-len(payload) % 4)
    padded = bytes(binary) + b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(payload) + 8 + len(padded)
    return (
        struct.pack("<4sII", GLB_MAGIC, 2, total)
        + struct.pack("<II", len(payload), JSON_CHUNK)
        + payload
        + struct.pack("<II", len(padded), BIN_CHUNK)
        + padded
    )


def crease_normals(
    vertices: list[Vec3],
    faces: list[Tri],
    angle_degrees: float = CREASE_DEGREES,
) -> tuple[list[Vec3], list[Tri], list[Vec3]]:
    """Split lighting discontinuities without moving triangle corners.

    Same rule as scripts/meshy/repair_family_geometry.py: smooth only
    same-facing neighbors within ``angle_degrees``. 90° masonry edges stay
    sharp; coplanar quads share a lighting normal.
    """
    face_vectors: list[Vec3] = []
    face_units: list[Vec3] = []
    face_areas: list[float] = []
    for i0, i1, i2 in faces:
        vector = _cross(_sub(vertices[i1], vertices[i0]), _sub(vertices[i2], vertices[i0]))
        area = _length(vector)
        face_vectors.append(vector)
        face_areas.append(area)
        face_units.append(_norm(vector) if area > 1e-15 else (0.0, 1.0, 0.0))

    incident: dict[int, list[int]] = {}
    for face_id, face in enumerate(faces):
        for vertex in face:
            incident.setdefault(vertex, []).append(face_id)

    positions = list(vertices)
    normals: list[Vec3 | None] = [None] * len(vertices)
    new_faces: list[list[int]] = [list(face) for face in faces]
    cosine = math.cos(math.radians(angle_degrees))

    for vertex, ids in incident.items():
        cache: dict[bytes, int] = {}
        fallback = ids[max(range(len(ids)), key=lambda i: face_areas[ids[i]])]
        for face_id in ids:
            reference = face_units[face_id] if face_areas[face_id] > 1e-15 else face_units[fallback]
            neighbors = [n for n in ids if _dot(face_units[n], reference) >= cosine]
            average = (0.0, 0.0, 0.0)
            for n in neighbors:
                average = _add(average, face_vectors[n])
            normal = _norm(average) if _length(average) > 1e-20 else (0.0, 1.0, 0.0)
            packed = struct.pack("<fff", *normal)
            if packed not in cache:
                if normals[vertex] is None:
                    index = vertex
                    normals[vertex] = normal
                else:
                    index = len(positions)
                    positions.append(vertices[vertex])
                    normals.append(normal)
                cache[packed] = index
            for corner, src in enumerate(faces[face_id]):
                if src == vertex:
                    new_faces[face_id][corner] = cache[packed]
                    break

    out_normals = [(0.0, 1.0, 0.0) if n is None else n for n in normals]
    rebuilt = [tuple(face) for face in new_faces]
    for face, original in zip(rebuilt, faces):
        for new_i, old_i in zip(face, original):
            if positions[new_i] != vertices[old_i]:
                raise ValueError("Triangle coordinates changed during normal split")
    return positions, rebuilt, out_normals


class MaterialMesh:
    """Welded triangles for one PBR slot; crease-split on export."""

    def __init__(
        self,
        name: str,
        color_hex: str,
        *,
        roughness: float,
        metallic: float,
    ) -> None:
        self.name = name
        self.color = hex_rgb(color_hex)
        self.roughness = roughness
        self.metallic = metallic
        self.positions: list[Vec3] = []
        self.faces: list[Tri] = []
        self._index: dict[tuple[float, float, float], int] = {}

    def vert(self, p: Vec3) -> int:
        key = (round(p[0], 6), round(p[1], 6), round(p[2], 6))
        existing = self._index.get(key)
        if existing is not None:
            return existing
        idx = len(self.positions)
        self._index[key] = idx
        self.positions.append((float(p[0]), float(p[1]), float(p[2])))
        return idx

    def add_tri(self, p0: Vec3, p1: Vec3, p2: Vec3) -> None:
        i0, i1, i2 = self.vert(p0), self.vert(p1), self.vert(p2)
        if i0 == i1 or i1 == i2 or i2 == i0:
            return
        self.faces.append((i0, i1, i2))

    def add_quad(self, p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3) -> None:
        self.add_tri(p0, p1, p2)
        self.add_tri(p0, p2, p3)

    def add_box(
        self,
        x0: float,
        y0: float,
        z0: float,
        x1: float,
        y1: float,
        z1: float,
        skip: frozenset[str] = frozenset(),
    ) -> None:
        # Outward CCW, Y-up, right-handed.
        if "pz" not in skip:
            self.add_quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))
        if "nz" not in skip:
            self.add_quad((x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0))
        if "px" not in skip:
            self.add_quad((x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1))
        if "nx" not in skip:
            self.add_quad((x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0))
        if "top" not in skip:
            self.add_quad((x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0))
        if "bottom" not in skip:
            self.add_quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1))

    def add_frustum(
        self,
        cx: float,
        cz: float,
        y0: float,
        y1: float,
        r0: float,
        r1: float,
        *,
        sides: int = 4,
        cap_top: bool = True,
        cap_bottom: bool = False,
        turn: float = math.pi / 4,
    ) -> None:
        ring0: list[Vec3] = []
        ring1: list[Vec3] = []
        for i in range(sides):
            ang = turn + (i / sides) * math.tau
            c, s = math.cos(ang), math.sin(ang)
            ring0.append((cx + c * r0, y0, cz + s * r0))
            ring1.append((cx + c * r1, y1, cz + s * r1))
        for i in range(sides):
            nxt = (i + 1) % sides
            self.add_quad(ring0[nxt], ring0[i], ring1[i], ring1[nxt])
        if cap_top and r1 > 1e-6:
            center = (cx, y1, cz)
            for i in range(sides):
                nxt = (i + 1) % sides
                self.add_tri(center, ring1[nxt], ring1[i])
        if cap_bottom and r0 > 1e-6:
            center = (cx, y0, cz)
            for i in range(sides):
                nxt = (i + 1) % sides
                self.add_tri(center, ring0[i], ring0[nxt])

    @property
    def tri_count(self) -> int:
        return len(self.faces)


def limestone() -> MaterialMesh:
    return MaterialMesh("limestone", LIMESTONE, roughness=0.88, metallic=0.0)


def slate() -> MaterialMesh:
    return MaterialMesh("slate", SLATE, roughness=0.62, metallic=0.0)


def copper() -> MaterialMesh:
    return MaterialMesh("copper", COPPER, roughness=0.38, metallic=0.82)


def add_recessed_panel(
    stone: MaterialMesh,
    metal: MaterialMesh,
    *,
    cx: float,
    cy: float,
    cz: float,
    w: float,
    h: float,
    facing: str,
    depth: float = 0.045,
    frame: float = 0.035,
) -> None:
    """Closed rectangular panel sitting in front of a thicker copper frame. Never a hole."""
    hw, hh = w / 2, h / 2
    inset = frame
    if facing in ("+z", "-z"):
        sign = 1.0 if facing == "+z" else -1.0
        # Copper sits against the wall; limestone reads in front as the recessed pane.
        z_back = cz
        z_mid = cz + sign * depth * 0.45
        z_front = cz + sign * depth
        metal.add_box(cx - hw, cy - hh, min(z_back, z_mid), cx + hw, cy + hh, max(z_back, z_mid))
        stone.add_box(
            cx - hw + inset,
            cy - hh + inset,
            min(z_mid, z_front),
            cx + hw - inset,
            cy + hh - inset,
            max(z_mid, z_front),
        )
        return
    sign = 1.0 if facing == "+x" else -1.0
    x_back = cx
    x_mid = cx + sign * depth * 0.45
    x_front = cx + sign * depth
    metal.add_box(min(x_back, x_mid), cy - hh, cz - hw, max(x_back, x_mid), cy + hh, cz + hw)
    stone.add_box(
        min(x_mid, x_front),
        cy - hh + inset,
        cz - hw + inset,
        max(x_mid, x_front),
        cy + hh - inset,
        cz + hw - inset,
    )


def build_straight() -> list[MaterialMesh]:
    """KayKit-compatible span: length ≈ 2.12, depth ≈ 0.84, height < length."""
    stone, roof, metal = limestone(), slate(), copper()
    stone.add_box(-1.02, 0.00, -0.36, 1.02, 0.10, 0.36)
    stone.add_box(-1.00, 0.10, -0.32, 1.00, 0.78, 0.32, skip=frozenset({"bottom"}))
    add_recessed_panel(stone, metal, cx=0.0, cy=0.42, cz=0.32, w=0.72, h=0.38, facing="+z")
    add_recessed_panel(stone, metal, cx=0.0, cy=0.42, cz=-0.32, w=0.72, h=0.38, facing="-z")
    metal.add_box(-1.04, 0.78, -0.40, 1.04, 0.84, 0.40)
    roof.add_box(-1.06, 0.84, -0.42, 1.06, 0.96, 0.42)
    return [stone, roof, metal]


def build_gate() -> list[MaterialMesh]:
    """Two thick pylons + closed lintel; the passage is the only opening."""
    stone, roof, metal = limestone(), slate(), copper()
    # Stepped pylons (left / right). Longest side remains X (≈2.12).
    for x0, x1 in ((-1.06, -0.34), (0.34, 1.06)):
        stone.add_box(x0, 0.00, -0.38, x1, 0.12, 0.38)
        stone.add_box(x0 + 0.04, 0.12, -0.34, x1 - 0.04, 0.92, 0.34, skip=frozenset({"bottom"}))
    add_recessed_panel(stone, metal, cx=-0.70, cy=0.48, cz=0.34, w=0.36, h=0.42, facing="+z")
    add_recessed_panel(stone, metal, cx=0.70, cy=0.48, cz=0.34, w=0.36, h=0.42, facing="+z")
    add_recessed_panel(stone, metal, cx=-0.70, cy=0.48, cz=-0.34, w=0.36, h=0.42, facing="-z")
    add_recessed_panel(stone, metal, cx=0.70, cy=0.48, cz=-0.34, w=0.36, h=0.42, facing="-z")
    # Threshold (passage floor) and lintel (closed roof over the opening).
    stone.add_box(-0.34, 0.00, -0.30, 0.34, 0.08, 0.30)
    stone.add_box(-1.00, 0.92, -0.36, 1.00, 1.10, 0.36)
    metal.add_box(-1.04, 1.10, -0.40, 1.04, 1.16, 0.40)
    # Copper inner frame around the passage — thick connected pieces, not filigree.
    metal.add_box(-0.38, 0.08, -0.36, -0.32, 0.92, 0.36)
    metal.add_box(0.32, 0.08, -0.36, 0.38, 0.92, 0.36)
    metal.add_box(-0.32, 0.86, -0.36, 0.32, 0.92, 0.36)
    roof.add_box(-1.06, 1.16, -0.42, 1.06, 1.28, 0.42)
    return [stone, roof, metal]


def build_tower_a() -> list[MaterialMesh]:
    """Squatter keep: two limestone terraces, hipped slate, copper crown. Y longest."""
    stone, roof, metal = limestone(), slate(), copper()
    stone.add_box(-0.52, 0.00, -0.52, 0.52, 0.12, 0.52)
    stone.add_box(-0.44, 0.12, -0.44, 0.44, 1.18, 0.44, skip=frozenset({"bottom"}))
    stone.add_box(-0.34, 1.18, -0.34, 0.34, 1.52, 0.34, skip=frozenset({"bottom"}))
    for facing, cx, cz in (("+z", 0.0, 0.44), ("-z", 0.0, -0.44), ("+x", 0.44, 0.0), ("-x", -0.44, 0.0)):
        add_recessed_panel(stone, metal, cx=cx, cy=0.62, cz=cz, w=0.28, h=0.36, facing=facing)
    metal.add_box(-0.40, 1.52, -0.40, 0.40, 1.58, 0.40)
    roof.add_frustum(0.0, 0.0, 1.58, 1.98, 0.48, 0.08, cap_top=False)
    metal.add_box(-0.06, 1.96, -0.06, 0.06, 2.10, 0.06)
    return [stone, roof, metal]


def build_tower_b() -> list[MaterialMesh]:
    """Taller slender watch-keep: three terraces and a tighter slate hip. Y longest."""
    stone, roof, metal = limestone(), slate(), copper()
    stone.add_box(-0.44, 0.00, -0.44, 0.44, 0.10, 0.44)
    stone.add_box(-0.36, 0.10, -0.36, 0.36, 1.05, 0.36, skip=frozenset({"bottom"}))
    stone.add_box(-0.28, 1.05, -0.28, 0.28, 1.55, 0.28, skip=frozenset({"bottom"}))
    stone.add_box(-0.22, 1.55, -0.22, 0.22, 1.88, 0.22, skip=frozenset({"bottom"}))
    for facing, cx, cz in (("+z", 0.0, 0.36), ("-z", 0.0, -0.36), ("+x", 0.36, 0.0), ("-x", -0.36, 0.0)):
        add_recessed_panel(stone, metal, cx=cx, cy=0.52, cz=cz, w=0.22, h=0.32, facing=facing)
    metal.add_box(-0.32, 1.88, -0.32, 0.32, 1.94, 0.32)
    roof.add_frustum(0.0, 0.0, 1.94, 2.28, 0.38, 0.06, cap_top=False)
    metal.add_box(-0.05, 2.26, -0.05, 0.05, 2.40, 0.05)
    return [stone, roof, metal]


PIECES = {
    "wall-straight": build_straight,
    "wall-gate": build_gate,
    "wall-tower-a": build_tower_a,
    "wall-tower-b": build_tower_b,
}

# Runtime id → generated stem. CityWalls3D overlays these when preview is on.
RUNTIME_IDS = {
    "wall-straight": "wall_straight",
    "wall-gate": "wall_straight_gate",
    "wall-tower-a": "building_tower_A_red",
    "wall-tower-b": "building_tower_B_red",
}


def _append_bin(chunks: list[bytes], views: list[dict], raw: bytes, target: int) -> int:
    offset = sum(len(c) for c in chunks)
    pad = b"\0" * (-len(raw) % 4)
    views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(raw), "target": target})
    chunks.append(raw + pad)
    return len(views) - 1


def export_glb(path: Path, node_name: str, parts: list[MaterialMesh]) -> dict:
    used = [p for p in parts if p.faces]
    if not used:
        raise ValueError(f"{node_name} has no geometry")

    accessors: list[dict] = []
    views: list[dict] = []
    chunks: list[bytes] = []
    materials: list[dict] = []
    primitives: list[dict] = []
    total_tris = 0
    min_xyz = [math.inf, math.inf, math.inf]
    max_xyz = [-math.inf, -math.inf, -math.inf]

    for part in used:
        positions, faces, normals = crease_normals(part.positions, part.faces)
        if len(positions) > 65535:
            raise ValueError(f"{node_name}/{part.name} exceeds UNSIGNED_SHORT")
        total_tris += len(faces)
        xs = [p[0] for p in positions]
        ys = [p[1] for p in positions]
        zs = [p[2] for p in positions]
        min_xyz = [min(min_xyz[0], min(xs)), min(min_xyz[1], min(ys)), min(min_xyz[2], min(zs))]
        max_xyz = [max(max_xyz[0], max(xs)), max(max_xyz[1], max(ys)), max(max_xyz[2], max(zs))]

        pos_bytes = b"".join(struct.pack("<fff", *p) for p in positions)
        nrm_bytes = b"".join(struct.pack("<fff", *n) for n in normals)
        idx_bytes = b"".join(struct.pack("<HHH", *face) for face in faces)
        pos_view = _append_bin(chunks, views, pos_bytes, ARRAY_BUFFER)
        nrm_view = _append_bin(chunks, views, nrm_bytes, ARRAY_BUFFER)
        idx_view = _append_bin(chunks, views, idx_bytes, ELEMENT_ARRAY_BUFFER)

        pos_acc = len(accessors)
        accessors.append(
            {
                "bufferView": pos_view,
                "componentType": FLOAT,
                "count": len(positions),
                "type": "VEC3",
                "min": [min(xs), min(ys), min(zs)],
                "max": [max(xs), max(ys), max(zs)],
            }
        )
        nrm_acc = len(accessors)
        accessors.append({"bufferView": nrm_view, "componentType": FLOAT, "count": len(normals), "type": "VEC3"})
        idx_acc = len(accessors)
        accessors.append(
            {"bufferView": idx_view, "componentType": UNSIGNED_SHORT, "count": len(faces) * 3, "type": "SCALAR"}
        )

        mat_idx = len(materials)
        materials.append(
            {
                "name": part.name,
                "pbrMetallicRoughness": {
                    "baseColorFactor": [part.color[0], part.color[1], part.color[2], 1.0],
                    "metallicFactor": part.metallic,
                    "roughnessFactor": part.roughness,
                },
            }
        )
        primitives.append(
            {"attributes": {"POSITION": pos_acc, "NORMAL": nrm_acc}, "indices": idx_acc, "material": mat_idx, "mode": 4}
        )

    if total_tris > MAX_TRIANGLES:
        raise ValueError(f"{node_name} has {total_tris} triangles > {MAX_TRIANGLES}")
    if min_xyz[1] < -1e-6:
        raise ValueError(f"{node_name} dips below Y=0 ({min_xyz[1]})")

    binary = b"".join(chunks)
    doc = {
        "asset": {"generator": "RepoCiv knowledge-city wall kit", "version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": node_name}],
        "meshes": [{"name": node_name, "primitives": primitives}],
        "materials": materials,
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(binary)}],
    }
    blob = build_glb(doc, binary)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(blob)
    tmp.replace(path)
    size = [max_xyz[i] - min_xyz[i] for i in range(3)]
    return {
        "name": node_name,
        "path": str(path),
        "bytes": len(blob),
        "triangles": total_tris,
        "min": min_xyz,
        "max": max_xyz,
        "size": size,
        "longest_axis": "xyz"[size.index(max(size))],
        "materials": [m["name"] for m in materials],
    }


def generate(out_dir: Path) -> list[dict]:
    reports = []
    for stem, builder in PIECES.items():
        reports.append(export_glb(out_dir / f"{stem}.glb", stem, builder()))
    return reports


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    reports = generate(args.out)
    print(json.dumps({"out": str(args.out), "pieces": reports}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
