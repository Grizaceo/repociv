"""Deterministic local boundary/normal repair for three Meshy clay meshes.

Never move source triangle corners. Add wound boundary patches, split lighting
normals at creases, and explicitly replace one folded vault support closure.
Originals and approved/deferred assets are read-only. No paid API, remeshing,
global hull, or double-sided material workaround.
"""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path

import numpy as np
from optimize_glb import parse_glb, build_glb

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ('coordination-court', 'artifact-vault', 'research-laboratory')


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


def repair(asset):
    if asset not in ASSETS:
        raise ValueError('Asset not authorized for repair')
    base = ROOT / 'assets-src/meshy' / asset
    original = (base / 'geometry/preview.glb').read_bytes()
    vertices, faces = read_mesh(original)
    source_triangle_count = len(faces)
    if asset == 'artifact-vault':
        if hashlib.sha256(original).hexdigest() != '9bb776287ac7f7adf3074ec82fa02ed44d105696eed2a2efd415e4b7e062342b':
            raise ValueError('Vault source hash changed; re-review required')
        faces = repair_vault_support(vertices, faces)
    loops = boundary_loops(faces)
    existing_edges = edge_map(faces)
    patches = [t for loop in loops for t in triangulate_loop(vertices, loop, existing_edges)]
    repaired = np.concatenate([faces, np.array(patches, dtype=np.uint32)])
    edges = edge_map(repaired)
    assert all(len(e) == 2 and e[0] == e[1][::-1] for e in edges.values())
    out = base / 'repair-v003'
    out.mkdir(exist_ok=True)
    blob = export_mesh(vertices, repaired)
    (out / 'preview.glb').write_bytes(blob)
    report = {'asset': asset, 'source_sha256': hashlib.sha256(original).hexdigest(),
              'output_sha256': hashlib.sha256(blob).hexdigest(), 'source_triangles': source_triangle_count,
              'triangles': len(repaired), 'meshes': 1, 'closed_loops': len(loops),
              'added_boundary_triangles': len(patches), 'boundary_edges_before': sum(map(len, loops)),
              'boundary_edges_after_before_normal_split': 0, 'source_positions_unchanged': True,
              'original_triangle_coordinates_preserved': asset != 'artifact-vault',
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
