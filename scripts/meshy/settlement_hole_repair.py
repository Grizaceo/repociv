"""Close accidental holes in settlement Image-to-3D meshes. 0 Meshy credits.

Forum: missing front gable / roof patch. Citadel: window perforations.
Patches only existing boundary loops; source corners never move. Original
geometry/preview.glb stays untouched. Intended recesses that already have a
back face have no boundary and are left alone.
"""
import hashlib
import json
from pathlib import Path

import numpy as np
from optimize_glb import build_glb
from repair_family_geometry import boundary_loops, edge_map, read_mesh, triangulate_loop

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ("city-forum", "city-citadel")
CANDIDATE = "repair-v001/preview.glb"


def sha256(blob):
    return hashlib.sha256(blob).hexdigest()


def simplify_loop(vertices, loop, eps=1e-7):
    """Drop consecutive near-duplicate corners so min-area triangulation can run.

    Meshy holes sometimes repeat the same position with two indices; a zero-length
    edge makes every candidate triangle degenerate. Positions themselves stay put.
    """
    cleaned = [loop[0]]
    for idx in loop[1:]:
        if np.linalg.norm(vertices[idx] - vertices[cleaned[-1]]) > eps:
            cleaned.append(idx)
    if len(cleaned) > 1 and np.linalg.norm(vertices[cleaned[0]] - vertices[cleaned[-1]]) <= eps:
        cleaned.pop()
    if len(cleaned) < 3:
        raise ValueError("Boundary collapsed below a triangle")
    return cleaned


def export_positions(vertices, faces):
    """POSITION-only GLB so family_texture prepare can apply the 42° crease."""
    chunks = [faces.astype("<u4").tobytes(), vertices.astype("<f4").tobytes()]
    views = [
        {"buffer": 0, "byteOffset": 0, "byteLength": len(chunks[0])},
        {"buffer": 0, "byteOffset": len(chunks[0]), "byteLength": len(chunks[1])},
    ]
    doc = {
        "asset": {"version": "2.0", "generator": "RepoCiv settlement hole repair"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 1}, "indices": 0, "mode": 4}]}],
        "buffers": [{"byteLength": sum(len(c) for c in chunks)}],
        "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5125, "count": int(faces.size), "type": "SCALAR"},
            {
                "bufferView": 1,
                "componentType": 5126,
                "count": len(vertices),
                "type": "VEC3",
                "min": vertices.min(0).tolist(),
                "max": vertices.max(0).tolist(),
            },
        ],
    }
    return build_glb(doc, b"".join(chunks))


def repair(asset):
    if asset not in ASSETS:
        raise ValueError("Asset is not in the settlement hole-repair batch")
    folder = ROOT / "assets-src/meshy" / asset
    source = folder / "geometry/preview.glb"
    vertices, faces = read_mesh(source.read_bytes())
    loops = boundary_loops(faces)
    existing = edge_map(faces)
    patches = []
    simplified_lengths = []
    for loop in loops:
        closed = simplify_loop(vertices, loop)
        simplified_lengths.append(len(closed))
        patches.extend(triangulate_loop(vertices, closed, existing))
    new_faces = np.concatenate([faces, np.asarray(patches, dtype=faces.dtype)])
    leftover = boundary_loops(new_faces)
    degenerate = 0
    for loop in leftover:
        if len(loop) != 3:
            raise ValueError("Non-triangular leftover boundary after patching")
        patches.append(list(loop))
        degenerate += 1
    new_faces = np.concatenate([faces, np.asarray(patches, dtype=faces.dtype)])
    if boundary_loops(new_faces):
        raise ValueError("Boundary remains after patching")
    blob = export_positions(vertices, new_faces)
    target = folder / CANDIDATE
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.read_bytes() != blob:
        raise SystemExit("repair-v001/preview.glb exists with different bytes; keep candidates immutable")
    target.write_bytes(blob)
    report = {
        "asset": asset,
        "source": "geometry/preview.glb",
        "source_sha256": sha256(source.read_bytes()),
        "candidate": CANDIDATE,
        "candidate_sha256": sha256(blob),
        "source_triangles": int(len(faces)),
        "added_triangles": len(patches),
        "candidate_triangles": int(len(new_faces)),
        "boundary_loops_before": len(loops),
        "boundary_loop_lengths": [len(loop) for loop in loops],
        "simplified_loop_lengths": simplified_lengths,
        "degenerate_leftover_triangles": degenerate,
        "source_positions_unchanged": True,
        "note": "Closes accidental holes only. Recessed panels with a back face have no boundary.",
    }
    (target.parent / "repair-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def _pos_on_wall(axis, plane, sign, u, y, depth=0.0):
    """axis 0: x-wall (u is z). axis 2: z-wall (u is x). depth > 0 moves inward."""
    shift = -sign * depth
    if axis == 0:
        return [float(plane + shift), float(y), float(u)]
    return [float(u), float(y), float(plane + shift)]


def _quad(v_list, faces, p00, p10, p11, p01, flip):
    i = len(v_list)
    v_list.extend((p00, p10, p11, p01))
    if flip:
        faces.extend(([i, i + 2, i + 1], [i, i + 3, i + 2]))
    else:
        faces.extend(([i, i + 1, i + 2], [i, i + 2, i + 3]))


def wall_with_recessed_windows(v_list, faces, axis, plane, sign, u0, u1, y0, y1, windows, recess=0.045):
    """Axis-aligned facade on a shared grid: solid strips plus recessed window boxes.

    `windows` are (u_lo, u_hi, y_lo, y_hi) in the wall's (u, y) plane.
    Returns the outer rectangle vertex ring (CCW from outside) for zippering.
    """
    flip = sign < 0
    windows = sorted((min(a, b), max(a, b), min(c, d), max(c, d)) for a, b, c, d in windows)
    us = [u0]
    for lo, hi, _, _ in windows:
        us.extend((lo, hi))
    us.append(u1)
    us = sorted(set(round(u, 6) for u in us))
    ys = [y0]
    if windows:
        ys.extend((min(w[2] for w in windows), max(w[3] for w in windows)))
    ys.append(y1)
    ys = sorted(set(round(y, 6) for y in ys))
    front = {}
    for i, u in enumerate(us):
        for j, y in enumerate(ys):
            front[i, j] = len(v_list)
            v_list.append(_pos_on_wall(axis, plane, sign, u, y))

    def emit(i00, i10, i11, i01):
        if flip:
            faces.extend(([i00, i11, i10], [i00, i01, i11]))
        else:
            faces.extend(([i00, i10, i11], [i00, i11, i01]))

    def in_window(um, ym):
        return any(lo - 1e-6 <= um <= hi + 1e-6 and yl - 1e-6 <= ym <= yh + 1e-6
                   for lo, hi, yl, yh in windows)

    for i, (ua, ub) in enumerate(zip(us, us[1:])):
        for j, (ya, yb) in enumerate(zip(ys, ys[1:])):
            i00, i10 = front[i, j], front[i + 1, j]
            i11, i01 = front[i + 1, j + 1], front[i, j + 1]
            if in_window((ua + ub) / 2, (ya + yb) / 2):
                b00 = len(v_list)
                v_list.append(_pos_on_wall(axis, plane, sign, ua, ya, recess))
                b10 = len(v_list)
                v_list.append(_pos_on_wall(axis, plane, sign, ub, ya, recess))
                b11 = len(v_list)
                v_list.append(_pos_on_wall(axis, plane, sign, ub, yb, recess))
                b01 = len(v_list)
                v_list.append(_pos_on_wall(axis, plane, sign, ua, yb, recess))
                emit(b00, b10, b11, b01)
                emit(i00, i10, b10, b00)
                emit(i10, i11, b11, b10)
                emit(i11, i01, b01, b11)
                emit(i01, i00, b00, b01)
            else:
                emit(i00, i10, i11, i01)
    nu, ny = len(us) - 1, len(ys) - 1
    ring = [front[i, 0] for i in range(nu + 1)]
    ring += [front[nu, j] for j in range(1, ny + 1)]
    ring += [front[i, ny] for i in range(nu - 1, -1, -1)]
    ring += [front[0, j] for j in range(ny - 1, 0, -1)]
    return ring


def _nearest_on_rect_boundary(u, y, u0, u1, y0, y1):
    u = float(np.clip(u, u0, u1))
    y = float(np.clip(y, y0, y1))
    du0, du1, dy0, dy1 = abs(u - u0), abs(u - u1), abs(y - y0), abs(y - y1)
    m = min(du0, du1, dy0, dy1)
    if m == du0:
        return u0, y
    if m == du1:
        return u1, y
    if m == dy0:
        return u, y0
    return u, y1


def zipper_loop_to_ring(vertices, loop, v_list, faces, ring):
    """Connect an original hole to a facade ring without moving source corners."""
    ring_pts = np.asarray([v_list[i] for i in ring], dtype=float)
    mapped = []
    for idx in loop:
        dist = np.linalg.norm(ring_pts - vertices[idx].astype(float), axis=1)
        mapped.append(ring[int(dist.argmin())])
    for i, idx in enumerate(loop):
        j = (i + 1) % len(loop)
        a, b = int(idx), int(loop[j])
        ap, bp = mapped[i], mapped[j]
        if a == b or (ap == bp and np.linalg.norm(vertices[a] - vertices[b]) < 1e-7):
            continue
        faces.extend(([a, b, bp], [a, bp, ap]))


def repair_citadel_v2():
    """Replace crumpled window membranes with planar facades and recessed panes."""
    folder = ROOT / "assets-src/meshy/city-citadel"
    source = folder / "geometry/preview.glb"
    vertices, faces = read_mesh(source.read_bytes())
    v_list = vertices.tolist()
    extra = []
    facades = [
        # Ground-floor side walls: the Image-to-3D mesh opened the whole elevation.
        (0, 0.429, 1, -0.429, 0.429, -0.353, -0.145,
         [(-0.32, -0.10, -0.330, -0.170), (0.10, 0.32, -0.330, -0.170)]),
        (0, -0.429, -1, -0.429, 0.429, -0.353, -0.145,
         [(-0.32, -0.10, -0.330, -0.170), (0.10, 0.32, -0.330, -0.170)]),
        # Middle terrace belt (front, back, both sides).
        (2, 0.318, 1, -0.318, 0.318, -0.039, 0.084, [(-0.16, 0.16, -0.020, 0.070)]),
        (2, -0.318, -1, -0.318, 0.318, -0.039, 0.084, [(-0.16, 0.16, -0.020, 0.070)]),
        (0, 0.318, 1, -0.318, 0.318, -0.039, 0.084,
         [(-0.22, -0.04, -0.020, 0.070), (0.04, 0.22, -0.020, 0.070)]),
        (0, -0.318, -1, -0.318, 0.318, -0.039, 0.084,
         [(-0.22, -0.04, -0.020, 0.070), (0.04, 0.22, -0.020, 0.070)]),
    ]
    rings = []
    for axis, plane, sign, u0, u1, y0, y1, windows in facades:
        rings.append(wall_with_recessed_windows(
            v_list, extra, axis, plane, sign, u0, u1, y0, y1, windows))
    orig_loops = boundary_loops(faces)
    # Ground sides → side facades; middle belt → front/back facades.
    zipper_pairs = ((3, 0), (4, 1), (1, 2), (2, 3))
    for loop_i, ring_i in zipper_pairs:
        zipper_loop_to_ring(
            vertices, simplify_loop(vertices, orig_loops[loop_i]),
            v_list, extra, rings[ring_i],
        )
    new_vertices = np.asarray(v_list, dtype=vertices.dtype)
    new_faces = np.concatenate([faces, np.asarray(extra, dtype=faces.dtype)])
    leftover_patches = []
    try:
        remain_loops = boundary_loops(new_faces)
    except ValueError:
        remain_loops = []
    existing = edge_map(new_faces)
    for loop in remain_loops:
        pts = new_vertices[loop].astype(float)
        span = pts.max(0) - pts.min(0)
        # Only cap leftover roofs / tiny planar cracks. Never re-membrane a window belt.
        if span[1] > 0.05 and max(span[0], span[2]) > 0.3:
            continue
        closed = simplify_loop(new_vertices, loop)
        try:
            leftover_patches.extend(triangulate_loop(new_vertices, closed, existing))
        except ValueError:
            if len(closed) == 3:
                leftover_patches.append(list(closed))
    if leftover_patches:
        new_faces = np.concatenate([new_faces, np.asarray(leftover_patches, dtype=faces.dtype)])
    degenerate = (
        (new_faces[:, 0] == new_faces[:, 1])
        | (new_faces[:, 1] == new_faces[:, 2])
        | (new_faces[:, 0] == new_faces[:, 2])
    )
    dropped_degenerate = int(degenerate.sum())
    new_faces = new_faces[~degenerate]
    try:
        remain = boundary_loops(new_faces)
    except ValueError as exc:
        remain = None
        report_boundary = str(exc)
    else:
        report_boundary = [len(loop) for loop in remain]
    blob = export_positions(new_vertices, new_faces)
    target = folder / "repair-v003/preview.glb"
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.read_bytes() != blob:
        raise SystemExit("repair-v003/preview.glb exists with different bytes; keep candidates immutable")
    target.write_bytes(blob)
    report = {
        "asset": "city-citadel",
        "source": "geometry/preview.glb",
        "source_sha256": sha256(source.read_bytes()),
        "candidate": "repair-v003/preview.glb",
        "dropped_degenerate_triangles": dropped_degenerate,
        "candidate_sha256": sha256(blob),
        "source_triangles": int(len(faces)),
        "facade_triangles": len(extra),
        "leftover_triangles": len(leftover_patches),
        "candidate_triangles": int(len(new_faces)),
        "source_positions_unchanged": True,
        "source_vertex_prefix": True,
        "remaining_boundary": report_boundary,
        "note": "Planar facades with recessed window boxes. repair-v001/v002 kept immutable.",
    }
    (target.parent / "repair-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("asset", choices=ASSETS + ("city-citadel-v2",))
    args = parser.parse_args()
    if args.asset == "city-citadel-v2":
        print(json.dumps(repair_citadel_v2(), indent=2))
        return
    print(json.dumps(repair(args.asset), indent=2))


if __name__ == "__main__":
    main()
