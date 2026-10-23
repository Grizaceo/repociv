"""Offline tests for authorized family scope and per-asset state isolation."""
import json
import sys
import unittest
from unittest.mock import patch

import family_concept as family
import workshop_concept as runner


class FamilyTests(unittest.TestCase):
    def test_all_entrypoints_and_restore(self):
        previous = runner.OUT
        for asset in family.ASSETS:
            with self.subTest(asset=asset):
                def check():
                    self.assertEqual(runner.OUT.name, asset)
                    self.assertEqual(sys.argv, ["family_concept.py", "--generate"])
                with patch.object(sys, "argv", ["family_concept.py", asset, "--generate"]), patch.object(runner, "main", side_effect=check):
                    family.main()
                self.assertEqual(runner.OUT, previous)

    def test_restore_after_error(self):
        previous = runner.OUT
        with patch.object(sys, "argv", ["family_concept.py", family.ASSETS[0]]), patch.object(runner, "main", side_effect=TimeoutError):
            with self.assertRaises(TimeoutError):
                family.main()
        self.assertEqual(runner.OUT, previous)

    def test_reject_unknown_or_path(self):
        for name in ("../observatory", "memory-archive", "not-authorized"):
            with patch.object(sys, "argv", ["family_concept.py", name]), patch.object(runner, "main") as main:
                with self.assertRaises(SystemExit):
                    family.main()
                main.assert_not_called()

    def test_specs(self):
        for asset in family.ASSETS:
            spec = json.loads((family.ROOT / "assets-src/meshy" / asset / "spec.json").read_text())
            self.assertEqual(spec["asset_id"], asset + "-v001")
            self.assertEqual(spec["concept"]["max_create_requests"], 1)
            self.assertEqual(spec["concept"]["advertised_credits"], 9)
            self.assertEqual(spec["concept"]["request_without_reference_paths"]["ai_model"], "nano-banana-pro")
            self.assertFalse(spec["guards"]["auto_geometry"])
            self.assertFalse(spec["guards"]["auto_texture"])


if __name__ == "__main__":
    unittest.main()
