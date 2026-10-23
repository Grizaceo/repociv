"""Offline scope and anti-double-spend checks; no network calls."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import coordination_concept as court
import workshop_concept as runner


class CoordinationTests(unittest.TestCase):
    def test_entrypoint_isolation_and_restoration(self):
        previous = runner.OUT
        with patch.object(runner, "main") as main:
            court.main()
            main.assert_called_once_with()
        self.assertEqual(runner.OUT, previous)
        self.assertEqual(court.OUT.name, "coordination-court")

    def test_exact_request_and_duplicate_block(self):
        spec = json.loads((court.OUT / "spec.json").read_text())
        calls = []

        def api(route, payload=None):
            calls.append((route, payload))
            if payload is None:
                self.assertEqual(route, "/v1/balance")
                return {"balance": 1000}
            self.assertEqual(route, "/v1/image-to-image")
            self.assertEqual(payload["ai_model"], "nano-banana-pro")
            self.assertIn("Coordination Court", payload["prompt"])
            self.assertFalse(payload["generate_multi_view"])
            self.assertTrue(payload["remove_background"])
            self.assertEqual(len(payload["reference_image_urls"]), 1)
            return {"result": "offline-court-task"}

        with tempfile.TemporaryDirectory() as name:
            out = Path(name)
            result = runner.create_once(out, spec, api)
            self.assertEqual(result["task_id"], "offline-court-task")
            self.assertNotIn("data:image", (out / "generation.json").read_text())
            with self.assertRaises(SystemExit):
                runner.create_once(out, spec, api)
        self.assertEqual(sum(payload is not None for _, payload in calls), 1)
        self.assertFalse(spec["guards"]["auto_geometry"])
        self.assertFalse(spec["guards"]["auto_texture"])

    def test_ambiguous_post_keeps_lock(self):
        spec = json.loads((court.OUT / "spec.json").read_text())
        posts = []

        def api(route, payload=None):
            if payload is None:
                return {"balance": 1000}
            posts.append(route)
            raise TimeoutError("offline uncertain outcome")

        with tempfile.TemporaryDirectory() as name:
            out = Path(name)
            with self.assertRaises(TimeoutError):
                runner.create_once(out, spec, api)
            self.assertTrue((out / "submission-lock.json").exists())
            with self.assertRaises(SystemExit):
                runner.create_once(out, spec, api)
        self.assertEqual(len(posts), 1)


if __name__ == "__main__":
    unittest.main()
