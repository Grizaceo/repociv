"""Offline authorization/isolation check; never contacts Meshy."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import observatory_concept as obs
import workshop_concept as runner

PNG = b"\x89PNG\r\n\x1a\nfixture"


def _stub_reference_pngs(spec, root: Path) -> None:
    for rel in spec["concept"]["reference_relative_paths"]:
        dest = root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(PNG)


class ObservatoryTests(unittest.TestCase):
    def test_entrypoint_isolated_and_restored_in_test(self):
        with patch.object(runner, "OUT", runner.OUT), patch.object(runner, "main") as main:
            obs.main()
            main.assert_called_once_with()
            self.assertEqual(runner.OUT, obs.OUT)
            self.assertNotIn("execution-workshop", str(runner.OUT))

    def test_exact_authorized_request_and_duplicate_block(self):
        spec = json.loads((obs.OUT / "spec.json").read_text())
        req = spec["concept"]["request_without_reference_paths"]
        self.assertEqual(req["ai_model"], "nano-banana-pro")
        self.assertFalse(req["generate_multi_view"])
        self.assertEqual(spec["concept"]["advertised_credits"], 9)
        self.assertFalse(spec["guards"]["auto_geometry"])
        self.assertFalse(spec["guards"]["auto_texture"])
        calls = []

        def fake_api(route, payload=None):
            calls.append((route, payload))
            if payload is None:
                self.assertEqual(route, "/v1/balance")
                return {"balance": 1071}
            self.assertEqual(route, "/v1/image-to-image")
            self.assertEqual(payload["prompt"], req["prompt"])
            self.assertEqual(len(payload["reference_image_urls"]), 1)
            self.assertNotIn("response_format", payload)
            return {"result": "offline-observatory-task"}

        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            out = root / "out"
            out.mkdir()
            _stub_reference_pngs(spec, root)
            with patch.object(runner, "ROOT", root):
                state = runner.create_once(out, spec, fake_api)
            self.assertEqual(state["task_id"], "offline-observatory-task")
            self.assertNotIn("data:image", (out / "generation.json").read_text())
            with self.assertRaises(SystemExit):
                with patch.object(runner, "ROOT", root):
                    runner.create_once(out, spec, fake_api)
        self.assertEqual(sum(payload is not None for _, payload in calls), 1)


if __name__ == "__main__":
    unittest.main()
