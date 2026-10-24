"""Offline tests for the deterministic knowledge-city unit kit. No network."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "generate-knowledge-city-units.py"
spec = importlib.util.spec_from_file_location("generate_knowledge_city_units", MODULE_PATH)
units = importlib.util.module_from_spec(spec)
spec.loader.exec_module(units)

optimize_path = Path(__file__).with_name("optimize_glb.py")
opt_spec = importlib.util.spec_from_file_location("optimize_glb_units_test", optimize_path)
optimize_glb = importlib.util.module_from_spec(opt_spec)
opt_spec.loader.exec_module(optimize_glb)


class UnitKitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name)
        cls.reports = {row["name"]: row for row in units.generate(cls.out)}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_four_roles_under_budget(self):
        self.assertEqual(set(self.reports), set(units.BUILDERS))
        for name, row in self.reports.items():
            self.assertLessEqual(row["triangles"], units.MAX_TRIANGLES, name)
            self.assertGreater(row["triangles"], 40, name)
            self.assertLess(row["bytes"], 20 * 1024, name)
            self.assertGreaterEqual(row["min"][1], -1e-6, name)

    def test_shared_slots_and_tintable_garment(self):
        expected = ["unit-skin", "unit-garment-tint", "unit-slate", "unit-copper"]
        for name, row in self.reports.items():
            self.assertEqual(row["materials"], expected, name)
            doc, _binary = optimize_glb.parse_glb(Path(row["path"]).read_bytes())
            self.assertEqual(len(doc["meshes"][0]["primitives"]), 4, name)
            self.assertIn("tint", doc["materials"][1]["name"])
            self.assertEqual(doc["asset"]["version"], "2.0")
            attrs = doc["meshes"][0]["primitives"][0]["attributes"]
            self.assertIn("POSITION", attrs)
            self.assertIn("NORMAL", attrs)

    def test_runtime_ids_match_unit_props_roles(self):
        self.assertEqual(
            units.RUNTIME_IDS,
            {
                "unit-coordinator": "unit-mage",
                "unit-builder": "unit-engineer",
                "unit-ranger": "unit-rogue",
                "unit-guardian": "unit-knight",
            },
        )

    def test_does_not_overwrite_phase5_files(self):
        phase5 = ROOT / "public" / "assets" / "3d" / "props" / "units"
        for stem in units.BUILDERS:
            self.assertFalse((phase5 / f"{stem}.glb").exists(), stem)


if __name__ == "__main__":
    unittest.main()
