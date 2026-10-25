"""0-credit local follow-up for the citadel's two remaining left-elevation windows.

Cristóbal: «quedo mejor faltan solo 2 ventanas por arreglar dejalo anotado», then
authorized the local repair. repair-v003 stays immutable.

1. Cap the leftover 16-vertex hole on the middle-terrace left wall (x = -0.318).
2. Cover the ground-floor missing-plaster patch with a limestone panel (no atlas paint).
3. Write repair-v004 (clay) and texture-v004 (textured + runtime copy).

No Meshy API, no paid retries, no movement of repair-v003 corners.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict

import numpy as np

from family_texture import glb_from_arrays, read_mesh as read_textured
from optimize_glb import optimize
from repair_family_geometry import edge_map, read_mesh, triangulate_loop
from settlement_hole_repair import ROOT, export_positions, sha256, simplify_loop

FOLDER = ROOT / "assets-src/meshy/city-citadel"
V003 = FOLDER / "repair-v003/preview.glb"
V004_DIR = FOLDER / "repair-v004"
TEXTURED = FOLDER / "texture-v003/textured.glb"
OUT_TEX_DIR = FOLDER / "texture-v004"
PUBLIC = ROOT / "public/assets/3d/props/meshy/city-citadel-map.glb"
# The runtime this follow-up was written to replace (texture-v003). A rerun
# after promotion is also allowed because it writes identical bytes.
EXPECTED_PREVIOUS_RUNTIME_SHA256 = (
    "e5a3e9d1b96d92addfd53cceee1f1428ae35135ddb1f5b9e958dd787085b97da"
)
FORCE_PROMOTE_ENV = "REPOCIV_CITADEL_FORCE_PROMOTE"
LEFT_X = -0.318
GROUND_X = -0.429
# Known limestone texel on the accepted albedo (not a window or slate chart).
CREAM_UV = (0.151, 0.135)
LEFT_NORMAL = (-1.0, 0.0, 0.0)
# Slightly outside the ground-floor left wall so the panel hides the brown patch.
GROUND_PANEL = {
    "x": GROUND_X - 0.007,
    "y_top": -0.148,
    "y_bottom": -0.345,
    "z_min": -0.115,
    "z_max": 0.115,
}


def _walk_loop(adj: dict[int, list[int]], vertices: np.ndarray) -> list[int]:
    start = min(adj, key=lambda i: (float(vertices[i, 2]), float(vertices[i, 1])))
    loop = [start]
    prev = None
    at = start
    while True:
        nxts = [n for n in adj[at] if n != prev]
        if not nxts:
            raise ValueError("Open window-belt loop")
        nxt = nxts[0]
        if nxt == start:
            break
        loop.append(nxt)
        prev, at = at, nxt
        if len(loop) > 64:
            raise ValueError("Window-belt loop did not close")
    return loop


def leftover_middle_left_loop(vertices: np.ndarray, faces: np.ndarray) -> list[int]:
    edges = defaultdict(int)
    for a, b, c in faces:
        for i, j in ((int(a), int(b)), (int(b), int(c)), (int(c), int(a))):
            edges[(min(i, j), max(i, j))] += 1
    adj: dict[int, list[int]] = defaultdict(list)
    for (i, j), n in edges.items():
        if n != 1:
            continue
        mid = (vertices[i] + vertices[j]) / 2
        if abs(float(mid[0]) - LEFT_X) < 0.03 and -0.05 < float(mid[1]) < 0.09:
            adj[i].append(j)
            adj[j].append(i)
    if not adj:
        return []
    if any(len(vs) != 2 for vs in adj.values()):
        raise ValueError("Middle-left leftover is not a simple loop")
    return _walk_loop(adj, vertices)


def cap_clay() -> tuple[dict, list[int], np.ndarray]:
    vertices, faces = read_mesh(V003.read_bytes())
    loop = leftover_middle_left_loop(vertices, faces)
    if not loop:
        raise ValueError("No leftover middle-left window belt on repair-v003")
    closed = simplify_loop(vertices, loop)
    patches = triangulate_loop(vertices, closed, edge_map(faces))
    new_faces = np.concatenate([faces, np.asarray(patches, dtype=faces.dtype)])
    leftover = leftover_middle_left_loop(vertices, new_faces)
    blob = export_positions(vertices, new_faces)
    V004_DIR.mkdir(parents=True, exist_ok=True)
    target = V004_DIR / "preview.glb"
    if target.exists() and target.read_bytes() != blob:
        raise SystemExit("repair-v004/preview.glb exists with different bytes; keep candidates immutable")
    target.write_bytes(blob)
    report = {
        "asset": "city-citadel",
        "source": "repair-v003/preview.glb",
        "source_sha256": sha256(V003.read_bytes()),
        "candidate": "repair-v004/preview.glb",
        "candidate_sha256": sha256(blob),
        "source_triangles": int(len(faces)),
        "added_triangles": len(patches),
        "candidate_triangles": int(len(new_faces)),
        "loop_vertices": len(closed),
        "middle_left_leftover_after": len(leftover),
        "source_positions_unchanged": True,
        "new_paid_requests": 0,
        "note": "Caps the leftover middle-terrace left window belt. Ground-floor brown patch is covered by a limestone panel on the textured mesh.",
    }
    (V004_DIR / "repair-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    return report, closed, vertices, faces


def _material_extra(doc: dict, binary: bytes) -> dict:
    images = []
    for image in doc.get("images") or []:
        view = doc["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        blob = binary[start : start + view["byteLength"]]
        images.append((image["mimeType"], blob))
    return {
        "images": images,
        "textures": doc.get("textures") or [],
        "materials": doc.get("materials") or [],
        "samplers": doc.get("samplers") or [],
    }


def map_clay_loop_to_textured(
    clay_vertices: np.ndarray,
    clay_faces: np.ndarray,
    tex_pos: np.ndarray,
    tex_faces: np.ndarray,
    clay_loop: list[int],
) -> list[int]:
    """Same triangle order, UV-split indices: map each clay corner via matching position."""
    if len(clay_faces) != len(tex_faces):
        raise ValueError("Textured triangle count drifted from repair-v003")
    cmap: dict[int, int] = {}
    for i, clay_face in enumerate(clay_faces):
        tex_face = tex_faces[i]
        tex_pts = tex_pos[tex_face]
        for cvx in clay_face:
            cvx = int(cvx)
            dist = np.linalg.norm(tex_pts - clay_vertices[cvx], axis=1)
            cmap.setdefault(cvx, int(tex_face[int(dist.argmin())]))
    mapped = [cmap[i] for i in clay_loop]
    if len(set(mapped)) != len(mapped):
        raise ValueError("Clay window loop collapsed under UV splits")
    if np.linalg.norm(tex_pos[mapped] - clay_vertices[clay_loop], axis=1).max() > 1e-5:
        raise ValueError("Mapped textured loop does not match clay positions")
    return mapped


def _append_limestone(attr: dict, faces: np.ndarray, positions: np.ndarray, local_faces: list):
    """New verts with a limestone UV so a cap cannot inherit window-rim charts."""
    n0 = len(attr["POSITION"])
    n = len(positions)
    cream = np.array(CREAM_UV, dtype=np.float32)
    left = np.array(LEFT_NORMAL, dtype=np.float32)
    attr["POSITION"] = np.vstack([attr["POSITION"], np.asarray(positions, dtype=np.float32)])
    attr["NORMAL"] = np.vstack([attr["NORMAL"], np.repeat(left[None, :], n, axis=0)])
    attr["TEXCOORD_0"] = np.vstack([attr["TEXCOORD_0"], np.repeat(cream[None, :], n, axis=0)])
    added = np.asarray(local_faces, dtype=faces.dtype) + n0
    return attr, np.concatenate([faces, added]), len(added)


def cap_textured(clay_loop: list[int], clay_vertices: np.ndarray, clay_faces: np.ndarray):
    """Cap with new limestone verts. Rim UVs on the UV-split mesh read as an interior."""
    doc, binary, attr, faces, _prim = read_textured(TEXTURED.read_bytes())
    mapped = map_clay_loop_to_textured(
        clay_vertices, clay_faces, attr["POSITION"], faces, clay_loop
    )
    closed = simplify_loop(attr["POSITION"], mapped)
    points = attr["POSITION"][closed]
    local = list(range(len(closed)))
    patches = triangulate_loop(points, local, {})
    extra = _material_extra(doc, binary)
    attr, faces, n_cap = _append_limestone(attr, faces, points, patches)
    return attr, faces, extra, n_cap


def cover_ground_patch(attr: dict, faces: np.ndarray):
    """Opaque limestone panel over the ground-floor brown plaster; atlas stays untouched."""
    p = GROUND_PANEL
    # Camera at -X looking +X: screen-right is +Z, screen-up is +Y. CCW from outside.
    bl = [p["x"], p["y_bottom"], p["z_min"]]
    br = [p["x"], p["y_bottom"], p["z_max"]]
    tr = [p["x"], p["y_top"], p["z_max"]]
    tl = [p["x"], p["y_top"], p["z_min"]]
    attr, faces, n = _append_limestone(attr, faces, np.array([bl, br, tr, tl]), [[0, 1, 2], [0, 2, 3]])
    return attr, faces, n


def promote_runtime(optimized: bytes) -> None:
    """Copy the candidate to the public runtime, refusing to clobber a newer one.

    The script is a one-off promotion from texture-v003. Re-running it must be
    idempotent, and a runtime that is neither the expected input nor the
    candidate (for example, a newer human-approved texture) must not be
    silently replaced. Override with ``REPOCIV_CITADEL_FORCE_PROMOTE=1`` only
    after inspecting both hashes.
    """
    new_sha = sha256(optimized)
    if PUBLIC.exists():
        current_sha = sha256(PUBLIC.read_bytes())
        allowed = {new_sha, EXPECTED_PREVIOUS_RUNTIME_SHA256}
        if current_sha not in allowed and os.environ.get(FORCE_PROMOTE_ENV) != "1":
            raise RuntimeError(
                "Refusing to overwrite the city-citadel runtime: current sha256 "
                f"{current_sha} is neither the expected pre-followup runtime "
                f"({EXPECTED_PREVIOUS_RUNTIME_SHA256}) nor the candidate "
                f"({new_sha}). Set {FORCE_PROMOTE_ENV}=1 to override."
            )
    PUBLIC.write_bytes(optimized)


def followup() -> dict:
    clay, loop, clay_vertices, clay_faces = cap_clay()
    attr, faces, extra, tex_patches = cap_textured(loop, clay_vertices, clay_faces)
    attr, faces, panel_tris = cover_ground_patch(attr, faces)
    normals = attr.get("NORMAL")
    if normals is None or len(normals) != len(attr["POSITION"]):
        raise ValueError("Textured mesh missing normals")
    textured_blob = glb_from_arrays(attr["POSITION"], normals, attr["TEXCOORD_0"], faces, extra)
    OUT_TEX_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_TEX_DIR / "textured.glb").write_bytes(textured_blob)
    optimized, opt_report = optimize(textured_blob, max_size=512)
    (OUT_TEX_DIR / "city-citadel-map.glb").write_bytes(optimized)
    promote_runtime(optimized)
    report = {
        **clay,
        "textured_added_triangles": tex_patches,
        "ground_panel_triangles": panel_tris,
        "runtime_sha256": sha256(optimized),
        "runtime_bytes": len(optimized),
        "optimize_triangles": opt_report.get("structure", {}).get("triangles"),
    }
    (OUT_TEX_DIR / "followup-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    print(json.dumps(followup(), indent=2))
