"""Offline unit geometry scope: 2000 tris, approved source, no double spend."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import unit_geometry as units
import workshop_geometry as runner


class UnitGeometryTests(unittest.TestCase):
    def test_coordinator_posts_once_at_2000_and_restores(self):
        original = runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT
        posts = []

        def api(route, payload=None):
            if payload is not None:
                self.assertEqual(route, "/v1/image-to-3d")
                self.assertEqual(payload["input_task_id"], units.SOURCES["unit-coordinator"])
                self.assertEqual(payload["target_polycount"], 2000)
                self.assertFalse(payload["should_texture"])
                self.assertFalse(payload["enable_pbr"])
                posts.append(payload)
                return {"result": "offline-unit-task"}
            if route == "/v1/balance":
                return {"balance": 100}
            self.assertEqual(route, "/v1/image-to-image/" + units.SOURCES["unit-coordinator"])
            return {"status": "SUCCEEDED", "image_urls": ["https://example.invalid/a.png"]}

        with units.configured("unit-coordinator"), tempfile.TemporaryDirectory() as directory:
            self.assertEqual(runner.ASSET.name, "unit-coordinator")
            self.assertEqual(runner.TARGET_POLYCOUNT, 2000)
            spec = json.loads((runner.ASSET / "spec.json").read_text())
            source = {"task_id": units.SOURCES["unit-coordinator"], "status": "SUCCEEDED"}
            runner.create_once(Path(directory), spec, source, api)
            with self.assertRaises(SystemExit):
                runner.create_once(Path(directory), spec, source, api)
        self.assertEqual(len(posts), 1)
        self.assertEqual(
            (runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT), original
        )

    def test_builder_v002_uses_revision_folder(self):
        original = runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT
        with units.configured("unit-builder-v002"):
            self.assertEqual(runner.ASSET.name, "concept-v002")
            self.assertEqual(runner.OUT.name, "geometry-v002")
            self.assertEqual(runner.SOURCE_ID, units.SOURCES["unit-builder-v002"])
            self.assertNotEqual(runner.SOURCE_ID, units.SOURCES["unit-builder"])
            self.assertEqual(runner.TARGET_POLYCOUNT, 2000)
        self.assertEqual(
            (runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT), original
        )

    def test_unapproved_or_unknown_blocked(self):
        for name in ("city-dwelling", "not-authorized"):
            with self.assertRaises(ValueError), units.configured(name):
                self.fail(name)

    def test_restore_after_failure(self):
        original = runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT
        argv = ["unit_geometry.py", "unit-coordinator", "--generate"]
        with patch.object(units.sys, "argv", argv), patch.object(
            runner, "main", side_effect=RuntimeError("test")
        ):
            with self.assertRaises(RuntimeError):
                units.main()
            self.assertIs(units.sys.argv, argv)
        self.assertEqual(
            (runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT), original
        )

    def test_uncertain_post_keeps_lock(self):
        with units.configured("unit-coordinator"), tempfile.TemporaryDirectory() as directory:
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
