"""Offline tests for settlement hole patching. Never calls Meshy."""
import unittest

import numpy as np

import settlement_hole_repair as repair
from repair_family_geometry import boundary_loops, edge_map, triangulate_loop


class SettlementHoleRepairTests(unittest.TestCase):
    def test_patch_closes_a_square_hole_without_moving_corners(self):
        vertices = np.array(
            [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
            dtype=np.float32,
        )
        faces = np.array(
            [
                [0, 1, 2], [0, 2, 3], [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
                [0, 3, 7], [0, 7, 4], [3, 2, 6], [3, 6, 7],
            ],
            dtype=np.uint32,
        )
        loops = boundary_loops(faces)
        self.assertEqual(len(loops), 1)
        patches = []
        for loop in loops:
            patches.extend(triangulate_loop(vertices, loop, edge_map(faces)))
        closed = np.concatenate([faces, np.asarray(patches, dtype=faces.dtype)])
        self.assertEqual(boundary_loops(closed), [])

    def test_unknown_asset_rejected(self):
        with self.assertRaises(ValueError):
            repair.repair("city-guild")

    def test_simplify_loop_drops_consecutive_duplicates(self):
        vertices = np.array([[0, 0, 0], [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], dtype=np.float32)
        self.assertEqual(repair.simplify_loop(vertices, [0, 1, 2, 3, 4]), [0, 2, 3, 4])

    def test_real_forum_and_citadel_close(self):
        for asset in repair.ASSETS:
            report = repair.repair(asset)
            self.assertGreater(report["added_triangles"], 0)
            self.assertTrue(report["source_positions_unchanged"])
            verts, faces = repair.read_mesh(
                (repair.ROOT / "assets-src/meshy" / asset / repair.CANDIDATE).read_bytes()
            )
            self.assertEqual(boundary_loops(faces), [])
            orig_v, orig_f = repair.read_mesh(
                (repair.ROOT / "assets-src/meshy" / asset / "geometry/preview.glb").read_bytes()
            )
            self.assertTrue(np.array_equal(verts, orig_v))
            self.assertEqual(len(faces), len(orig_f) + report["added_triangles"])

    def test_citadel_v2_keeps_source_vertices(self):
        report = repair.repair_citadel_v2()
        self.assertTrue(report["source_vertex_prefix"])
        orig_v, orig_f = repair.read_mesh(
            (repair.ROOT / "assets-src/meshy/city-citadel/geometry/preview.glb").read_bytes()
        )
        verts, faces = repair.read_mesh(
            (repair.ROOT / "assets-src/meshy/city-citadel/repair-v003/preview.glb").read_bytes()
        )
        self.assertTrue(np.array_equal(verts[: len(orig_v)], orig_v))
        self.assertGreater(len(faces), len(orig_f))
        self.assertEqual(report["candidate_sha256"], repair.sha256(
            (repair.ROOT / "assets-src/meshy/city-citadel/repair-v003/preview.glb").read_bytes()
        ))


if __name__ == "__main__":
    unittest.main()
