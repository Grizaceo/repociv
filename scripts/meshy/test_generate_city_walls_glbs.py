"""Offline tests for the deterministic knowledge-city wall kit. No network."""
import hashlib
import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "generate-city-walls-glbs.py"
spec = importlib.util.spec_from_file_location("generate_city_walls_glbs", MODULE_PATH)
walls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(walls)

optimize_path = Path(__file__).with_name("optimize_glb.py")
opt_spec = importlib.util.spec_from_file_location("optimize_glb_walls_test", optimize_path)
optimize_glb = importlib.util.module_from_spec(opt_spec)
opt_spec.loader.exec_module(optimize_glb)


def load_module_reports(directory: Path) -> list[dict]:
    return walls.generate(directory)


class CreaseTests(unittest.TestCase):
    def test_cube_splits_at_ninety_degrees(self):
        mesh = walls.MaterialMesh("cube", walls.LIMESTONE, roughness=0.5, metallic=0.0)
        mesh.add_box(-1, -1, -1, 1, 1, 1)
        positions, faces, normals = walls.crease_normals(mesh.positions, mesh.faces, 42)
        self.assertEqual(len(mesh.faces), 12)
        self.assertEqual(len(faces), 12)
        # 8 corners × 3 orthogonal faces → 24 lighting vertices.
        self.assertEqual(len(positions), 24)
        self.assertEqual(len(normals), 24)
        for face, original in zip(faces, mesh.faces):
            for new_i, old_i in zip(face, original):
                self.assertEqual(positions[new_i], mesh.positions[old_i])

    def test_coplanar_quads_share_a_normal(self):
        mesh = walls.MaterialMesh("plane", walls.SLATE, roughness=0.5, metallic=0.0)
        mesh.add_quad((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1))
        mesh.add_quad((1, 0, 0), (2, 0, 0), (2, 0, 1), (1, 0, 1))
        _positions, _faces, normals = walls.crease_normals(mesh.positions, mesh.faces, 42)
        reference = normals[0]
        self.assertAlmostEqual(abs(reference[1]), 1.0, places=5)
        for n in normals:
            self.assertAlmostEqual(n[0], reference[0], places=5)
            self.assertAlmostEqual(n[1], reference[1], places=5)
            self.assertAlmostEqual(n[2], reference[2], places=5)


class KitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name)
        cls.reports = {row["name"]: row for row in load_module_reports(cls.out)}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_four_pieces_under_budget(self):
        self.assertEqual(set(self.reports), set(walls.PIECES))
        for name, row in self.reports.items():
            self.assertLessEqual(row["triangles"], walls.MAX_TRIANGLES, name)
            self.assertGreater(row["triangles"], 0, name)
            self.assertLess(row["bytes"], 20 * 1024, name)
            path = Path(row["path"])
            self.assertTrue(path.exists())
            self.assertEqual(path.suffix, ".glb")

    def test_materials_and_attributes(self):
        expected = {
            walls.hex_rgb(walls.LIMESTONE) + (1.0,),
            walls.hex_rgb(walls.SLATE) + (1.0,),
            walls.hex_rgb(walls.COPPER) + (1.0,),
        }
        for name, row in self.reports.items():
            doc, _binary = optimize_glb.parse_glb(Path(row["path"]).read_bytes())
            self.assertEqual(doc["asset"]["version"], "2.0")
            colors = set()
            for material in doc["materials"]:
                pbr = material["pbrMetallicRoughness"]
                colors.add(tuple(pbr["baseColorFactor"]))
                if material["name"] == "limestone":
                    self.assertEqual(pbr["metallicFactor"], 0.0)
                    self.assertGreaterEqual(pbr["roughnessFactor"], 0.8)
                if material["name"] == "copper":
                    self.assertGreaterEqual(pbr["metallicFactor"], 0.7)
            self.assertEqual(colors, expected, name)
            self.assertEqual(set(row["materials"]), {"limestone", "slate", "copper"})
            for primitive in doc["meshes"][0]["primitives"]:
                self.assertEqual(set(primitive["attributes"]), {"POSITION", "NORMAL"})
                self.assertNotIn("TEXCOORD_0", primitive["attributes"])
                self.assertEqual(primitive.get("mode", 4), 4)

    def test_grounded_and_axis_contract(self):
        straight = self.reports["wall-straight"]
        gate = self.reports["wall-gate"]
        self.assertGreaterEqual(straight["min"][1], -1e-6)
        self.assertGreaterEqual(gate["min"][1], -1e-6)
        self.assertEqual(straight["longest_axis"], "x")
        self.assertEqual(gate["longest_axis"], "x")
        depth_over_length = straight["size"][2] / straight["size"][0]
        self.assertAlmostEqual(depth_over_length, 0.40, delta=0.05)
        self.assertEqual(self.reports["wall-tower-a"]["longest_axis"], "y")
        self.assertEqual(self.reports["wall-tower-b"]["longest_axis"], "y")
        self.assertGreater(self.reports["wall-tower-b"]["size"][1], self.reports["wall-tower-a"]["size"][1])

    def test_gate_is_taller_than_straight_and_still_length_bound(self):
        straight = self.reports["wall-straight"]
        gate = self.reports["wall-gate"]
        self.assertGreater(gate["size"][1], straight["size"][1])
        self.assertLess(gate["size"][1], gate["size"][0])

    def test_deterministic_bytes(self):
        again = Path(tempfile.mkdtemp())
        try:
            second = {row["name"]: row for row in walls.generate(again)}
            for name, row in self.reports.items():
                a = Path(row["path"]).read_bytes()
                b = Path(second[name]["path"]).read_bytes()
                self.assertEqual(hashlib.sha256(a).hexdigest(), hashlib.sha256(b).hexdigest(), name)
        finally:
            for path in again.glob("*.glb"):
                path.unlink()
            again.rmdir()

    def test_runtime_id_map_and_glb_header(self):
        self.assertEqual(
            walls.RUNTIME_IDS,
            {
                "wall-straight": "wall_straight",
                "wall-gate": "wall_straight_gate",
                "wall-tower-a": "building_tower_A_red",
                "wall-tower-b": "building_tower_B_red",
            },
        )
        blob = Path(self.reports["wall-straight"]["path"]).read_bytes()
        magic, version, length = struct.unpack_from("<4sII", blob)
        self.assertEqual(magic, b"glTF")
        self.assertEqual(version, 2)
        self.assertEqual(length, len(blob))
        doc, binary = optimize_glb.parse_glb(blob)
        self.assertEqual(doc["buffers"][0]["byteLength"], len(binary))
        self.assertEqual(optimize_glb.triangle_count(doc), self.reports["wall-straight"]["triangles"])

    def test_cli_writes_json(self):
        with tempfile.TemporaryDirectory() as directory:
            code = walls.main(["--out", directory])
            self.assertEqual(code, 0)
            listing = list(Path(directory).glob("*.glb"))
            self.assertEqual(len(listing), 4)


class HexTests(unittest.TestCase):
    def test_palette(self):
        self.assertEqual(tuple(round(c * 255) for c in walls.hex_rgb(walls.LIMESTONE)), (216, 204, 184))
        self.assertEqual(tuple(round(c * 255) for c in walls.hex_rgb(walls.SLATE)), (52, 61, 72))
        self.assertEqual(tuple(round(c * 255) for c in walls.hex_rgb(walls.COPPER)), (140, 98, 68))


if __name__ == "__main__":
    unittest.main()
