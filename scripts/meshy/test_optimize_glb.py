"""Offline tests for scripts/meshy/optimize_glb.py.

Synthetic GLBs exercise the rewriter's parsing, preservation and rejection
paths; the real Meshy asset is used read-only when it is present. No network,
no Blender and no writes outside temporary directories.
"""
import importlib.util
import io
import json
import random
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = Path(__file__).with_name("optimize_glb.py")
spec = importlib.util.spec_from_file_location("optimize_glb", MODULE_PATH)
optimize_glb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(optimize_glb)

REAL_ASSET = optimize_glb.DEFAULT_INPUT
JPEG = "image/jpeg"
PNG = "image/png"


def noisy(size, seed=1234):
    """Deterministic high-entropy RGB image so JPEG/PNG payloads are realistic."""
    image = Image.frombytes("RGB", size, random.Random(seed).randbytes(size[0] * size[1] * 3))
    return image


def encode(image, mime, quality=92):
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG" if mime == JPEG else "PNG", quality=quality)
    return buffer.getvalue()


def image_payload(mime, size, seed=1234):
    return encode(noisy(size, seed), mime)


def glb(doc, binary):
    return optimize_glb.build_glb(doc, binary)


def fixture(specs=((JPEG, (1024, 512), 1), (JPEG, (800, 1200), 2), (PNG, (256, 256), 3)),
            extra_doc=None):
    """Return (doc, binary) shaped like the real Meshy export: geometry views, then images."""
    binary = bytearray()
    views = []

    def add_view(data, target=None, **extra):
        views.append(dict({"buffer": 0, "byteOffset": len(binary), "byteLength": len(data)},
                          **({"target": target} if target else {}), **extra))
        binary.extend(data)
        return len(views) - 1

    positions = add_view(struct.pack("<9f", *[float(i) for i in range(9)]), target=34962)
    normals = add_view(struct.pack("<9f", *[1.0] * 9), target=34962)
    uvs = add_view(struct.pack("<6f", *[0.0, 1.0] * 3), target=34962)
    indices = add_view(struct.pack("<3I", 0, 1, 2), target=34963)
    image_views = [add_view(image_payload(mime, size, seed)) for mime, size, seed in specs]
    texture_count = max(3, len(specs))
    doc = {
        "asset": {"version": "2.0", "generator": "test-fixture"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "archive"}],
        "meshes": [{"name": "archive", "primitives": [{
            "attributes": {"POSITION": positions, "NORMAL": normals, "TEXCOORD_0": uvs},
            "indices": indices, "mode": 4, "material": 0}]}],
        "accessors": [
            {"bufferView": positions, "componentType": 5126, "count": 3, "type": "VEC3"},
            {"bufferView": normals, "componentType": 5126, "count": 3, "type": "VEC3"},
            {"bufferView": uvs, "componentType": 5126, "count": 3, "type": "VEC2"},
            {"bufferView": indices, "componentType": 5125, "count": 3, "type": "SCALAR"},
        ],
        "bufferViews": views,
        "buffers": [{"byteLength": len(binary)}],
        "images": [{"mimeType": mime, "bufferView": view}
                   for (mime, _, _), view in zip(specs, image_views)],
        "textures": [dict({"sampler": index}, **({"source": index} if index < len(specs) else {}))
                     for index in range(texture_count)],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}
                     for _ in range(texture_count)],
        "materials": [{
            "pbrMetallicRoughness": {"baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                                     "metallicFactor": 1.0, "roughnessFactor": 1.0,
                                     "baseColorTexture": {"index": 0, "texCoord": 0},
                                     "metallicRoughnessTexture": {"index": 1, "texCoord": 0}},
            "normalTexture": {"index": 2, "texCoord": 0},
            "alphaMode": "OPAQUE", "doubleSided": True}],
    }
    if extra_doc:
        doc.update(extra_doc)
    doc["buffers"][0]["byteLength"] = len(binary)
    return doc, bytes(binary)


def view_bytes(doc, binary, index):
    view = doc["bufferViews"][index]
    start = view.get("byteOffset", 0)
    return binary[start:start + view["byteLength"]]


class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.doc, self.binary = fixture()
        self.blob = glb(self.doc, self.binary)
        self.out, self.report = optimize_glb.optimize(self.blob)

    def test_smaller_output_and_verified(self):
        self.assertLess(len(self.out), len(self.blob))
        self.assertTrue(self.report["verification"]["ok"], self.report["verification"])
        self.assertGreater(self.report["savings_bytes"], 0)

    def test_images_capped_with_aspect_kept(self):
        out_doc, out_bin = optimize_glb.parse_glb(self.out)
        self.assertEqual(len(out_doc["images"]), 3)
        for image in out_doc["images"]:
            data = view_bytes(out_doc, out_bin, image["bufferView"])
            width, height = optimize_glb.image_size(data)
            self.assertLessEqual(max(width, height), 512)
        before = self.report["images"][0]["before"]
        after = self.report["images"][0]["after"]
        self.assertAlmostEqual(after["width"] / after["height"],
                               before["width"] / before["height"], delta=0.01)

    def test_mime_types_preserved(self):
        out_doc, out_bin = optimize_glb.parse_glb(self.out)
        for image, original in zip(out_doc["images"], self.doc["images"]):
            self.assertEqual(image["mimeType"], original["mimeType"])
            data = view_bytes(out_doc, out_bin, image["bufferView"])
            self.assertEqual(optimize_glb.sniff_mime(data), original["mimeType"])

    def test_geometry_views_identical_and_offsets_preserved(self):
        out_doc, out_bin = optimize_glb.parse_glb(self.out)
        for index in range(4):
            self.assertEqual(view_bytes(out_doc, out_bin, index), view_bytes(self.doc, self.binary, index))
            self.assertEqual(out_doc["bufferViews"][index]["byteOffset"],
                             self.doc["bufferViews"][index]["byteOffset"])
        self.assertTrue(self.report["geometry"]["offsets_preserved"])
        self.assertEqual(self.report["geometry"]["overlapping_views"], [])

    def test_topology_and_pbr_slots_preserved(self):
        out_doc, _ = optimize_glb.parse_glb(self.out)
        checks = self.report["verification"]
        self.assertTrue(checks["topology_equal"])
        self.assertTrue(checks["pbr_slots_preserved"])
        self.assertEqual(out_doc["meshes"], self.doc["meshes"])
        self.assertEqual(optimize_glb.triangle_count(out_doc), 1)
        self.assertEqual(optimize_glb.slot_map(out_doc), optimize_glb.slot_map(self.doc))
        slots = optimize_glb.slot_map(out_doc)[0]
        self.assertEqual(slots["normalTexture"], 2)
        self.assertEqual(slots["metallicRoughnessTexture"], 1)
        self.assertEqual(slots["baseColorTexture"], 0)

    def test_report_shape_and_alignment(self):
        for key in ("settings", "input", "output", "images", "geometry", "structure",
                    "pbr_slots", "verification", "runtime_ms", "process_peak_rss_kb"):
            self.assertIn(key, self.report)
        self.assertEqual(self.report["input"]["bytes"], len(self.blob))
        self.assertEqual(len(self.report["images"]), 3)
        for entry in self.report["images"]:
            self.assertEqual(set(entry["before"]) | set(entry["after"]),
                             {"width", "height", "bytes"})
            self.assertIn(entry["action"], ("resized", "reencoded", "unchanged"))
        self.assertTrue(self.report["verification"]["alignment_ok"])
        out_doc, _ = optimize_glb.parse_glb(self.out)
        for view in out_doc["bufferViews"]:
            self.assertEqual(view["byteOffset"] % 4, 0)

    def test_processing_is_deterministic(self):
        again, _ = optimize_glb.optimize(self.blob)
        self.assertEqual(again, self.out)

    def test_no_upscale_when_already_small(self):
        doc, binary = fixture(specs=((JPEG, (100, 64), 7),))
        blob = glb(doc, binary)
        out, report = optimize_glb.optimize(blob)
        out_doc, out_bin = optimize_glb.parse_glb(out)
        data = view_bytes(out_doc, out_bin, out_doc["images"][0]["bufferView"])
        self.assertEqual(optimize_glb.image_size(data), (100, 64))
        self.assertFalse(report["images"][0]["resized"])
        self.assertIn(report["images"][0]["action"], ("unchanged", "reencoded"))
        self.assertEqual(report["images"][0]["after"]["width"], 100)

    def test_custom_max_size(self):
        out, report = optimize_glb.optimize(self.blob, max_size=128)
        out_doc, out_bin = optimize_glb.parse_glb(out)
        self.assertTrue(report["verification"]["images_within_limit"])
        for image in out_doc["images"]:
            width, height = optimize_glb.image_size(view_bytes(out_doc, out_bin, image["bufferView"]))
            self.assertLessEqual(max(width, height), 128)


class FaithfulLayoutTests(unittest.TestCase):
    def test_partially_overlapping_distinct_views_are_supported(self):
        """A geometry view that overlaps image bytes is copied verbatim, not rebuilt."""
        payload = image_payload(JPEG, (1024, 512))
        positions = struct.pack("<9f", *[0.0] * 9)
        binary = positions + payload
        overlap_start = len(positions) + 100
        doc = {
            "asset": {"version": "2.0"},
            "bufferViews": [
                {"buffer": 0, "byteOffset": 0, "byteLength": len(positions), "target": 34962},
                {"buffer": 0, "byteOffset": len(positions), "byteLength": len(payload)},
                {"buffer": 0, "byteOffset": overlap_start, "byteLength": 64, "target": 34962},
            ],
            "buffers": [{"byteLength": len(binary)}],
            "accessors": [
                {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"},
                {"bufferView": 2, "componentType": 5126, "count": 4, "type": "VEC2"},
            ],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1},
                                        "mode": 4}]}],
            "images": [{"mimeType": JPEG, "bufferView": 1}],
            "textures": [{"source": 0}],
            "materials": [{"pbrMetallicRoughness": {"metallicRoughnessTexture": {"index": 0}},
                           "normalTexture": {"index": 0}}],
        }
        out, report = optimize_glb.optimize(glb(doc, binary))
        self.assertEqual(report["geometry"]["overlapping_views"], [[1, 2]])
        self.assertTrue(report["verification"]["geometry_bytes_identical"])
        out_doc, out_bin = optimize_glb.parse_glb(out)
        self.assertEqual(view_bytes(out_doc, out_bin, 0), positions)
        self.assertEqual(view_bytes(out_doc, out_bin, 2), binary[overlap_start:overlap_start + 64])
        shrunk = view_bytes(out_doc, out_bin, 1)
        self.assertLessEqual(max(optimize_glb.image_size(shrunk)), 512)
        self.assertLess(len(shrunk), len(payload))


class RejectionTests(unittest.TestCase):
    def assert_rejected(self, blob, exception=optimize_glb.UnsupportedLayout):
        with self.assertRaises(exception):
            optimize_glb.optimize(blob)

    def test_shared_image_buffer_view(self):
        doc, binary = fixture(specs=((JPEG, (1024, 512), 1), (JPEG, (1024, 512), 2)))
        doc["images"][1]["bufferView"] = doc["images"][0]["bufferView"]
        self.assert_rejected(glb(doc, binary))

    def test_image_with_uri(self):
        doc, binary = fixture(specs=((JPEG, (1024, 512), 1),))
        doc["images"][0] = {"uri": "data:image/png;base64,AAAA"}
        self.assert_rejected(glb(doc, binary))

    def test_image_view_shared_with_accessor(self):
        doc, binary = fixture(specs=((JPEG, (1024, 512), 1),))
        doc["accessors"].append({"bufferView": doc["images"][0]["bufferView"],
                                 "componentType": 5126, "count": 1, "type": "VEC2"})
        self.assert_rejected(glb(doc, binary))

    def test_image_view_with_byte_stride(self):
        doc, binary = fixture(specs=((JPEG, (1024, 512), 1),))
        doc["bufferViews"][doc["images"][0]["bufferView"]]["byteStride"] = 8
        self.assert_rejected(glb(doc, binary))

    def test_unsupported_media_type(self):
        doc, binary = fixture(specs=((JPEG, (1024, 512), 1),))
        doc["images"][0]["mimeType"] = "image/ktx2"
        view = doc["bufferViews"][doc["images"][0]["bufferView"]]
        binary = binary[:view["byteOffset"]] + b"\xabKTX 11\xbb\r\n\x1a\n" + b"\x00" * 16
        doc["buffers"][0]["byteLength"] = len(binary)
        view["byteLength"] = len(binary) - view["byteOffset"]
        self.assert_rejected(glb(doc, binary))

    def test_missing_buffer_view_on_image(self):
        doc, binary = fixture(specs=((JPEG, (1024, 512), 1),))
        del doc["images"][0]["bufferView"]
        self.assert_rejected(glb(doc, binary))

    def test_draco_extension(self):
        doc, binary = fixture()
        doc["extensionsRequired"] = ["KHR_draco_mesh_compression"]
        self.assert_rejected(glb(doc, binary))

    def test_meshopt_extension(self):
        doc, binary = fixture()
        doc["extensionsUsed"] = ["EXT_meshopt_compression"]
        self.assert_rejected(glb(doc, binary))

    def test_external_buffer(self):
        doc, binary = fixture()
        doc["buffers"][0] = {"uri": "outside.bin", "byteLength": len(binary)}
        self.assert_rejected(glb(doc, binary))

    def test_image_in_non_embedded_buffer(self):
        doc = {"asset": {"version": "2.0"},
               "buffers": [{"byteLength": 8}, {"byteLength": 16}],
               "bufferViews": [{"buffer": 1, "byteOffset": 0, "byteLength": 16}],
               "images": [{"mimeType": PNG, "bufferView": 0}]}
        self.assert_rejected(glb(doc, b"\x00" * 8))

    def test_buffer_view_out_of_range(self):
        doc, binary = fixture()
        doc["bufferViews"][0]["byteLength"] = len(binary) + 8
        self.assert_rejected(glb(doc, binary), optimize_glb.GlbError)

    def test_bin_shorter_than_declared(self):
        doc, binary = fixture()
        doc["buffers"][0]["byteLength"] = len(binary) + 64
        self.assert_rejected(glb(doc, binary), optimize_glb.GlbError)

    def test_bad_magic(self):
        self.assert_rejected(b"NOPE" + b"\x00" * 20, optimize_glb.GlbError)

    def test_truncated_header(self):
        self.assert_rejected(b"glTF", optimize_glb.GlbError)

    def test_header_length_mismatch(self):
        blob = bytearray(glb(*fixture()))
        struct.pack_into("<I", blob, 8, len(blob) - 4)
        self.assert_rejected(bytes(blob), optimize_glb.GlbError)

    def test_undecodable_image_bytes(self):
        doc, binary = fixture(specs=((JPEG, (1024, 512), 1),))
        view = doc["bufferViews"][doc["images"][0]["bufferView"]]
        binary = binary[:view["byteOffset"]] + b"\xff\xd8\xff" + b"\x11" * 32
        doc["buffers"][0]["byteLength"] = len(binary)
        view["byteLength"] = len(binary) - view["byteOffset"]
        self.assert_rejected(glb(doc, binary), optimize_glb.GlbError)


class GuardTests(unittest.TestCase):
    def test_public_paths_detected(self):
        self.assertTrue(optimize_glb.public_path("/repo/public/models/a.glb"))
        self.assertTrue(optimize_glb.public_path("dist/a.glb"))
        self.assertFalse(optimize_glb.public_path("assets-src/meshy/x/y.glb"))

    @unittest.skipIf(shutil.which("git") is None, "git not installed")
    def test_default_output_is_git_ignored(self):
        self.assertIs(optimize_glb.git_ignored(optimize_glb.DEFAULT_OUTPUT), True)
        self.assertIs(optimize_glb.git_ignored(ROOT / "AGENTS.md"), False)

    @unittest.skipIf(shutil.which("git") is None, "git not installed")
    def test_git_ignored_in_temporary_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            (repo / ".gitignore").write_text("*.glb\n")
            self.assertIs(optimize_glb.git_ignored(repo / "asset.glb", repo), True)
            self.assertIs(optimize_glb.git_ignored(repo / "asset.txt", repo), False)
            self.assertIsNone(optimize_glb.git_ignored(Path(directory).parent / "outside.glb", repo))

    def test_main_writes_output_report_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / "in.glb").write_bytes(glb(*fixture()))
            argv = ["--input", str(work / "in.glb"), "--output", str(work / "out.glb"),
                    "--report", str(work / "out.json")]
            self.assertEqual(optimize_glb.main(argv), 0)
            report = json.loads((work / "out.json").read_text())
            self.assertTrue((work / "out.glb").exists())
            self.assertTrue(report["verification"]["ok"])
            self.assertFalse(report["local_only"]["public_export"])
            self.assertEqual(report["local_only"]["license_status"], "unverified")
            self.assertLess(report["output"]["bytes"], report["input"]["bytes"])
            with self.assertRaisesRegex(SystemExit, "exists"):
                optimize_glb.main(argv)
            self.assertEqual(optimize_glb.main(argv + ["--force"]), 0)

    def test_main_refuses_public_output(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / "in.glb").write_bytes(glb(*fixture()))
            with self.assertRaisesRegex(SystemExit, "non-public"):
                optimize_glb.main(["--input", str(work / "in.glb"),
                                   "--output", str(work / "public" / "out.glb"),
                                   "--report", str(work / "out.json")])

    def test_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / "in.glb").write_bytes(glb(*fixture()))
            optimize_glb.main(["--input", str(work / "in.glb"), "--output", str(work / "out.glb"),
                               "--report", str(work / "out.json"), "--dry-run"])
            self.assertFalse((work / "out.glb").exists())
            self.assertFalse((work / "out.json").exists())

    def test_no_network_or_blender_dependencies(self):
        source = MODULE_PATH.read_text()
        for forbidden in ("urllib", "requests", "httpx", "socket", "http.client",
                          "import bpy", "bpy."):
            self.assertNotIn(forbidden, source, f"{forbidden} must not appear in the optimizer")


class RealAssetTests(unittest.TestCase):
    def test_real_meshy_asset(self):
        if not REAL_ASSET.exists():
            self.skipTest(f"local asset not present: {REAL_ASSET}")
        blob = REAL_ASSET.read_bytes()
        out, report = optimize_glb.optimize(blob)
        checks = report["verification"]
        self.assertTrue(checks["ok"], checks)
        self.assertTrue(checks["geometry_bytes_identical"])
        self.assertTrue(checks["topology_equal"])
        self.assertTrue(checks["pbr_slots_preserved"])
        self.assertTrue(checks["images_within_limit"])
        self.assertLess(len(out), len(blob))
        doc, binary = optimize_glb.parse_glb(out)
        self.assertEqual(doc["images"], optimize_glb.parse_glb(blob)[0]["images"])
        for view in doc["bufferViews"]:
            self.assertEqual(view["byteOffset"] % 4, 0)
        for image in doc["images"]:
            width, height = optimize_glb.image_size(view_bytes(doc, binary, image["bufferView"]))
            self.assertLessEqual(max(width, height), 512)
        # Geometry views keep their original offsets: images are the trailing views.
        original, original_binary = optimize_glb.parse_glb(blob)
        for index, view in enumerate(doc["bufferViews"]):
            if index in optimize_glb.safe_image_view_map(doc):
                continue
            self.assertEqual(view["byteOffset"], original["bufferViews"][index]["byteOffset"])
            self.assertEqual(view_bytes(doc, binary, index),
                             view_bytes(original, original_binary, index))



if __name__ == "__main__":
    unittest.main()
