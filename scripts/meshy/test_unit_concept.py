"""Offline tests for knowledge-city unit concept scope. Never calls Meshy."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import unit_concept as units
import workshop_concept as runner


class UnitConceptTests(unittest.TestCase):
    def test_all_entrypoints_and_restore(self):
        previous = runner.OUT
        expected_out = {asset: asset for asset in units.ASSETS}
        expected_out["unit-builder-v002"] = "concept-v002"
        for asset, out_name in expected_out.items():
            with self.subTest(asset=asset):

                def check(name=out_name):
                    self.assertEqual(runner.OUT.name, name)
                    self.assertEqual(sys.argv, ["unit_concept.py", "--generate"])

                with (
                    patch.object(sys, "argv", ["unit_concept.py", asset, "--generate"]),
                    patch.object(runner, "main", side_effect=check),
                ):
                    units.main()
                self.assertEqual(runner.OUT, previous)

    def test_restore_after_error(self):
        previous = runner.OUT
        with (
            patch.object(sys, "argv", ["unit_concept.py", units.ASSETS[0]]),
            patch.object(runner, "main", side_effect=TimeoutError),
        ):
            with self.assertRaises(TimeoutError):
                units.main()
        self.assertEqual(runner.OUT, previous)

    def test_reject_unknown_or_path(self):
        for name in ("../memory-archive", "city-dwelling", "not-authorized"):
            with patch.object(sys, "argv", ["unit_concept.py", name]), patch.object(
                runner, "main"
            ) as main:
                with self.assertRaises(SystemExit):
                    units.main()
                main.assert_not_called()

    def test_specs_are_locked_to_one_nano_banana_pro_concept(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(units, "ROOT", Path(directory)):
                units.write_specs()
            for asset in units.ASSETS:
                spec = json.loads((Path(directory) / "assets-src/meshy" / asset / "spec.json").read_text())
                self.assertEqual(spec["asset_id"], asset + "-v001")
                self.assertEqual(spec["concept"]["max_create_requests"], 1)
                self.assertEqual(spec["concept"]["advertised_credits"], 9)
                request = spec["concept"]["request_without_reference_paths"]
                self.assertEqual(request["ai_model"], "nano-banana-pro")
                self.assertFalse(request["generate_multi_view"])
                self.assertEqual(request["aspect_ratio"], "1:1")
                self.assertTrue(request["remove_background"])
                self.assertTrue(request["prompt"].startswith(units.PREFIX))
                self.assertIn(units.ROLES[asset][:24], request["prompt"])
                self.assertFalse(spec["guards"]["auto_geometry"])
                self.assertFalse(spec["guards"]["auto_texture"])
                self.assertFalse(spec["guards"]["auto_retry_paid_requests"])
                geometry = spec["geometry_after_concept_approval"]["request_without_input_task_id"]
                self.assertEqual(geometry["ai_model"], "meshy-t2.5")
                self.assertEqual(geometry["model_type"], "smart-topology")
                self.assertEqual(geometry["target_polycount"], 2000)
                self.assertFalse(geometry["should_texture"])
                self.assertIn("horribles", spec["authorization"])
            revision = json.loads(
                (Path(directory) / "assets-src/meshy/unit-builder/concept-v002/spec.json").read_text()
            )
            self.assertEqual(revision["asset_id"], "unit-builder-v002")
            self.assertEqual(revision["parent_asset"], "unit-builder-v001")
            self.assertEqual(revision["concept"]["max_create_requests"], 1)
            self.assertEqual(revision["concept"]["advertised_credits"], 9)
            request = revision["concept"]["request_without_reference_paths"]
            self.assertEqual(request["ai_model"], "nano-banana-pro")
            self.assertTrue(request["prompt"].startswith(units.PREFIX))
            self.assertIn(units.BUILDER_V002_ROLE[:24], request["prompt"])
            self.assertIn("no backpack", request["prompt"])
            self.assertIn("no satchel", request["prompt"])
            self.assertIn("hammer", request["prompt"])
            self.assertFalse(revision["guards"]["auto_geometry"])
            self.assertFalse(revision["guards"]["auto_texture"])
            self.assertFalse(revision["guards"]["auto_retry_paid_requests"])


if __name__ == "__main__":
    unittest.main()
