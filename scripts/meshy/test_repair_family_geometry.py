import unittest
from unittest.mock import patch

import numpy as np

import repair_family_geometry as repair
from optimize_glb import parse_glb


class FamilyRepairTests(unittest.TestCase):
    def test_approved_and_deferred_assets_cannot_be_written(self):
        for asset in ('connection-gateway', 'civic-plaza', 'execution-workshop', '../other'):
            with self.assertRaises(ValueError):
                repair.repair(asset)

    def test_tetrahedron_missing_face_is_closed_with_consistent_winding(self):
        vertices = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]])
        faces = np.array([[0, 2, 1], [0, 1, 3], [0, 3, 2]])
        loops = repair.boundary_loops(faces)
        self.assertEqual(len(loops), 1)
        patches = repair.triangulate_loop(vertices, loops[0], repair.edge_map(faces))
        all_faces = np.concatenate([faces, patches])
        for edges in repair.edge_map(all_faces).values():
            self.assertEqual(len(edges), 2)
            self.assertEqual(edges[0], edges[1][::-1])
        np.testing.assert_array_equal(all_faces[:len(faces)], faces)

    def test_triangulation_avoids_preexisting_internal_diagonal(self):
        vertices = np.array([[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.]])
        patches = repair.triangulate_loop(vertices, [0, 1, 2, 3], {(0, 2): [(0, 2)]})
        self.assertNotIn((0, 2), repair.edge_map(patches))
        self.assertEqual(len(patches), 2)

    def test_branched_boundary_fails_closed(self):
        with self.assertRaises(ValueError):
            repair.boundary_loops(np.array([[0, 1, 2], [0, 3, 4]]))

    def test_nonmanifold_source_fails_closed(self):
        with self.assertRaises(ValueError):
            repair.boundary_loops(np.array([[0, 1, 2], [1, 0, 3], [0, 1, 4]]))

    def test_degenerate_boundary_is_not_silently_accepted(self):
        vertices = np.array([[0., 0., 0.], [1., 0., 0.], [2., 0., 0.]])
        with self.assertRaises(ValueError):
            repair.triangulate_loop(vertices, [0, 1, 2])

    def test_opposite_faces_do_not_cancel_normals(self):
        vertices = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]], dtype=np.float32)
        faces = np.array([[0, 1, 2], [0, 2, 1]])
        positions, indices, normals = repair.crease_normals(vertices, faces)
        np.testing.assert_array_equal(positions[indices], vertices[faces])
        np.testing.assert_allclose(normals[indices[0]], [[0., 0., 1.]] * 3)
        np.testing.assert_allclose(normals[indices[1]], [[0., 0., -1.]] * 3)
        self.assertTrue(np.isfinite(normals).all())
        np.testing.assert_allclose(np.linalg.norm(normals, axis=1), 1.)

    def test_zero_area_source_triangle_does_not_create_zero_normal(self):
        vertices = np.array([[0., 0., 0.], [1., 0., 0.], [2., 0., 0.]], dtype=np.float32)
        _, _, normals = repair.crease_normals(vertices, np.array([[0, 1, 2]]))
        self.assertTrue(np.isfinite(normals).all())
        np.testing.assert_allclose(np.linalg.norm(normals, axis=1), 1.)

    def test_vault_patch_is_bounded_and_source_guarded(self):
        vertices = np.zeros((2147, 3), dtype=np.float32)
        vertices[136] = [-.17211914, -.23559570, .33325195]
        vertices[600] = [-.23364258, -.23510742, .22778320]
        vertices[860] = [-.17211914, -.23559570, .22778320]
        vertices[2098] = [-.23364258, .16235352, .22778320]
        faces = np.zeros((3671, 3), dtype=np.uint32)
        faces[3667:] = [[136, 600, 2098], [136, 2146, 860],
                        [136, 2098, 2146], [860, 2146, 2098]]
        before = faces.copy()
        patched = repair.repair_vault_support(vertices, faces)
        self.assertEqual(len(patched), len(faces) - 2)
        np.testing.assert_array_equal(patched[-2:], [[136, 600, 860], [860, 600, 2098]])
        np.testing.assert_array_equal(faces, before)
        faces[3667, 0] = 42
        with self.assertRaises(ValueError):
            repair.repair_vault_support(vertices, faces)

    def test_export_contains_no_material_mask_or_double_sided_workaround(self):
        vertices = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]], dtype=np.float32)
        doc, binary = parse_glb(repair.export_mesh(vertices, np.array([[0, 1, 2]])))
        self.assertNotIn('materials', doc)
        self.assertNotIn('textures', doc)
        self.assertEqual(len(doc['meshes']), 1)
        self.assertEqual(doc['accessors'][1]['count'], 3)
        self.assertEqual(doc['accessors'][0]['count'], 3)
        self.assertEqual(doc['accessors'][1]['min'], [0., 0., 0.])
        self.assertEqual(doc['accessors'][1]['max'], [1., 1., 0.])
        normals = np.frombuffer(binary, dtype='<f4', count=9, offset=doc['bufferViews'][2]['byteOffset'])
        self.assertTrue(np.isfinite(normals).all())
        np.testing.assert_allclose(normals.reshape(-1, 3), [[0., 0., 1.]] * 3)


if __name__ == '__main__':
    unittest.main()
