"""Offline anti-double-spend tests; never calls Meshy."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import workshop_concept as concept


class ConceptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name)
        (self.out / "reference.png").write_bytes(b"\x89PNG\r\n\x1a\nfixture")
        self.spec = {"concept": {"max_create_requests": 1, "advertised_credits": 9,
            "reference_relative_paths": ["reference.png"],
            "request_without_reference_paths": {"ai_model": "nano-banana-pro",
                "prompt": "workshop", "response_format": "json"}}}
        self.api = Mock(side_effect=[{"balance": 1085}, {"result": "task-fixture"}])

    def call(self, spec=None):
        with patch.object(concept, "ROOT", self.out):
            return concept.create_once(self.out, spec or self.spec, self.api)

    def test_one_post_persists_task_without_image_data(self):
        result = self.call()
        self.assertEqual(result["task_id"], "task-fixture")
        self.assertEqual(self.api.call_count, 2)
        self.assertNotIn("response_format", self.api.call_args.args[1])
        self.assertNotIn("base64", (self.out / "generation.json").read_text())
        self.assertNotIn("base64", (self.out / "submission-lock.json").read_text())
        self.assertEqual(json.loads((self.out / "generation.json").read_text()), result)

    def test_existing_lock_prevents_post(self):
        (self.out / "submission-lock.json").write_text("{}")
        with self.assertRaises(SystemExit):
            self.call()
        self.assertEqual(self.api.call_count, 1)

    def test_ambiguous_post_keeps_lock_no_retry(self):
        self.api.side_effect = [{"balance": 1085}, TimeoutError()]
        with self.assertRaises(TimeoutError):
            self.call()
        self.assertTrue((self.out / "submission-lock.json").exists())
        self.assertFalse((self.out / "generation.json").exists())
        self.assertEqual(self.api.call_count, 2)

    def test_unapproved_model_or_budget_rejected_before_api(self):
        for name, value in [("advertised_credits", 12), ("max_create_requests", 2)]:
            spec = copy.deepcopy(self.spec)
            spec["concept"][name] = value
            with self.assertRaises(ValueError):
                self.call(spec)
        self.api.assert_not_called()

    def test_insufficient_balance_never_posts(self):
        self.api.side_effect = [{"balance": 8}]
        with self.assertRaises(ValueError):
            self.call()
        self.assertEqual(self.api.call_count, 1)
        self.assertFalse((self.out / "submission-lock.json").exists())


if __name__ == "__main__":
    unittest.main()
