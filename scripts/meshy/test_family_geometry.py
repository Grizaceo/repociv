"""Offline source isolation, bounded requests and uncertain submission safety."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import family_geometry as family
import workshop_geometry as runner


class FamilyGeometryTests(unittest.TestCase):
    def test_all_sources_scope_and_duplicate_lock(self):
        original = runner.ASSET, runner.OUT, runner.SOURCE_ID
        for asset, source_id in family.SOURCES.items():
            posts = []
            def api(route, payload=None):
                if payload is not None:
                    self.assertEqual(route, "/v1/image-to-3d")
                    self.assertEqual(payload["input_task_id"], source_id)
                    self.assertFalse(payload["should_texture"])
                    posts.append(payload)
                    return {"result": "offline-test-task"}
                if route == "/v1/balance":
                    return {"balance": 100}
                self.assertEqual(route, "/v1/image-to-image/" + source_id)
                return {"status": "SUCCEEDED", "image_urls": ["https://example.invalid/a.png"]}
            with family.configured(asset), tempfile.TemporaryDirectory() as directory:
                self.assertEqual(runner.ASSET.name, asset)
                spec = json.loads((runner.ASSET / "spec.json").read_text())
                source = {"task_id": source_id, "status": "SUCCEEDED"}
                runner.create_once(Path(directory), spec, source, api)
                with self.assertRaises(SystemExit):
                    runner.create_once(Path(directory), spec, source, api)
            self.assertEqual(len(posts), 1)
            self.assertEqual((runner.ASSET, runner.OUT, runner.SOURCE_ID), original)

    def test_plaza_blocked(self):
        with self.assertRaises(ValueError), family.configured("civic-plaza"):
            self.fail("Defective source must not reach runner")

    def test_restore_after_failure(self):
        original = runner.ASSET, runner.OUT, runner.SOURCE_ID
        argv = ["family_geometry.py", "connection-gateway", "--generate"]
        with patch.object(family.sys, "argv", argv), patch.object(runner, "main", side_effect=RuntimeError("test")):
            with self.assertRaises(RuntimeError):
                family.main()
            self.assertIs(family.sys.argv, argv)
        self.assertEqual((runner.ASSET, runner.OUT, runner.SOURCE_ID), original)

    def test_uncertain_post_keeps_lock(self):
        with family.configured("coordination-court"), tempfile.TemporaryDirectory() as directory:
            spec = json.loads((runner.ASSET / "spec.json").read_text())
            source = {"task_id": runner.SOURCE_ID, "status": "SUCCEEDED"}
            posts = []
            def api(route, payload=None):
                if payload is not None:
                    posts.append(payload)
                    raise TimeoutError("Uncertain POST")
                if route == "/v1/balance":
                    return {"balance": 100}
                return {"status": "SUCCEEDED", "image_urls": ["https://example.invalid/a.png"]}
            with self.assertRaises(TimeoutError):
                runner.create_once(Path(directory), spec, source, api)
            self.assertTrue((Path(directory) / "submission-lock.json").exists())
            with self.assertRaises(SystemExit):
                runner.create_once(Path(directory), spec, source, api)
            self.assertEqual(len(posts), 1)


if __name__ == "__main__":
    unittest.main()
