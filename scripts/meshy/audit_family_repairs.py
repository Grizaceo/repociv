"""Read-only integration checks for the locally generated repair-v003 GLBs."""
import hashlib
import json
from pathlib import Path

import numpy as np

from optimize_glb import parse_glb
from repair_family_geometry import ASSETS, ROOT, read_mesh, repair_vault_support


def audit(asset):
    base = ROOT / 'assets-src/meshy' / asset
    original = (base / 'geometry/preview.glb').read_bytes()
    source_vertices, source_faces = read_mesh(original)
    folder = base / 'repair-v003'
    blob = (folder / 'preview.glb').read_bytes()
    report = json.loads((folder / 'geometry-audit.json').read_text())
    assert report['source_sha256'] == hashlib.sha256(original).hexdigest()
    assert report['output_sha256'] == hashlib.sha256(blob).hexdigest()
    doc, binary = parse_glb(blob)
    primitive = doc['meshes'][0]['primitives'][0]
    assert len(doc['meshes']) == 1 and not doc.get('materials') and not doc.get('textures')
    def array(index, dtype, width):
        accessor = doc['accessors'][index]
        view = doc['bufferViews'][accessor['bufferView']]
        return np.frombuffer(binary, dtype=dtype, count=accessor['count'] * width,
                             offset=view.get('byteOffset', 0)).reshape(-1, width)
    vertices = array(primitive['attributes']['POSITION'], '<f4', 3)
    normals = array(primitive['attributes']['NORMAL'], '<f4', 3)
    faces = array(primitive['indices'], '<u4', 1).reshape(-1, 3)
    assert np.isfinite(vertices).all() and np.isfinite(normals).all()
    assert np.allclose(np.linalg.norm(normals, axis=1), 1., atol=1e-6)
    assert int(faces.max()) < len(vertices) and len(faces) == report['triangles']
    expected_faces = repair_vault_support(source_vertices, source_faces) if asset == 'artifact-vault' else source_faces
    assert np.array_equal(vertices[faces[:len(expected_faces)]], source_vertices[expected_faces])
    assert np.array_equal(vertices.min(axis=0), source_vertices.min(axis=0))
    assert np.array_equal(vertices.max(axis=0), source_vertices.max(axis=0))
    # Every exported point comes from an original point; no silhouette expansion.
    original_points = set(map(tuple, source_vertices.tolist()))
    assert all(tuple(v) in original_points for v in vertices.tolist())
    triangle_normals = np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]],
                                vertices[faces[:, 2]] - vertices[faces[:, 0]])
    area = np.linalg.norm(triangle_normals, axis=1)
    nondegenerate = area > 1e-15
    unit = triangle_normals[nondegenerate] / area[nondegenerate, None]
    alignment = (normals[faces[nondegenerate]] * unit[:, None, :]).sum(axis=2)
    assert alignment.min() >= np.cos(np.deg2rad(42)) - 1e-6
    return {'asset': asset, 'triangles': len(faces), 'vertices_after_normal_split': len(vertices),
            'unit_normals': True, 'min_face_corner_normal_alignment': float(alignment.min()),
            'source_sha256_unchanged': True, 'bounds_unchanged': True,
            'original_surfaces_preserved_except_explicit_vault_patch': True,
            'source_zero_area_faces_retained': int((~nondegenerate).sum()),
            'ok': True}


if __name__ == '__main__':
    results = [audit(asset) for asset in ASSETS]
    print(json.dumps(results, indent=2))
