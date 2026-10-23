"""Deterministic local boundary/normal repair for three Meshy clay meshes.

Never move source triangle corners. Add wound boundary patches, split lighting
normals at creases, and explicitly replace one folded vault support closure.
Originals and approved/deferred assets are read-only. No paid API, remeshing,
global hull, or double-sided material workaround.
"""
import argparse
from collections import defaultdict, deque
import hashlib
import json
from pathlib import Path

import numpy as np
from optimize_glb import parse_glb, build_glb

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ('coordination-court', 'artifact-vault', 'research-laboratory', 'execution-workshop')
WORKSHOP_SHA256 = '6ca232dbf5bccc6318532e3a8d52de56873e69e2966011ffa83b4f6bb6759426'
WORKSHOP_DROP_COMPONENTS = frozenset({
    7, 12, 16, 22, 24, 26, 58, 59, 66, 76, 78, 96, 100,
    115, 121, 127, 128, 148, 154, 155,
    75, 153, 162,
})
WORKSHOP_HEXAHEDRA = (
    # Front Left wall bands + recessed window panel
    ([1917, 204, 1083, 1475], [1365, 872, 420, 1631]),
    ([872, 496, 2032, 420], [1435, 1577, 1377, 1782]),
    ([888, 1486, 1534, 365], [496, 73, 4, 2032]),
    # Front Right wall bands + recessed window panel
    ([411, 1164, 190, 1860], [696, 1633, 724, 302]),
    ([1633, 1524, 1675, 724], [344, 929, 49, 1152]),
    ([2003, 1156, 1014, 67], [1524, 982, 337, 1675]),
    # Back Left & Back Right wall bands + recessed window backing
    ([393, 620, 2192, 1213], [1526, 769, 1758, 837]),
    ([1942, 783, 1598, 966], [1335, 467, 1128, 1625]),
    # Left Side wall bands + 2 recessed window panels
    ([659, 1443, 1097, 108], [1814, 964, 1137, 1240]),
    ([964, 604, 1309, 1137], [1059, 1882, 34, 366]),
    ([296, 1993, 800, 515], [604, 1012, 287, 1309]),
    ([1012, 1209, 1332, 287], [1170, 304, 1553, 1770]),
    ([188, 1193, 62, 563], [1209, 342, 485, 1332]),
    # Right Side wall bands + 2 recessed window panels
    ([1579, 574, 962, 1328], [590, 1085, 1953, 2194]),
    ([1085, 1796, 924, 1953], [1594, 1300, 668, 1250]),
    ([550, 1752, 1859, 1574], [1872, 178, 1362, 924]),
    ([178, 329, 695, 1362], [1496, 661, 201, 641]),
    ([843, 1848, 1391, 1484], [329, 399, 97, 695]),
    # Central rear roof extension & rear central upper wall closure
    ([1933, 1705, 1454, 1807], [1210, 1650, 906, 117]),
    ([783, 393, 1030, 873], [1128, 837, 1673, 1366]),
)


def read_mesh(blob):
    doc, binary = parse_glb(blob)
    if len(doc['meshes']) != 1 or len(doc['meshes'][0]['primitives']) != 1:
        raise ValueError('Expected one triangle primitive')
    primitive = doc['meshes'][0]['primitives'][0]
    if primitive.get('mode', 4) != 4 or set(primitive['attributes']) != {'POSITION'}:
        raise ValueError('Only position-only triangle sources supported')
    def accessor(index):
        a = doc['accessors'][index]
        view = doc['bufferViews'][a['bufferView']]
        if 'byteStride' in view or 'sparse' in a:
            raise ValueError('Unsupported accessor layout')
        width = {'SCALAR': 1, 'VEC3': 3}[a['type']]
        return np.frombuffer(binary, dtype={5125: '<u4', 5123: '<u2', 5126: '<f4'}[a['componentType']],
                             count=a['count'] * width,
                             offset=view.get('byteOffset', 0) + a.get('byteOffset', 0)).copy()
    vertices = accessor(primitive['attributes']['POSITION']).reshape(-1, 3)
    faces = accessor(primitive['indices']).reshape(-1, 3)
    if not np.isfinite(vertices).all() or faces.max() >= len(vertices):
        raise ValueError('Invalid source mesh')
    return vertices, faces


def edge_map(faces):
    edges = defaultdict(list)
    for face in faces:
        for a, b in zip(face, np.roll(face, -1)):
            edges[tuple(sorted((int(a), int(b))))].append((int(a), int(b)))
    return edges


def boundary_loops(faces):
    edges = edge_map(faces)
    if any(len(e) > 2 for e in edges.values()):
        raise ValueError('Nonmanifold source edges')
    boundary = [e[0] for e in edges.values() if len(e) == 1]
    following = {}
    for a, b in boundary:
        if a in following:
            raise ValueError('Branched boundary')
        following[a] = b
    if set(following) != set(following.values()):
        raise ValueError('Open or branched boundary')
    loops = []
    while following:
        start = next(iter(following))
        loop = [start]
        at = following.pop(start)
        while at != start:
            loop.append(at)
            at = following.pop(at)
        loops.append(loop[::-1])  # patches must oppose the existing edge winding
    return loops


def triangulate_loop(vertices, loop, existing_edges=None):
    """Minimum-area triangulation of the existing 3D boundary, no center fan.

    Nonplanar loops stay local; this is not a self-intersection certification.
    """
    n = len(loop)
    if n < 3:
        raise ValueError('Short boundary')
    points = vertices[loop].astype(float)
    existing_edges = existing_edges or {}
    def valid_diagonal(i, j):
        return (abs(i - j) == 1 or {i, j} == {0, n - 1}
                or tuple(sorted((loop[i], loop[j]))) not in existing_edges)
    cost = np.zeros((n, n))
    splits = {}
    for span in range(2, n):
        for i in range(n - span):
            j = i + span
            best = float('inf')
            for k in range(i + 1, j):
                if not all(valid_diagonal(a, b) for a, b in [(i, k), (k, j), (i, j)]):
                    continue
                area = np.linalg.norm(np.cross(points[k] - points[i], points[j] - points[i])) / 2
                # Small tie-breaker favors compact diagonals over needle-shaped spans.
                value = cost[i, k] + cost[k, j] + area + 1e-5 * (
                    np.sum((points[k] - points[i]) ** 2) + np.sum((points[j] - points[k]) ** 2))
                if area > 1e-12 and value < best:
                    best, splits[i, j] = value, k
            cost[i, j] = best
    if not np.isfinite(cost[0, n - 1]):
        raise ValueError('No valid nondegenerate triangulation for boundary')
    triangles = []
    def collect(i, j):
        if j - i < 2:
            return
        k = splits[i, j]
        triangles.append([loop[i], loop[k], loop[j]])
        collect(i, k)
        collect(k, j)
    collect(0, n - 1)
    return triangles


def crease_normals(vertices, faces, angle_degrees=42):
    """Split normal discontinuities without moving a single triangle corner.

    Meshy can share vertices between opposite-facing surfaces. Area-summing
    those normals cancels to zero; Three.js then renders black wedges. Restrict
    smoothing to same-facing neighbors within the architectural crease angle.
    """
    vectors = np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]],
                       vertices[faces[:, 2]] - vertices[faces[:, 0]]).astype(float)
    lengths = np.linalg.norm(vectors, axis=1)
    # Quantized source assets include zero-area faces. Preserve their indices
    # for provenance, but never let them contribute a zero lighting normal.
    unit = vectors / np.maximum(lengths[:, None], 1e-30)
    incident = defaultdict(list)
    for face_id, face in enumerate(faces):
        for vertex in face:
            incident[int(vertex)].append(face_id)
    positions = vertices.tolist()
    normals = [None] * len(vertices)
    new_faces = np.empty_like(faces)
    cosine = np.cos(np.deg2rad(angle_degrees))
    for vertex, ids in incident.items():
        ids = np.array(ids)
        cache = {}
        for face_id in ids:
            reference = unit[face_id] if lengths[face_id] > 1e-15 else unit[ids[np.argmax(lengths[ids])]]
            neighbors = ids[unit[ids] @ reference >= cosine]
            average = vectors[neighbors].sum(axis=0)
            normal = ((average / np.linalg.norm(average)) if np.linalg.norm(average) > 1e-20
                      else np.array([0., 1., 0.])).astype('<f4')
            key = normal.tobytes()
            if key not in cache:
                if normals[vertex] is None:
                    index = vertex
                    normals[vertex] = normal
                else:
                    index = len(positions)
                    positions.append(vertices[vertex].tolist())
                    normals.append(normal)
                cache[key] = index
            new_faces[face_id, np.where(faces[face_id] == vertex)[0][0]] = cache[key]
    if any(n is None for n in normals):
        normals = [np.array([0., 1., 0.], dtype='<f4') if n is None else n for n in normals]
    positions = np.array(positions, dtype='<f4')
    normals = np.array(normals, dtype='<f4')
    if not np.array_equal(positions[new_faces], vertices[faces]):
        raise ValueError('Triangle coordinates changed during normal split')
    return positions, new_faces, normals


def export_mesh(vertices, faces):
    vertices, faces, normals = crease_normals(vertices, faces)
    chunks = [faces.astype('<u4').tobytes(), vertices.astype('<f4').tobytes(), normals.astype('<f4').tobytes()]
    views = []
    offset = 0
    for chunk in chunks:
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(chunk)})
        offset += len(chunk)
    doc = {'asset': {'version': '2.0', 'generator': 'RepoCiv local boundary repair'},
           'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0}],
           'meshes': [{'primitives': [{'attributes': {'POSITION': 1, 'NORMAL': 2}, 'indices': 0, 'mode': 4}]}],
           'buffers': [{'byteLength': offset}], 'bufferViews': views,
           'accessors': [
               {'bufferView': 0, 'componentType': 5125, 'count': int(faces.size), 'type': 'SCALAR'},
               {'bufferView': 1, 'componentType': 5126, 'count': len(vertices), 'type': 'VEC3',
                'min': vertices.min(axis=0).tolist(), 'max': vertices.max(axis=0).tolist()},
               {'bufferView': 2, 'componentType': 5126, 'count': len(vertices), 'type': 'VEC3'}]}
    return build_glb(doc, b''.join(chunks))


def repair_vault_support(vertices, faces):
    """Replace a folded tetrahedral closure by its planar bottom/back faces.

    The four source faces run from the support foot to its upper corner,
    passing through an artificial center point. They are not a stair/ramp:
    adjacent walls define a rectangular support with a horizontal foot.
    """
    expected = np.array([[136, 600, 2098], [136, 2146, 860],
                         [136, 2098, 2146], [860, 2146, 2098]])
    if not np.array_equal(faces[3667:3671], expected):
        raise ValueError('Vault source topology differs from reviewed source')
    bottom = vertices[[136, 600, 860]]
    back = vertices[[860, 600, 2098]]
    if np.ptp(bottom[:, 1]) > 0.0005 or np.ptp(back[:, 2]) > 1e-8:
        raise ValueError('Reviewed support planes no longer match')
    return np.concatenate([np.delete(faces, np.s_[3667:3671], axis=0),
                           np.array([[136, 600, 860], [860, 600, 2098]])])


def repair_workshop_geometry(vertices, faces):
    """Reconstruct missing wall bands, replace window mullions with framed
    recessed panels, and close the central rear roof/wall using only existing
    source vertex coordinates.
    """
    if len(vertices) != 2200 or len(faces) != 3735:
        raise ValueError('Workshop source topology differs from reviewed source')
    adj = defaultdict(set)
    for a, b, c in faces:
        adj[int(a)].update((int(b), int(c)))
        adj[int(b)].update((int(a), int(c)))
        adj[int(c)].update((int(a), int(b)))
    visited = {}
    comp_count = 0
    for start in range(len(vertices)):
        if start in visited or start not in adj:
            continue
        queue = deque([start])
        visited[start] = comp_count
        while queue:
            cur = queue.popleft()
            for nxt in adj[cur]:
                if nxt not in visited:
                    visited[nxt] = comp_count
                    queue.append(nxt)
        comp_count += 1
    if comp_count != 163:
        raise ValueError('Workshop component structure differs from reviewed source')
    keep_mask = np.array([visited[int(tri[0])] not in WORKSHOP_DROP_COMPONENTS for tri in faces])
    kept_faces = faces[keep_mask]
    v_list = vertices.tolist()
    box_tris = []
    for front_quad, back_quad in WORKSHOP_HEXAHEDRA:
        idx = len(v_list)
        for vi in front_quad + back_quad:
            v_list.append(vertices[vi].tolist())
        f0, f1, f2, f3 = idx, idx + 1, idx + 2, idx + 3
        b0, b1, b2, b3 = idx + 4, idx + 5, idx + 6, idx + 7
        box_tris.extend((
            [f0, f1, f2], [f0, f2, f3],
            [b0, b2, b1], [b0, b3, b2],
            [f0, b1, f1], [f0, b0, b1],
            [f3, f2, b2], [f3, b2, b3],
            [b0, f0, f3], [b0, f3, b3],
            [f1, b1, b2], [f1, b2, f2],
        ))
    return (
        np.array(v_list, dtype=vertices.dtype),
        kept_faces,
        np.array(box_tris, dtype=np.uint32),
        int((~keep_mask).sum()),
    )


def repair(asset):
    if asset not in ASSETS:
        raise ValueError('Asset not authorized for repair')
    base = ROOT / 'assets-src/meshy' / asset
    original = (base / 'geometry/preview.glb').read_bytes()
    vertices, faces = read_mesh(original)
    source_triangle_count = len(faces)
    extra_box_tris = np.empty((0, 3), dtype=np.uint32)
    removed_mullion_tris = 0
    if asset == 'artifact-vault':
        if hashlib.sha256(original).hexdigest() != '9bb776287ac7f7adf3074ec82fa02ed44d105696eed2a2efd415e4b7e062342b':
            raise ValueError('Vault source hash changed; re-review required')
        faces = repair_vault_support(vertices, faces)
    elif asset == 'execution-workshop':
        if hashlib.sha256(original).hexdigest() != WORKSHOP_SHA256:
            raise ValueError('Workshop source hash changed; re-review required')
        vertices, faces, extra_box_tris, removed_mullion_tris = repair_workshop_geometry(vertices, faces)
    loops = boundary_loops(faces)
    existing_edges = edge_map(faces)
    patches = [t for loop in loops for t in triangulate_loop(vertices, loop, existing_edges)]
    repaired = np.concatenate([faces, np.array(patches, dtype=np.uint32), extra_box_tris])
    edges = edge_map(repaired)
    assert all(len(e) == 2 and e[0] == e[1][::-1] for e in edges.values())
    out = base / 'repair-v003'
    out.mkdir(exist_ok=True)
    blob = export_mesh(vertices, repaired)
    (out / 'preview.glb').write_bytes(blob)
    report = {'asset': asset, 'source_sha256': hashlib.sha256(original).hexdigest(),
              'output_sha256': hashlib.sha256(blob).hexdigest(), 'source_triangles': source_triangle_count,
              'triangles': len(repaired), 'meshes': 1, 'closed_loops': len(loops),
              'added_boundary_triangles': len(patches),
              'workshop_mullion_and_wafer_triangles_removed': removed_mullion_tris,
              'workshop_hexahedra_triangles_added': len(extra_box_tris),
              'boundary_edges_before': sum(map(len, loops)),
              'boundary_edges_after_before_normal_split': 0, 'source_positions_unchanged': True,
              'original_triangle_coordinates_preserved': asset not in ('artifact-vault', 'execution-workshop'),
              'vault_folded_faces_replaced': 4 if asset == 'artifact-vault' else 0,
              'vault_planar_faces_added': 2 if asset == 'artifact-vault' else 0,
              'crease_angle_degrees': 42, 'normals_split_without_triangle_displacement': True,
              'source_zero_area_faces_retained': int((np.linalg.norm(np.cross(
                  vertices[faces[:, 1]] - vertices[faces[:, 0]],
                  vertices[faces[:, 2]] - vertices[faces[:, 0]]), axis=1) <= 1e-15).sum()),
              'status': 'local repair candidate; visual and human review required',
              'limitations': 'No certification of geometric self-intersections or runtime readiness'}
    (out / 'geometry-audit.json').write_text(json.dumps(report, indent=2) + '\n')
    assert (base / 'geometry/preview.glb').read_bytes() == original
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('asset', choices=ASSETS)
    args = parser.parse_args()
    print(json.dumps(repair(args.asset), indent=2))
