"""Offline Observatory source, paid scope and duplicate submission checks."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import observatory_geometry as obs
import workshop_geometry as runner


class ObservatoryGeometryTests(unittest.TestCase):
    def test_scope_source_and_lock(self):
        spec = json.loads((obs.ASSET / "spec.json").read_text())
        source = {"task_id": obs.SOURCE_ID, "status": "SUCCEEDED"}
        posts = []

        def api(route, payload=None):
            if payload is not None:
                self.assertEqual(route, "/v1/image-to-3d")
                self.assertEqual(payload["input_task_id"], obs.SOURCE_ID)
                self.assertFalse(payload["should_texture"])
                self.assertFalse(payload["enable_pbr"])
                self.assertEqual(payload["target_formats"], ["glb"])
                posts.append(payload)
                return {"result": "offline-geometry-id"}
            if route == "/v1/balance":
                return {"balance": 1062}
            self.assertEqual(route, "/v1/image-to-image/" + obs.SOURCE_ID)
            return {"status": "SUCCEEDED", "image_urls": ["https://example.invalid/source.png"]}

        old = runner.SOURCE_ID
        with obs.configured(), tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            wrong = copy.deepcopy(spec)
            wrong["geometry_after_concept_approval"]["request_without_input_task_id"]["should_texture"] = True
            with self.assertRaises(ValueError):
                runner.create_once(out, wrong, source, api)
            with self.assertRaises(ValueError):
                runner.create_once(out, spec, {"task_id": old, "status": "SUCCEEDED"}, api)
            runner.create_once(out, spec, source, api)
            with self.assertRaises(SystemExit):
                runner.create_once(out, spec, source, api)
            self.assertTrue((out / "generation.json").exists())
        self.assertEqual(len(posts), 1)
        self.assertEqual(runner.SOURCE_ID, old)


if __name__ == "__main__":
    unittest.main()
