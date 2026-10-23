"""Plaza uses corrected source, separate geometry state, no mutable global leaks."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import plaza_geometry as plaza
import plaza_correction as correction
import workshop_geometry as runner


class PlazaGeometryTests(unittest.TestCase):
    def test_corrected_source_scope_lock(self):
        previous = runner.ASSET, runner.OUT, runner.SOURCE_ID
        posts = []
        def api(route, payload=None):
            if payload is not None:
                self.assertEqual(payload["input_task_id"], plaza.SOURCE_ID)
                self.assertFalse(payload["should_texture"])
                posts.append(payload)
                return {"result": "offline-only"}
            if route == "/v1/balance":
                return {"balance": 100}
            self.assertEqual(route, "/v1/image-to-image/" + plaza.SOURCE_ID)
            return {"status": "SUCCEEDED", "image_urls": ["https://example.invalid/corrected.png"]}
        with plaza.configured(), tempfile.TemporaryDirectory() as directory:
            self.assertEqual(runner.ASSET, plaza.ASSET / "image-correction")
            self.assertEqual(runner.OUT, plaza.ASSET / "geometry")
            spec = json.loads((runner.ASSET / "spec.json").read_text())
            source = {"task_id": plaza.SOURCE_ID, "status": "SUCCEEDED"}
            runner.create_once(Path(directory), spec, source, api)
            with self.assertRaises(SystemExit):
                runner.create_once(Path(directory), spec, source, api)
        self.assertEqual(len(posts), 1)
        self.assertEqual((runner.ASSET, runner.OUT, runner.SOURCE_ID), previous)

    def test_correction_settings_and_restore(self):
        spec = json.loads((correction.OUT / "spec.json").read_text())
        self.assertFalse(spec["concept"]["request_without_reference_paths"]["remove_background"])
        self.assertEqual(spec["concept"]["reference_relative_paths"], ["assets-src/meshy/civic-plaza/preview.png"])
        old = correction.runner.OUT
        with patch.object(correction.runner, "main", side_effect=RuntimeError("test")):
            with self.assertRaises(RuntimeError):
                correction.main()
        self.assertEqual(correction.runner.OUT, old)


if __name__ == "__main__":
    unittest.main()
