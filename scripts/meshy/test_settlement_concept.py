"""Offline tests for Wave 1 Step 2 settlement concept scope. Never calls Meshy."""
import json
import sys
import unittest
from unittest.mock import patch

import settlement_concept as settlement
import workshop_concept as runner


class SettlementConceptTests(unittest.TestCase):
    def test_all_entrypoints_and_restore(self):
        previous = runner.OUT
        for asset in settlement.ASSETS:
            with self.subTest(asset=asset):

                def check():
                    self.assertEqual(runner.OUT.name, asset)
                    self.assertEqual(sys.argv, ["settlement_concept.py", "--generate"])

                with (
                    patch.object(sys, "argv", ["settlement_concept.py", asset, "--generate"]),
                    patch.object(runner, "main", side_effect=check),
                ):
                    settlement.main()
                self.assertEqual(runner.OUT, previous)

    def test_restore_after_error(self):
        previous = runner.OUT
        with (
            patch.object(sys, "argv", ["settlement_concept.py", settlement.ASSETS[0]]),
            patch.object(runner, "main", side_effect=TimeoutError),
        ):
            with self.assertRaises(TimeoutError):
                settlement.main()
        self.assertEqual(runner.OUT, previous)

    def test_reject_unknown_or_path(self):
        for name in ("../memory-archive", "civic-plaza", "not-authorized"):
            with patch.object(sys, "argv", ["settlement_concept.py", name]), patch.object(
                runner, "main"
            ) as main:
                with self.assertRaises(SystemExit):
                    settlement.main()
                main.assert_not_called()

    def test_specs_are_locked_to_one_nano_banana_pro_concept(self):
        for asset in settlement.ASSETS:
            spec = json.loads((settlement.ROOT / "assets-src/meshy" / asset / "spec.json").read_text())
            self.assertEqual(spec["asset_id"], asset + "-v001")
            self.assertEqual(spec["concept"]["max_create_requests"], 1)
            self.assertEqual(spec["concept"]["advertised_credits"], 9)
            request = spec["concept"]["request_without_reference_paths"]
            self.assertEqual(request["ai_model"], "nano-banana-pro")
            self.assertFalse(request["generate_multi_view"])
            self.assertEqual(request["aspect_ratio"], "1:1")
            self.assertTrue(request["remove_background"])
            self.assertEqual(
                spec["concept"]["reference_relative_paths"],
                ["assets-src/meshy/memory-archive/textured/archive-textured.png"],
            )
            self.assertFalse(spec["guards"]["auto_geometry"])
            self.assertFalse(spec["guards"]["auto_texture"])
            self.assertFalse(spec["guards"]["auto_retry_paid_requests"])
            geometry = spec["geometry_after_concept_approval"]["request_without_input_task_id"]
            self.assertEqual(geometry["ai_model"], "meshy-t2.5")
            self.assertEqual(geometry["model_type"], "smart-topology")
            self.assertEqual(geometry["target_polycount"], 3000)
            self.assertFalse(geometry["should_texture"])
            self.assertFalse(geometry["enable_pbr"])
            self.assertIn("artist-approved", spec["status"])


if __name__ == "__main__":
    unittest.main()
