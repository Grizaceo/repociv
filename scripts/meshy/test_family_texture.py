"""Offline retexture scope, source pinning, duplicate locks and geometry-preserving assembly."""
import base64
import copy
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

import family_texture as ft
from repair_family_geometry import crease_normals


def fake_uv_copy(asset, root):
    """Stand-in for `prepare` without xatlas: accepted corners, prepared normals, dummy UVs."""
    spec = json.loads((root / asset / "spec.json").read_text())
    path, digest = ft.accepted_source(asset, spec)
    _, _, attributes, faces, _ = ft.read_mesh(path.read_bytes())
    if asset in ft.REPAIRED:
        position, normal = attributes["POSITION"], attributes["NORMAL"]
    else:
        position, faces, normal = crease_normals(attributes["POSITION"], faces)
    corners = faces.reshape(-1)
    uv = np.stack([np.linspace(0, 1, len(corners)), np.zeros(len(corners))], 1).astype(np.float32)
    blob = ft.glb_from_arrays(position[corners], normal[corners], uv, np.arange(len(corners)).reshape(-1, 3))
    folder = root / asset / ft.OUT_NAME
    folder.mkdir(exist_ok=True)
    (folder / "source-uv.glb").write_bytes(blob)
    check = ft.verify_against_source(path.read_bytes(), blob)
    ft.save(folder / "uv-audit.json", {"accepted_sha256": digest, "output_sha256": ft.sha256(blob),
                                       "preservation": check})
    return spec, blob


class FamilyTextureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for asset in ft.ASSETS:
            spec = json.loads((ft.MESHY / asset / "spec.json").read_text())
            source = spec["texturing_after_geometry_approval"]["source"]["accepted_geometry"]
            (self.root / asset / Path(source).parent).mkdir(parents=True)
            shutil.copy(ft.MESHY / asset / "spec.json", self.root / asset / "spec.json")
            shutil.copy(ft.MESHY / asset / source, self.root / asset / source)
        self.patch = patch.object(ft, "MESHY", self.root)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def api_factory(self, posts, balance=570, fail=None):
        def api(route, payload=None):
            if payload is not None:
                self.assertEqual(route, "/v1/retexture")
                posts.append(payload)
                if fail:
                    raise fail
                return {"result": "01a16799-0000-7000-8000-000000000001"}
            self.assertEqual(route, "/v1/balance")
            return {"balance": balance}
        return api

    def test_only_the_five_members(self):
        for asset in ("observatory", "memory-archive", "../observatory"):
            with self.assertRaises(ValueError):
                ft.asset_dir(asset)
        self.assertEqual(set(ft.ASSETS), {"coordination-court", "artifact-vault", "research-laboratory",
                                          "execution-workshop", "connection-gateway", "civic-plaza"})

    def test_sources_are_the_approved_files(self):
        for asset in ft.ASSETS:
            spec = json.loads((self.root / asset / "spec.json").read_text())
            path, digest = ft.accepted_source(asset, spec)
            self.assertEqual(ft.sha256(path.read_bytes()), digest)
            if asset in ft.REPAIRED:
                self.assertEqual(path.relative_to(self.root / asset).as_posix(), "repair-v003/preview.glb")
                self.assertEqual(digest, spec["local_repair"]["approved_sha256"])
            else:
                self.assertEqual(path.relative_to(self.root / asset).as_posix(), "geometry/preview.glb")
            wrong = copy.deepcopy(spec)
            wrong["texturing_after_geometry_approval"]["source"]["accepted_geometry"] = "repair-v002/preview.glb"
            with self.assertRaises(ValueError):
                ft.accepted_source(asset, wrong)

    def test_exact_scope_and_single_post(self):
        for asset in ft.ASSETS:
            spec, blob = fake_uv_copy(asset, self.root)
            for field, value in (("texture_resolution", "8k"), ("ai_model", "latest"),
                                 ("enable_original_uv", False), ("input_task_id", "x")):
                wrong = copy.deepcopy(spec)
                wrong["texturing_after_geometry_approval"]["request"][field] = value
                with self.assertRaises(ValueError):
                    ft.build_request(asset, wrong, self.root / asset / ft.OUT_NAME)
            long = copy.deepcopy(spec)
            long["texturing_after_geometry_approval"]["request"]["text_style_prompt"] = "x" * 801
            with self.assertRaises(ValueError):
                ft.build_request(asset, long, self.root / asset / ft.OUT_NAME)
            posts = []
            with self.assertRaises(ValueError):
                ft.create_once(asset, spec, self.api_factory(posts, balance=9))
            self.assertFalse((self.root / asset / ft.OUT_NAME / "retexture-submission-lock.json").exists())
            ft.create_once(asset, spec, self.api_factory(posts))
            with self.assertRaises(SystemExit):
                ft.create_once(asset, spec, self.api_factory(posts))
            self.assertEqual(len(posts), 1)
            payload = posts[0]
            self.assertTrue(payload["enable_original_uv"])
            self.assertNotIn("input_task_id", payload)
            prefix = "data:application/octet-stream;base64,"
            self.assertEqual(base64.b64decode(payload["model_url"][len(prefix):]), blob)
            lock = (self.root / asset / ft.OUT_NAME / "retexture-submission-lock.json").read_text()
            self.assertNotIn("base64", lock)
            state = json.loads((self.root / asset / ft.OUT_NAME / "generation.json").read_text())
            self.assertEqual(state["source"]["model_url_sha256"], ft.sha256(blob))

    def test_tampered_uv_copy_is_refused(self):
        asset = "artifact-vault"
        spec, blob = fake_uv_copy(asset, self.root)
        _, _, a, f, _ = ft.read_mesh(blob)
        moved = a["POSITION"].copy()
        moved[0, 1] += 0.01
        bad = ft.glb_from_arrays(moved, a["NORMAL"], a["TEXCOORD_0"], f)
        folder = self.root / asset / ft.OUT_NAME
        (folder / "source-uv.glb").write_bytes(bad)
        audit = json.loads((folder / "uv-audit.json").read_text())
        audit["output_sha256"] = ft.sha256(bad)
        ft.save(folder / "uv-audit.json", audit)
        with self.assertRaises(ValueError):
            ft.build_request(asset, spec, folder)

    def test_uncertain_post_keeps_lock(self):
        asset = "civic-plaza"
        spec, _ = fake_uv_copy(asset, self.root)
        posts = []
        with self.assertRaises(TimeoutError):
            ft.create_once(asset, spec, self.api_factory(posts, fail=TimeoutError("uncertain")))
        folder = self.root / asset / ft.OUT_NAME
        self.assertTrue((folder / "retexture-submission-lock.json").exists())
        self.assertFalse((folder / "generation.json").exists())
        with self.assertRaises(SystemExit):
            ft.create_once(asset, spec, self.api_factory(posts))
        self.assertEqual(len(posts), 1)

    def meshy_like(self, blob, drop=None, scale=2.0):
        """Shuffle/rotate triangles, rescale, re-UV and add one textured material."""
        _, _, a, f, _ = ft.read_mesh(blob)
        rng = np.random.default_rng(7)
        order = rng.permutation(len(f))
        if drop is not None:
            order = order[order != drop]
        tri = np.roll(f[order], 1, axis=1)
        corners = tri.reshape(-1)
        center = (a["POSITION"].min(0) + a["POSITION"].max(0)) / 2
        position = ((a["POSITION"][corners] - center) * scale).astype(np.float32)
        uv = rng.random((len(corners), 2)).astype(np.float32)
        buffer = io.BytesIO()
        Image.new("RGB", (4, 4), (200, 180, 150)).save(buffer, "PNG")
        extra = {"images": [("image/png", buffer.getvalue())], "textures": [{"source": 0}], "samplers": [],
                 "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}, "doubleSided": True}]}
        meshy = ft.glb_from_arrays(position, -a["NORMAL"][corners], uv, np.arange(len(corners)).reshape(-1, 3), extra)
        return meshy, order, uv

    def test_assemble_keeps_accepted_corners_and_normals(self):
        for asset in ("coordination-court", "connection-gateway"):
            spec, blob = fake_uv_copy(asset, self.root)
            meshy, order, uv = self.meshy_like(blob)
            folder = self.root / asset / ft.OUT_NAME
            (folder / "meshy.glb").write_bytes(meshy)
            report = ft.assemble(asset, spec)
            self.assertTrue(report["accepted_geometry_check"]["exact"])
            self.assertFalse(report["meshy_used_supplied_uvs"])
            _, _, out, out_faces, _ = ft.read_mesh((folder / "textured.glb").read_bytes())
            _, _, src, src_faces, _ = ft.read_mesh(blob)
            np.testing.assert_array_equal(out["NORMAL"][out_faces], src["NORMAL"][src_faces])
            first = int(order[0])
            got = out["TEXCOORD_0"][out_faces[first]]
            expected = np.roll(uv[:3].reshape(3, 2), -1, axis=0)
            np.testing.assert_allclose(got, expected, atol=1e-7)
            doc, _ = ft.parse_glb((folder / "textured.glb").read_bytes())
            self.assertEqual(doc["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"], {"index": 0})

    def test_assemble_refuses_dropped_visible_triangle(self):
        asset = "research-laboratory"
        spec, blob = fake_uv_copy(asset, self.root)
        _, _, a, f, _ = ft.read_mesh(blob)
        areas = ft.triangle_areas(a["POSITION"][f].astype(np.float64))
        meshy, _, _ = self.meshy_like(blob, drop=int(areas.argmax()))
        (self.root / asset / ft.OUT_NAME / "meshy.glb").write_bytes(meshy)
        with self.assertRaises(SystemExit):
            ft.assemble(asset, spec)
        self.assertFalse((self.root / asset / ft.OUT_NAME / "textured.glb").exists())

    def test_verify_detects_moved_corner(self):
        asset = "coordination-court"
        spec, blob = fake_uv_copy(asset, self.root)
        _, _, a, f, _ = ft.read_mesh(blob)
        moved = a["POSITION"].copy()
        moved[5] += 0.02
        result = ft.verify_against_source(blob, ft.glb_from_arrays(moved, a["NORMAL"], a["TEXCOORD_0"], f))
        self.assertFalse(result["exact"])
        self.assertGreater(result["unmatched_candidate_triangles"], 0)


if __name__ == "__main__":
    unittest.main()
