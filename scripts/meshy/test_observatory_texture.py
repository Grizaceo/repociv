"""Offline Observatory texture authorization, scope and duplicate checks."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import observatory_texture as tex


class ObservatoryTextureTests(unittest.TestCase):
    def test_exact_scope_source_geometry_and_lock(self):
        spec = json.loads((tex.ASSET / "spec.json").read_text())
        config = spec["texturing_after_geometry_approval"]
        self.assertEqual(config["advertised_credits"], 10)
        self.assertEqual(config["max_create_requests"], 1)
        request = config["request"]
        self.assertEqual(request["ai_model"], "meshy-7")
        self.assertEqual(request["input_task_id"], tex.SOURCE_ID)
        self.assertTrue(request["enable_pbr"])
        self.assertEqual(request["texture_resolution"], "2k")
        self.assertFalse(spec["guards"]["auto_texture"])
        self.assertEqual(tex.SOURCE_ID, "01a165f2-17f0-76cc-83ab-4fc6d267e41e")
        self.assertFalse(request["enable_original_uv"])
        posts = []

        def api(route, payload=None):
            if payload is not None:
                self.assertEqual(route, "/v1/retexture")
                self.assertEqual(payload["ai_model"], "meshy-7")
                self.assertEqual(payload["input_task_id"], tex.SOURCE_ID)
                posts.append(payload)
                return {"result": "offline-texture-id"}
            if route == "/v1/balance":
                return {"balance": 1057}
            self.assertEqual(route, "/v1/image-to-3d/" + tex.SOURCE_ID)
            return {"status": "SUCCEEDED"}

        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            wrong = copy.deepcopy(spec)
            wrong["texturing_after_geometry_approval"]["request"]["texture_resolution"] = "8k"
            with self.assertRaises(ValueError):
                tex.create_once(out, wrong, api)
            with self.assertRaises(ValueError):
                tex.create_once(out, spec,
                    lambda route, payload=None: {"balance": 3} if payload is None and
                    route == "/v1/balance" else api(route, payload))
            tex.create_once(out, spec, api)
            with self.assertRaises(SystemExit):
                tex.create_once(out, spec, api)
        self.assertEqual(len(posts), 1)
        self.assertNotIn("8k", json.dumps(posts))


if __name__ == "__main__":
    unittest.main()
