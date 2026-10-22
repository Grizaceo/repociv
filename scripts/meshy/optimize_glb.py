"""Downscale embedded GLB textures locally without touching geometry.

Meshy's textured output ships 2k JPEG maps that dominate the file size while the
game only ever samples them heavily minified. This tool rewrites the GLB BIN
chunk: every bufferView is copied verbatim (so vertex/index bytes, accessor
offsets and internal layouts survive untouched) except the bufferViews that
carry embedded images, which are replaced with Pillow-downscaled, re-encoded
copies. Rewritten bufferView offsets are re-aligned to 4 bytes.

Guarantees and boundaries:
  * stdlib + Pillow only. No network, no Blender, no scene mutation.
  * Embedded (bufferView) PNG/JPEG images only. Shared or exotic layouts are
    rejected with UnsupportedLayout instead of being guessed at.
  * The output stays under an ignored, non-public path: the Meshy asset license
    is unverified, so the binary is local-only and never enters Git.

Usage:
    python scripts/meshy/optimize_glb.py                  # default paths
    python scripts/meshy/optimize_glb.py --dry-run        # report only
"""
import argparse
import hashlib
import io
import json
import struct
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ASSET_DIR = ROOT / "assets-src/meshy/memory-archive/textured"
DEFAULT_INPUT = ASSET_DIR / "archive-textured.glb"
DEFAULT_OUTPUT = ASSET_DIR / "archive-map.glb"
DEFAULT_REPORT = ASSET_DIR / "archive-map.report.json"

GLB_MAGIC = b"glTF"
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
MAX_INPUT_BYTES = 256 * 1024 * 1024
MAX_IMAGE_PIXELS = 100_000_000
SUPPORTED_MIME = {"image/jpeg": "JPEG", "image/png": "PNG"}
BLOCKED_EXTENSIONS = ("KHR_draco_mesh_compression", "EXT_meshopt_compression")
# Path segments that mean "this file would ship with the app".
PUBLIC_SEGMENTS = {"public", "dist", "build", "static", "htdocs", "www"}
COMPONENT_SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
PBR_SLOTS = ("baseColorTexture", "metallicRoughnessTexture", "normalTexture",
             "occlusionTexture", "emissiveTexture")
# glTF JSON members we promise to preserve field-for-field.
PRESERVED_MEMBERS = ("asset", "scene", "scenes", "nodes", "meshes", "accessors",
                     "materials", "textures", "samplers", "images", "skins",
                     "animations", "extensions", "extensionsUsed", "extensionsRequired")


class GlbError(ValueError):
    """The input is not a GLB this tool can rewrite at all."""


class UnsupportedLayout(GlbError):
    """A valid-but-exotic structure we refuse to rewrite rather than risk corruption."""


def sha256(blob):
    return hashlib.sha256(blob).hexdigest()


def parse_glb(blob):
    """Split a GLB v2 container into ``(json_doc, bin_bytes)`` with strict checks."""
    if len(blob) < 12:
        raise GlbError("truncated GLB header")
    magic, version, length = struct.unpack_from("<4sII", blob)
    if magic != GLB_MAGIC:
        raise GlbError("not a GLB container")
    if version != 2:
        raise GlbError(f"unsupported GLB version {version}")
    if length != len(blob):
        raise GlbError("GLB header length does not match the file size")
    doc = None
    binary = b""
    offset = 12
    chunks = 0
    while offset < length:
        if offset + 8 > length:
            raise GlbError("truncated GLB chunk header")
        size, kind = struct.unpack_from("<II", blob, offset)
        body = offset + 8
        if body + size > length:
            raise GlbError("GLB chunk overruns the file")
        chunks += 1
        if chunks > 2:
            raise GlbError("unexpected extra GLB chunk")
        if kind == JSON_CHUNK:
            try:
                doc = json.loads(blob[body:body + size].decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as exc:
                raise GlbError(f"invalid JSON chunk: {exc}") from None
        elif kind == BIN_CHUNK:
            binary = blob[body:body + size]
        else:
            raise GlbError(f"unknown GLB chunk type 0x{kind:08x}")
        offset = body + size
    if doc is None:
        raise GlbError("GLB has no JSON chunk")
    return doc, binary


def build_glb(doc, binary):
    """Serialize ``(doc, binary)`` back into a padded GLB v2 container."""
    payload = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    payload += b" " * (-len(payload) % 4)
    padded = bytes(binary) + b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(payload) + 8 + len(padded)
    return (struct.pack("<4sII", GLB_MAGIC, 2, total)
            + struct.pack("<II", len(payload), JSON_CHUNK) + payload
            + struct.pack("<II", len(padded), BIN_CHUNK) + padded)


def sniff_mime(data):
    """Media type from magic bytes, for images whose mimeType is absent."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    return None


def image_size(data):
    with Image.open(io.BytesIO(data)) as image:
        return image.size


def _encode(image, mime, quality, subsampling):
    buffer = io.BytesIO()
    if mime == "image/jpeg":
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        image.save(buffer, format="JPEG", quality=quality, optimize=True,
                   progressive=False, subsampling=subsampling)
        return buffer.getvalue(), f"jpeg-q{quality}-s{subsampling}"
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue(), "png-optimized"


def resize_image(data, mime, max_size, jpeg_quality, jpeg_subsampling=0):
    """Downscale one embedded image; returns ``(bytes, info)``. Never upscales."""
    try:
        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            if width * height > MAX_IMAGE_PIXELS:
                raise UnsupportedLayout(f"image too large to decode safely ({width}x{height})")
            image.load()
            scale = min(1.0, max_size / width, max_size / height)
            new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
            resized = new_size != (width, height)
            if resized:
                image = image.resize(new_size, Image.Resampling.LANCZOS)
            encoded, encoder = _encode(image, mime, jpeg_quality, jpeg_subsampling)
    except UnsupportedLayout:
        raise
    except Exception as exc:  # Pillow raises OSError/ValueError/SyntaxError depending on damage
        raise GlbError(f"undecodable {mime} image: {exc}") from None
    if not resized:
        if len(encoded) >= len(data):
            encoded, encoder = data, "source-bytes"
        action = "unchanged" if encoded is data else "reencoded"
    else:
        action = "resized"
    info = {"mime_type": mime,
            "before": {"width": width, "height": height, "bytes": len(data)},
            "after": dict(zip(("width", "height"), new_size), bytes=len(encoded)),
            "resized": resized, "encoder": encoder, "action": action}
    return encoded, info


def image_view_map(doc):
    """Map image bufferView index -> image index, rejecting shared/unsupported layouts."""
    views = doc.get("bufferViews") or []
    mapping = {}
    for index, image in enumerate(doc.get("images", [])):
        if "uri" in image:
            raise UnsupportedLayout(
                f"image {index} uses an external/data URI; only embedded images are rewritable")
        view_index = image.get("bufferView")
        if not isinstance(view_index, int) or not 0 <= view_index < len(views):
            raise UnsupportedLayout(f"image {index} has no usable bufferView")
        if view_index in mapping:
            raise UnsupportedLayout(
                f"images {mapping[view_index]} and {index} share bufferView {view_index}")
        mapping[view_index] = index
    accessor_views = {a["bufferView"] for a in doc.get("accessors", []) if "bufferView" in a}
    for view_index, image_index in mapping.items():
        if view_index in accessor_views:
            raise UnsupportedLayout(
                f"bufferView {view_index} carries both image {image_index} and accessor data")
        if views[view_index].get("byteStride") is not None:
            raise UnsupportedLayout(f"image bufferView {view_index} declares a byteStride")
    return mapping


def safe_image_view_map(doc):
    """``image_view_map`` variant that returns {} instead of raising (for verification)."""
    try:
        return image_view_map(doc)
    except GlbError:
        return {}


def _segments(doc, binary):
    """Ordered ``(old_offset, view_index)`` list for buffer-0 views, plus overlap pairs."""
    views = doc.get("bufferViews") or []
    declared = (doc.get("buffers") or [{}])[0].get("byteLength", 0)
    image_views = image_view_map(doc)
    segments = []
    for index, view in enumerate(views):
        if view.get("buffer", 0) != 0:
            if index in image_views:
                raise UnsupportedLayout(f"image bufferView {index} lives in a non-embedded buffer")
            continue
        start = view.get("byteOffset", 0)
        end = start + view["byteLength"]
        if start < 0 or end > declared:
            raise GlbError(f"bufferView {index} exceeds the BIN chunk")
        segments.append((start, index))
    segments.sort()
    overlaps = []
    for (start_a, index_a), (start_b, index_b) in zip(segments, segments[1:]):
        if start_a + views[index_a]["byteLength"] > start_b:
            overlaps.append([index_a, index_b])
    return segments, overlaps


def triangle_count(doc):
    total = 0
    for mesh in doc.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            if primitive.get("mode", 4) != 4:
                continue
            accessor = primitive.get("indices", (primitive.get("attributes") or {}).get("POSITION"))
            if accessor is None:
                continue
            total += doc["accessors"][accessor]["count"] // 3
    return total


def vertex_count(doc):
    total = 0
    for mesh in doc.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            accessor = (primitive.get("attributes") or {}).get("POSITION")
            if accessor is not None:
                total += doc["accessors"][accessor]["count"]
    return total


def slot_map(doc):
    """material index -> {slot: image index} for every PBR texture slot."""
    result = {}
    textures = doc.get("textures", [])
    for index, material in enumerate(doc.get("materials", [])):
        pbr = material.get("pbrMetallicRoughness") or {}
        slots = {}
        for slot in PBR_SLOTS:
            reference = material.get(slot) if slot in material else pbr.get(slot)
            if isinstance(reference, dict) and isinstance(reference.get("index"), int):
                texture = textures[reference["index"]] if reference["index"] < len(textures) else {}
                slots[slot] = texture.get("source")
            else:
                slots[slot] = None
        result[index] = slots
    return result


def optimize(blob, *, max_size=512, jpeg_quality=85, jpeg_subsampling=0):
    """Return ``(new_glb_bytes, report)``. Pure: no I/O, no network, input untouched."""
    started = time.monotonic()
    if len(blob) > MAX_INPUT_BYTES:
        raise GlbError(f"input exceeds the {MAX_INPUT_BYTES // (1024 * 1024)} MiB working limit")
    doc, binary = parse_glb(blob)
    declared_extensions = set(doc.get("extensionsUsed", [])) | set(doc.get("extensionsRequired", []))
    blocked = sorted(declared_extensions & set(BLOCKED_EXTENSIONS))
    if blocked:
        raise UnsupportedLayout(f"compressed vertex buffers are out of scope: {', '.join(blocked)}")
    buffers = doc.get("buffers") or []
    if not buffers:
        raise GlbError("GLB has no buffer")
    if "uri" in buffers[0]:
        raise UnsupportedLayout("buffer 0 points outside the container")
    declared = buffers[0].get("byteLength", 0)
    if len(binary) < declared:
        raise GlbError("BIN chunk is shorter than buffers[0].byteLength")
    trailing_padding = len(binary) - declared
    binary = binary[:declared]

    segments, overlaps = _segments(doc, binary)
    views = doc["bufferViews"]
    image_views = image_view_map(doc)
    covered_before = sum(view["byteLength"] for row, view in enumerate(views)
                         if row in {index for _, index in segments})

    new_binary = bytearray()
    images = []
    geometry = {"buffer_views_copied": 0, "bytes_copied": 0,
                "offsets_preserved": True, "overlapping_views": overlaps}
    for old_offset, index in segments:
        view = views[index]
        data = binary[old_offset:old_offset + view["byteLength"]]
        if index in image_views:
            image_index = image_views[index]
            mime = doc["images"][image_index].get("mimeType") or sniff_mime(data)
            if mime not in SUPPORTED_MIME:
                raise UnsupportedLayout(
                    f"image {image_index} media type {mime!r} is not PNG or JPEG")
            doc["images"][image_index].setdefault("mimeType", mime)
            data, info = resize_image(data, mime, max_size, jpeg_quality, jpeg_subsampling)
            info.update({"index": image_index, "buffer_view": index, "old_byte_length": view["byteLength"]})
            images.append(info)
        else:
            geometry["buffer_views_copied"] += 1
            geometry["bytes_copied"] += len(data)
        new_binary += b"\0" * (-len(new_binary) % 4)
        if index not in image_views and view.get("byteOffset", 0) != len(new_binary):
            geometry["offsets_preserved"] = False
        view["byteOffset"] = len(new_binary)
        view["byteLength"] = len(data)
        new_binary += data
    new_binary += b"\0" * (-len(new_binary) % 4)
    buffers[0]["byteLength"] = len(new_binary)
    out_blob = build_glb(doc, bytes(new_binary))

    report = {
        "tool": "scripts/meshy/optimize_glb.py",
        "settings": {"max_size": max_size, "jpeg_quality": jpeg_quality,
                     "jpeg_subsampling": jpeg_subsampling},
        "input": {"bytes": len(blob), "sha256": sha256(blob)},
        "output": {"bytes": len(out_blob), "sha256": sha256(out_blob)},
        "savings_bytes": len(blob) - len(out_blob),
        "savings_percent": round(100 * (len(blob) - len(out_blob)) / len(blob), 2) if blob else 0.0,
        "images": images,
        "geometry": geometry,
        "structure": {"meshes": len(doc.get("meshes", [])),
                      "primitives": sum(len(m.get("primitives", [])) for m in doc.get("meshes", [])),
                      "triangles": triangle_count(doc), "vertices": vertex_count(doc),
                      "accessors": len(doc.get("accessors", [])),
                      "buffer_views": len(views), "materials": len(doc.get("materials", [])),
                      "textures": len(doc.get("textures", [])), "images": len(doc.get("images", []))},
        "pbr_slots": describe_slots(doc),
        "slack_bytes_dropped": declared - covered_before,
        "trailing_bin_padding_bytes": trailing_padding,
        "runtime_ms": None,
        "process_peak_rss_kb": peak_rss_kb(),
    }
    report["verification"] = verify(blob, out_blob, max_size=max_size)
    if not report["verification"]["ok"]:
        raise GlbError(f"post-rewrite verification failed: {report['verification']}")
    report["runtime_ms"] = round((time.monotonic() - started) * 1000, 1)
    return out_blob, report


def describe_slots(doc):
    """Readable PBR evidence: material -> slot -> texture/image/media/dimensions."""
    described = []
    images = doc.get("images", [])
    textures = doc.get("textures", [])
    for index, material in enumerate(doc.get("materials", [])):
        pbr = material.get("pbrMetallicRoughness") or {}
        slots = {}
        for slot in PBR_SLOTS:
            reference = material.get(slot) if slot in material else pbr.get(slot)
            entry = None
            if (isinstance(reference, dict) and isinstance(reference.get("index"), int)
                    and 0 <= reference["index"] < len(textures)):
                entry = {"texture": reference["index"]}
                texture = textures[reference["index"]]
                entry["image"] = texture.get("source")
                if isinstance(texture.get("source"), int) and texture["source"] < len(images):
                    entry["mime_type"] = images[texture["source"]].get("mimeType")
            slots[slot] = entry
        described.append({"material": index, "slots": slots})
    return described


def verify(original_blob, output_blob, *, max_size=512):
    """Compare original and rewritten GLB; every entry must survive unchanged."""
    o_doc, o_bin = parse_glb(original_blob)
    n_doc, n_bin = parse_glb(output_blob)
    o_images = safe_image_view_map(o_doc)
    n_images = safe_image_view_map(n_doc)
    checks = {}
    checks["preserved_fields"] = all(
        key not in o_doc or key in n_doc and _preserved(o_doc[key], n_doc[key])
        for key in PRESERVED_MEMBERS)
    checks["topology_equal"] = (o_doc.get("meshes") == n_doc.get("meshes")
                                and triangle_count(o_doc) == triangle_count(n_doc)
                                and vertex_count(o_doc) == vertex_count(n_doc))

    o_views = o_doc.get("bufferViews", [])
    n_views = n_doc.get("bufferViews", [])
    checks["buffer_view_count_equal"] = len(o_views) == len(n_views)
    identical = True
    for index, view in enumerate(o_views):
        if index in o_images or view.get("buffer", 0) != 0:
            continue
        start = view.get("byteOffset", 0)
        new = n_views[index]
        new_start = new.get("byteOffset", 0)
        if (new["byteLength"] != view["byteLength"]
                or o_bin[start:start + view["byteLength"]] != n_bin[new_start:new_start + new["byteLength"]]):
            identical = False
    checks["geometry_bytes_identical"] = identical
    checks["image_count_equal"] = len(o_doc.get("images", [])) == len(n_doc.get("images", []))
    checks["pbr_slots_preserved"] = slot_map(o_doc) == slot_map(n_doc)
    declared = (n_doc.get("buffers") or [{}])[0].get("byteLength")
    checks["buffer_lengths_ok"] = declared == len(n_bin) and len(n_bin) % 4 == 0
    checks["alignment_ok"] = _alignment_ok(n_doc)
    dimensions_ok = True
    for index, image in enumerate(n_doc.get("images", [])):
        view = n_views[image.get("bufferView", -1)]
        data = n_bin[view.get("byteOffset", 0):view.get("byteOffset", 0) + view["byteLength"]]
        try:
            width, height = image_size(data)
        except OSError:
            dimensions_ok = False
            continue
        if width > max_size or height > max_size or index not in n_images.values():
            dimensions_ok = False
    checks["images_within_limit"] = dimensions_ok and len(n_images) == len(n_doc.get("images", []))
    checks["ok"] = all(value for key, value in checks.items() if key != "ok")
    return checks


def _alignment_ok(doc):
    views = doc.get("bufferViews", [])
    for view in views:
        if view.get("buffer", 0) == 0 and view.get("byteOffset", 0) % 4:
            return False
    for accessor in doc.get("accessors", []):
        size = COMPONENT_SIZE.get(accessor.get("componentType", 0), 1)
        view = views[accessor.get("bufferView", -1)]
        absolute = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        if absolute % size:
            return False
    return True


def _preserved(original, candidate):
    """True when every field of ``original`` survives unchanged inside ``candidate``."""
    if isinstance(original, dict):
        return isinstance(candidate, dict) and all(
            key in candidate and _preserved(value, candidate[key]) for key, value in original.items())
    if isinstance(original, list):
        return (isinstance(candidate, list) and len(original) == len(candidate)
                and all(_preserved(a, b) for a, b in zip(original, candidate)))
    return original == candidate


def peak_rss_kb():
    try:
        import resource
    except ImportError:  # pragma: no cover - Windows only
        return None
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss


def public_path(path):
    """True when writing ``path`` would ship the binary with the application."""
    return any(part in PUBLIC_SEGMENTS for part in Path(path).parts)


def git_ignored(path, root=ROOT):
    """True/False when Git has an opinion, None when Git is unavailable or unsure."""
    root = Path(root).resolve()
    try:
        Path(path).resolve().relative_to(root)
    except ValueError:
        return None  # outside the repository: its ignore rules say nothing about this path
    try:
        result = subprocess.run(["git", "-C", str(root), "check-ignore", "--quiet", str(path)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    except OSError:
        return None
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    return None


def run(args):
    """Execute one optimization pass and return the report (writes unless --dry-run)."""
    if public_path(args.output) and not args.allow_public:
        raise SystemExit(f"refusing to write a non-public asset under {args.output}")
    ignored = git_ignored(args.output)
    if ignored is False and not args.allow_unignored:
        raise SystemExit(
            f"{args.output} is not Git-ignored; the license is unverified (--allow-unignored to override)")
    if args.output.exists() and not args.force:
        raise SystemExit(f"{args.output} exists; pass --force to overwrite")
    if not args.input.exists():
        raise SystemExit(f"missing input {args.input}")
    blob = args.input.read_bytes()
    out_blob, report = optimize(blob, max_size=args.max_size, jpeg_quality=args.jpeg_quality,
                                jpeg_subsampling=args.jpeg_subsampling)
    report["input"]["path"] = str(args.input)
    report["output"]["path"] = str(args.output)
    report["report_path"] = str(args.report)
    report["local_only"] = {
        "license_status": "unverified",
        "git_ignored": ignored,
        "public_export": False,
        "note": "Meshy asset license unverified: keep local, never copy into public/ or Git.",
    }
    report["dry_run"] = bool(args.dry_run)
    if not args.dry_run:
        _atomic_write(args.output, out_blob)
        _atomic_write(args.report, (json.dumps(report, indent=2) + "\n").encode("utf-8"))
    return report


def _atomic_write(path, blob):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_bytes(blob)
    temp.replace(path)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--max-size", type=int, default=512, help="Max width/height per image")
    parser.add_argument("--jpeg-quality", type=int, default=85)
    parser.add_argument("--jpeg-subsampling", type=int, default=0, help="0 = 4:4:4 (fidelity)")
    parser.add_argument("--force", action="store_true", help="Overwrite an existing output")
    parser.add_argument("--dry-run", action="store_true", help="Verify and report without writing")
    parser.add_argument("--allow-unignored", action="store_true", help="Ignore the Git-ignore guard")
    parser.add_argument("--allow-public", action="store_true", help="Allow a public/ path (not advised)")
    args = parser.parse_args(argv)
    report = run(args)
    summary = {"input": report["input"]["path"], "output": report["output"]["path"],
               "bytes": {key: report[key] for key in ("savings_bytes", "savings_percent")},
               "input_bytes": report["input"]["bytes"], "output_bytes": report["output"]["bytes"],
               "images": [{k: image[k] for k in ("index", "action", "before", "after")}
                          for image in report["images"]],
               "verification": report["verification"],
               "report_path": report["report_path"], "dry_run": report["dry_run"]}
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
