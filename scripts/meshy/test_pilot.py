"""Offline structural checks. Synthetic inputs test parsing, not generation quality."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
from unittest.mock import patch
import unittest

spec = importlib.util.spec_from_file_location("pilot", Path(__file__).with_name("pilot.py"))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


def fixture(doc):
    payload = json.dumps(doc).encode()
    payload += b" " * (-len(payload) % 4)
    return struct.pack("<4sIIII", b"glTF", 2, 20 + len(payload), len(payload), 0x4E4F534A) + payload


def triangle_doc():
    return {"meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
            "accessors": [{"count": 3}]}


class AuditTests(unittest.TestCase):
    def test_nonindexed_triangles(self):
        self.assertEqual(pilot.glb_audit(fixture(triangle_doc()))["triangles"], 1)

    def test_indexed_triangles(self):
        doc = triangle_doc()
        doc["accessors"].append({"count": 6})
        doc["meshes"][0]["primitives"][0]["indices"] = 1
        self.assertEqual(pilot.glb_audit(fixture(doc))["triangles"], 2)

    def test_empty_rejected(self):
        with self.assertRaises(ValueError):
            pilot.glb_audit(fixture({}))

    def test_truncated_rejected(self):
        with self.assertRaises(ValueError):
            pilot.glb_audit(b"glTF")

    def test_external_buffers_rejected(self):
        doc = triangle_doc()
        doc["buffers"] = [{"uri": "outside.bin"}]
        with self.assertRaises(ValueError):
            pilot.glb_audit(fixture(doc))

    def test_external_images_rejected(self):
        doc = triangle_doc()
        doc["images"] = [{"uri": "https://example.invalid/image.png"}]
        with self.assertRaises(ValueError):
            pilot.glb_audit(fixture(doc))

    def test_nontriangles_rejected(self):
        doc = triangle_doc()
        doc["meshes"][0]["primitives"][0]["mode"] = 1
        with self.assertRaises(ValueError):
            pilot.glb_audit(fixture(doc))

    def test_existing_lock_blocks_post(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            (out / "spec.json").write_bytes((pilot.OUT / "spec.json").read_bytes())
            (out / "submission-lock.json").write_text("{}")
            response = unittest.mock.MagicMock()
            response.__enter__.return_value.read.return_value = b'{"balance": 1100}'
            with patch.object(pilot, "OUT", out), patch("sys.argv", ["pilot", "--generate"]), \
                 patch.dict("os.environ", {"MESHY_API_KEY": "offline-test"}), \
                 patch.dict("sys.modules", {"dotenv": SimpleNamespace(dotenv_values=lambda *a, **k: {})}), \
                 patch.object(pilot.urllib.request, "urlopen", return_value=response) as network:
                with self.assertRaisesRegex(SystemExit, "Submission lock exists"):
                    pilot.main()
                self.assertEqual(network.call_count, 1)
                self.assertEqual(network.call_args.args[0].get_method(), "GET")

    def test_no_generate_flag_makes_no_network_calls(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(pilot, "OUT", Path(directory)), patch("sys.argv", ["pilot"]), \
                 patch.dict("os.environ", {"MESHY_API_KEY": "offline-test"}), \
                 patch.dict("sys.modules", {"dotenv": SimpleNamespace(dotenv_values=lambda *a, **k: {})}), \
                 patch.object(pilot.urllib.request, "urlopen") as network:
                with self.assertRaisesRegex(SystemExit, "--generate"):
                    pilot.main()
                network.assert_not_called()

    def test_prompt_and_budget(self):
        doc = json.loads((pilot.OUT / "spec.json").read_text())
        self.assertLessEqual(len(doc["request"]["prompt"]), 800)
        self.assertEqual(doc["budget"]["max_create_requests"], 1)
        self.assertFalse(doc["budget"]["auto_refine"])


if __name__ == "__main__":
    unittest.main()
