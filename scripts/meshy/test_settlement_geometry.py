"""Offline settlement geometry scope: 3000 tris, approved source, no double spend."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import settlement_geometry as settlement
import workshop_geometry as runner


class SettlementGeometryTests(unittest.TestCase):
    def test_dwelling_posts_once_at_3000_and_restores(self):
        original = runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT
        posts = []

        def api(route, payload=None):
            if payload is not None:
                self.assertEqual(route, "/v1/image-to-3d")
                self.assertEqual(payload["input_task_id"], settlement.SOURCES["city-dwelling"])
                self.assertEqual(payload["target_polycount"], 3000)
                self.assertFalse(payload["should_texture"])
                self.assertFalse(payload["enable_pbr"])
                posts.append(payload)
                return {"result": "offline-settlement-task"}
            if route == "/v1/balance":
                return {"balance": 100}
            self.assertEqual(route, "/v1/image-to-image/" + settlement.SOURCES["city-dwelling"])
            return {"status": "SUCCEEDED", "image_urls": ["https://example.invalid/a.png"]}

        with settlement.configured("city-dwelling"), tempfile.TemporaryDirectory() as directory:
            self.assertEqual(runner.ASSET.name, "city-dwelling")
            self.assertEqual(runner.TARGET_POLYCOUNT, 3000)
            spec = json.loads((runner.ASSET / "spec.json").read_text())
            source = {"task_id": settlement.SOURCES["city-dwelling"], "status": "SUCCEEDED"}
            runner.create_once(Path(directory), spec, source, api)
            with self.assertRaises(SystemExit):
                runner.create_once(Path(directory), spec, source, api)
        self.assertEqual(len(posts), 1)
        self.assertEqual(
            (runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT), original
        )

    def test_unapproved_or_unknown_blocked(self):
        for name in ("civic-plaza", "not-authorized"):
            with self.assertRaises(ValueError), settlement.configured(name):
                self.fail(name)

    def test_restore_after_failure(self):
        original = runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT
        argv = ["settlement_geometry.py", "city-dwelling", "--generate"]
        with patch.object(settlement.sys, "argv", argv), patch.object(
            runner, "main", side_effect=RuntimeError("test")
        ):
            with self.assertRaises(RuntimeError):
                settlement.main()
            self.assertIs(settlement.sys.argv, argv)
        self.assertEqual(
            (runner.ASSET, runner.OUT, runner.SOURCE_ID, runner.TARGET_POLYCOUNT), original
        )

    def test_uncertain_post_keeps_lock(self):
        with settlement.configured("city-dwelling"), tempfile.TemporaryDirectory() as directory:
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
