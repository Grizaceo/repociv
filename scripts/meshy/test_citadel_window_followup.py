"""Offline tests for the citadel left-elevation window follow-up. Never calls Meshy."""
import unittest

import numpy as np

import citadel_window_followup as follow
from repair_family_geometry import read_mesh
from settlement_hole_repair import sha256


class CitadelWindowFollowupTests(unittest.TestCase):
    def test_v003_has_a_simple_middle_left_loop(self):
        vertices, faces = read_mesh(follow.V003.read_bytes())
        loop = follow.leftover_middle_left_loop(vertices, faces)
        self.assertEqual(len(loop), 16)
        self.assertTrue(np.allclose(vertices[loop][:, 0], follow.LEFT_X, atol=0.03))

    def test_textured_loop_maps_one_to_one_onto_clay_positions(self):
        from family_texture import read_mesh as read_textured

        clay_v, clay_f = read_mesh(follow.V003.read_bytes())
        loop = follow.leftover_middle_left_loop(clay_v, clay_f)
        _, _, attr, tex_f, _ = read_textured(follow.TEXTURED.read_bytes())
        mapped = follow.map_clay_loop_to_textured(clay_v, clay_f, attr["POSITION"], tex_f, loop)
        self.assertEqual(len(mapped), 16)
        self.assertEqual(len(set(mapped)), 16)
        self.assertTrue(np.allclose(attr["POSITION"][mapped], clay_v[loop], atol=1e-5))

    def test_followup_caps_the_loop_and_keeps_v003_bytes(self):
        v003 = follow.V003.read_bytes()
        report = follow.followup()
        self.assertEqual(report["middle_left_leftover_after"], 0)
        self.assertGreater(report["added_triangles"], 0)
        self.assertGreaterEqual(report["ground_panel_triangles"], 2)
        self.assertGreater(report["textured_added_triangles"], 0)
        self.assertEqual(sha256(follow.V003.read_bytes()), sha256(v003))
        verts, faces = read_mesh((follow.V004_DIR / "preview.glb").read_bytes())
        orig_v, orig_f = read_mesh(v003)
        self.assertTrue(np.array_equal(verts, orig_v))
        self.assertEqual(len(faces), len(orig_f) + report["added_triangles"])
        self.assertEqual(follow.leftover_middle_left_loop(verts, faces), [])
        self.assertTrue(follow.PUBLIC.exists())
        self.assertEqual(report["runtime_sha256"], sha256(follow.PUBLIC.read_bytes()))
        self.assertEqual(report["new_paid_requests"], 0)


if __name__ == "__main__":
    unittest.main()
