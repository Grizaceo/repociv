"""Offline authorized geometry scope and anti-double-spend checks."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

import workshop_geometry as geometry


class GeometryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name)
        self.spec = json.loads((geometry.ASSET / "spec.json").read_text())
        self.source = {"task_id": geometry.SOURCE_ID, "status": "SUCCEEDED"}
        self.api = Mock(side_effect=[{"status": "SUCCEEDED", "image_urls": ["https://fixture.invalid/concept"]},
            {"balance": 1076}, {"result": "fixture-task"}])

    def run_create(self, spec=None, source=None):
        return geometry.create_once(self.out, spec or self.spec, source or self.source, self.api)

    def test_one_post_only_untextured_source_persisted(self):
        state = self.run_create()
        self.assertEqual(self.api.call_count, 3)
        route, request = self.api.call_args.args
        self.assertEqual(route, "/v1/image-to-3d")
        self.assertFalse(request["should_texture"])
        self.assertFalse(request["enable_pbr"])
        self.assertEqual(request["input_task_id"], geometry.SOURCE_ID)
        self.assertNotIn("response_format", request)
        self.assertEqual(json.loads((self.out / "generation.json").read_text()), state)

    def test_existing_marker_blocks_post(self):
        (self.out / "submission-lock.json").write_text("{}")
        with self.assertRaises(SystemExit):
            self.run_create()
        self.assertEqual(self.api.call_count, 2)

    def test_timeout_keeps_marker_never_retries(self):
        self.api.side_effect = [{"status": "SUCCEEDED", "image_urls": ["https://fixture.invalid"]},
            {"balance": 1076}, TimeoutError()]
        with self.assertRaises(TimeoutError):
            self.run_create()
        self.assertTrue((self.out / "submission-lock.json").exists())
        self.assertFalse((self.out / "generation.json").exists())
        self.assertEqual(self.api.call_count, 3)

    def test_scope_drift_rejected_before_api(self):
        for field, value in [("should_texture", True), ("ai_model", "latest"),
                ("target_polycount", 30000)]:
            spec = copy.deepcopy(self.spec)
            spec["geometry_after_concept_approval"]["request_without_input_task_id"][field] = value
            with self.assertRaises(ValueError):
                self.run_create(spec=spec)
        self.api.assert_not_called()

    def test_wrong_source_rejected_before_api(self):
        with self.assertRaises(ValueError):
            self.run_create(source={"task_id": "other", "status": "SUCCEEDED"})
        self.api.assert_not_called()

    def test_live_source_must_have_one_image(self):
        self.api.side_effect = [{"status": "SUCCEEDED", "image_urls": []}]
        with self.assertRaises(ValueError):
            self.run_create()
        self.assertEqual(self.api.call_count, 1)

    def test_insufficient_balance_blocks_post(self):
        self.api.side_effect = [{"status": "SUCCEEDED", "image_urls": ["https://fixture.invalid"]},
            {"balance": 4}]
        with self.assertRaises(ValueError):
            self.run_create()
        self.assertEqual(self.api.call_count, 2)
        self.assertFalse((self.out / "submission-lock.json").exists())


if __name__ == "__main__":
    unittest.main()
