"""Authorized family retexture batch: one locked 10-credit PBR pass each.

Every member sends its exact accepted GLB as a data URI with locally generated
UVs (xatlas) and keeps those UVs (enable_original_uv). Patio, Bóveda,
Laboratorio and Taller use repair-v003 (their Image-to-3D tasks hold rejected
geometry) and its normals. Portal, Plaza, dwelling, guild, coordinator, ranger
ranger, guardian and builder v002 use approved Image-to-3D GLBs, which carry no
normals: the v003 42-degree crease rule is applied without moving corners.
Forum and citadel use their settlement repair GLBs. Meshy's own normals are
never used: the approved Observatory's returned normals oppose their faces at
274 corners. Builder v001 (backpack silhouette) is refused; builder uses
geometry-v002. Observatorio and Archivo stay out of this batch.

Commands (one asset each; nothing paid happens without --generate):
    prepare   build texture-v001/source-uv.glb from the accepted GLB
              (needs xatlas: uv run --python 3.12 --with xatlas --with numpy --with pillow)
    run       resume the saved task with GETs; --generate permits ONE POST if none saved
    assemble  write texture-v001/textured.glb and geometry-check.json

Outputs stay in the ignored texture-v001/ folder beside the untouched sources.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

import numpy as np

from optimize_glb import build_glb, parse_glb
from pilot import glb_audit, save
from repair_family_geometry import crease_normals
from workshop_geometry import download

ROOT = Path(__file__).resolve().parents[2]
MESHY = ROOT / "assets-src/meshy"
OUT_NAME = "texture-v001"
REPAIRED = ("coordination-court", "artifact-vault", "research-laboratory", "execution-workshop")
SETTLEMENT_REPAIRED = ("city-forum", "city-citadel")
ORIGIN_TASKS = {
    "connection-gateway": "01a16732-69b9-7114-8398-c6cf4f09fcd1",
    "civic-plaza": "01a16736-33b7-7361-8100-5f4b3770736b",
    "city-dwelling": "01a16b99-8a62-7243-a07b-1bbe225009e7",
    "city-guild": "01a16bbe-28ef-76ab-bd23-54fa8a735f88",
    "city-forum": "01a16bbe-bd63-7637-835f-f4bf0b02a6f3",
    "city-citadel": "01a16bbf-2d09-72c7-a86e-1b7ecc8261e1",
    "unit-coordinator": "01a16c2d-f24c-7419-9b65-457f14a38c63",
    "unit-ranger": "01a16c2e-a612-7367-9ab1-56880c2ba01f",
    "unit-guardian": "01a16c2f-001b-756c-84a6-7cb26ba0e96a",
    "unit-builder": "01a16c58-bc70-74ea-a01a-506e7ac8ae57",
}
REVISED_GEOMETRY = {
    "unit-builder": "geometry-v002/preview.glb",
}
ASSETS = REPAIRED + tuple(ORIGIN_TASKS)
FIXED = {"ai_model": "meshy-7", "enable_pbr": True, "texture_resolution": "2k",
         "target_formats": ["glb"], "alpha_thumbnail": True}
TASK_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
COMPONENTS = {5121: "u1", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def sha256(blob):
    return hashlib.sha256(blob).hexdigest()


def asset_dir(asset):
    if asset not in ASSETS:
        raise ValueError("Asset is not in the authorized retexture batch")
    return MESHY / asset


def texture_folder(asset, spec=None):
    if spec is None:
        spec = json.loads((asset_dir(asset) / "spec.json").read_text())
    name = spec["texturing_after_geometry_approval"].get("output_dir", OUT_NAME)
    if not re.fullmatch(r"texture-v\d{3}", name):
        raise ValueError("output_dir must be texture-vNNN")
    return asset_dir(asset) / name


def accepted_source(asset, spec):
    """Path and pinned hash of the human-approved geometry; refuses anything else."""
    source = spec["texturing_after_geometry_approval"]["source"]
    if asset in REPAIRED:
        repair = spec["local_repair"]
        if (repair.get("human_geometry_approval") != "approved"
                or repair.get("candidate") != "repair-v003/preview.glb"
                or source["accepted_geometry"] != "repair-v003/preview.glb"
                or source["accepted_sha256"] != repair["approved_sha256"]
                or source["route"] != "model_url"):
            raise ValueError("Repaired members must use their approved repair-v003 GLB")
    elif asset in SETTLEMENT_REPAIRED:
        repair = spec["local_repair"]
        candidate = repair.get("candidate")
        if (source["route"] != "model_url" or source["origin_task_id"] != ORIGIN_TASKS[asset]
                or candidate not in (
                    "repair-v001/preview.glb",
                    "repair-v002/preview.glb",
                    "repair-v003/preview.glb",
                )
                or source["accepted_geometry"] != candidate
                or source["accepted_sha256"] != repair["candidate_sha256"]):
            raise ValueError("Settlement repaired members must use their pinned repair GLB")
    elif asset in REVISED_GEOMETRY:
        if (source["route"] != "model_url" or source["origin_task_id"] != ORIGIN_TASKS[asset]
                or source["accepted_geometry"] != REVISED_GEOMETRY[asset]):
            raise ValueError("Revised members must use their approved revision GLB")
    elif (source["route"] != "model_url" or source["origin_task_id"] != ORIGIN_TASKS[asset]
            or source["accepted_geometry"] != "geometry/preview.glb"):
        raise ValueError("Unrepaired members must use their approved Image-to-3D GLB")
    return asset_dir(asset) / source["accepted_geometry"], source["accepted_sha256"]


def read_mesh(blob):
    """One indexed triangle primitive as numpy arrays keyed by attribute name."""
    doc, binary = parse_glb(blob)
    if len(doc["meshes"]) != 1 or len(doc["meshes"][0]["primitives"]) != 1:
        raise ValueError("Expected one mesh with one primitive")
    primitive = doc["meshes"][0]["primitives"][0]
    if primitive.get("mode", 4) != 4 or "indices" not in primitive:
        raise ValueError("Expected an indexed triangle primitive")

    def accessor(index):
        a = doc["accessors"][index]
        view = doc["bufferViews"][a["bufferView"]]
        if "byteStride" in view or "sparse" in a or a.get("normalized"):
            raise ValueError("Unsupported accessor layout")
        width = WIDTH[a["type"]]
        data = np.frombuffer(binary, dtype=COMPONENTS[a["componentType"]], count=a["count"] * width,
                             offset=view.get("byteOffset", 0) + a.get("byteOffset", 0)).copy()
        return data.reshape(-1, width) if width > 1 else data

    attributes = {name: accessor(i) for name, i in primitive["attributes"].items()}
    faces = accessor(primitive["indices"]).astype(np.int64).reshape(-1, 3)
    if faces.max() >= len(attributes["POSITION"]):
        raise ValueError("Index out of range")
    return doc, binary, attributes, faces, primitive


def triangle_areas(points):
    return 0.5 * np.linalg.norm(np.cross(points[:, 1] - points[:, 0], points[:, 2] - points[:, 0]), axis=1)


def glb_from_arrays(position, normal, uv, faces, extra=None):
    """Minimal one-primitive GLB; ``extra`` carries material/texture JSON and image blobs."""
    chunks, views, accessors = [], [], []

    def add(array, target=None):
        blob = np.ascontiguousarray(array).tobytes()
        offset = sum(len(c) for c in chunks)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(blob)}
        if target:
            view["target"] = target
        views.append(view)
        chunks.append(blob + b"\0" * (-len(blob) % 4))
        return len(views) - 1

    for name, array in (("POSITION", position), ("NORMAL", normal), ("TEXCOORD_0", uv)):
        accessor = {"bufferView": add(array.astype("<f4"), 34962), "componentType": 5126,
                    "count": len(array), "type": "VEC3" if array.shape[1] == 3 else "VEC2"}
        if name == "POSITION":
            accessor["min"] = position.min(0).astype(float).tolist()
            accessor["max"] = position.max(0).astype(float).tolist()
        accessors.append(accessor)
    accessors.append({"bufferView": add(faces.astype("<u4").reshape(-1), 34963),
                      "componentType": 5125, "count": faces.size, "type": "SCALAR"})
    primitive = {"attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2}, "indices": 3, "mode": 4}
    doc = {"asset": {"version": "2.0", "generator": "RepoCiv family_texture.py"},
           "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0}],
           "meshes": [{"primitives": [primitive]}], "accessors": accessors, "bufferViews": views}
    if extra:
        images = []
        for mime, blob in extra["images"]:
            images.append({"bufferView": add(np.frombuffer(blob, np.uint8)), "mimeType": mime})
        doc.update(images=images, textures=extra["textures"], materials=extra["materials"])
        if extra.get("samplers"):
            doc["samplers"] = extra["samplers"]
        primitive["material"] = 0
    binary = b"".join(chunks)
    doc["buffers"] = [{"byteLength": len(binary)}]
    return build_glb(doc, binary)


def prepare(asset, spec):
    """Attach xatlas UVs to the accepted v003 mesh without moving any corner."""
    import xatlas

    source_path, approved = accepted_source(asset, spec)
    blob = source_path.read_bytes()
    if sha256(blob) != approved:
        raise ValueError("Accepted geometry hash mismatch")
    _, _, attributes, faces, _ = read_mesh(blob)
    expected = {"POSITION", "NORMAL"} if asset in REPAIRED else {"POSITION"}
    if set(attributes) != expected:
        raise ValueError(f"Expected accepted attributes {sorted(expected)}")
    if asset in REPAIRED:
        position, normal = attributes["POSITION"], attributes["NORMAL"]
        normal_source = "accepted repair-v003 normals"
    else:
        position, faces, normal = crease_normals(attributes["POSITION"], faces)
        faces = faces.astype(np.int64)
        normal_source = "local 42-degree crease normals (repair_family_geometry.crease_normals)"
    # Normal splits duplicate exact positions; weld them only for charting.
    unique, inverse = np.unique(position, axis=0, return_inverse=True)
    welded = inverse.reshape(-1)[faces].astype(np.uint32)
    atlas = xatlas.Atlas()
    atlas.add_mesh(unique, welded)
    chart_options = xatlas.ChartOptions()
    pack_options = xatlas.PackOptions()
    pack_options.resolution = 2048
    pack_options.padding = 6
    pack_options.bilinear = True
    pack_options.rotate_charts = True
    pack_options.bruteForce = True
    atlas.generate(chart_options, pack_options)
    if atlas.atlas_count != 1:
        raise ValueError("xatlas split the charts across several atlases")
    vmapping, uv_faces, uvs = atlas[0]
    if len(uv_faces) != len(faces) or not np.array_equal(unique[vmapping[uv_faces]], unique[welded]):
        raise ValueError("xatlas changed triangle order or corner positions")
    corner_uv = uvs[uv_faces].reshape(-1, 2)
    corner_vertex = faces.reshape(-1)
    keys = np.stack([corner_vertex, uv_faces.reshape(-1)], axis=1)
    unique_keys, new_index = np.unique(keys, axis=0, return_inverse=True)
    first = np.zeros(len(unique_keys), np.int64)
    first[new_index.reshape(-1)[::-1]] = np.arange(len(keys))[::-1]
    out_faces = new_index.reshape(-1, 3)
    out_position = position[corner_vertex[first]]
    out_normal = normal[corner_vertex[first]]
    out_uv = corner_uv[first].astype(np.float32)
    result = glb_from_arrays(out_position, out_normal, out_uv, out_faces)
    check = verify_against_source(blob, result)
    if not check["exact"]:
        raise ValueError("UV attachment altered accepted corners")
    folder = texture_folder(asset, spec)
    folder.mkdir(exist_ok=True)
    target = folder / "source-uv.glb"
    if target.exists() and target.read_bytes() != result:
        raise SystemExit("source-uv.glb exists with different bytes; keep it immutable")
    target.write_bytes(result)
    uv_area = triangle_areas(np.concatenate([out_uv[out_faces], np.zeros((len(out_faces), 3, 1))], 2))
    areas = triangle_areas(position[faces].astype(np.float64))
    collapsed = np.flatnonzero((uv_area < 1e-12) & (areas > 1e-12))
    audit = {"accepted_geometry": str(source_path.relative_to(ROOT)), "accepted_sha256": approved,
             "output": str(target.relative_to(ROOT)), "output_sha256": sha256(result),
             "bytes": len(result), "triangles": int(len(out_faces)), "vertices": int(len(out_position)),
             "uv_method": {"tool": "xatlas-python", "version": getattr(xatlas, "__version__", "0.0.11"),
                           "charts": int(atlas.chart_count), "atlas_utilization": float(atlas.utilization),
                           "resolution": 2048, "padding_px": 6},
             "uv_area_coverage": float(uv_area.sum()),
             "collapsed_uv_triangles": [{"triangle": int(i), "area": float(areas[i])} for i in collapsed],
             "normals": normal_source, "preservation": check,
             "scope": "positions and triangle order compared per corner with the accepted GLB; UVs are new"}
    save(folder / "uv-audit.json", audit)
    return audit


def corners(attributes, faces, name):
    return attributes[name][faces].astype(np.float64)


def match_triangles(src, src_faces, out, out_faces):
    """Snap candidate corners to accepted positions after a uniform bounds rescale.

    Returns per-triangle keys (sorted accepted-position ids) and per-corner ids, so
    duplicated shading/UV vertices compare by position, never by index.
    """
    s_pos, o_pos = src["POSITION"].astype(np.float64), out["POSITION"].astype(np.float64)
    s_min, s_max, o_min, o_max = s_pos.min(0), s_pos.max(0), o_pos.min(0), o_pos.max(0)
    scale = float((o_max - o_min).max() / (s_max - s_min).max())
    mapped = (o_pos - (o_min + o_max) / 2) / scale + (s_min + s_max) / 2
    reference, src_ids = np.unique(s_pos, axis=0, return_inverse=True)
    src_ids = src_ids.reshape(-1)
    tolerance = float(np.linalg.norm(s_max - s_min)) * 1e-5
    out_ids = np.empty(len(mapped), np.int64)
    distance = np.empty(len(mapped))
    for start in range(0, len(mapped), 1024):
        block = np.linalg.norm(mapped[start:start + 1024, None, :] - reference[None, :, :], axis=2)
        out_ids[start:start + 1024] = block.argmin(1)
        distance[start:start + 1024] = block.min(1)
    out_ids[distance > tolerance] = -1
    src_corner, out_corner = src_ids[src_faces], out_ids[out_faces]
    src_keys = [tuple(sorted(t)) for t in src_corner.tolist()]
    out_keys = [None if min(t) < 0 else tuple(sorted(t)) for t in out_corner.tolist()]
    return {"scale": scale, "tolerance": tolerance, "max_snap_distance": float(distance.max()),
            "src_corner": src_corner, "out_corner": out_corner, "src_keys": src_keys, "out_keys": out_keys}


def verify_against_source(source_blob, candidate_blob):
    """Per-corner comparison after optional uniform scale about the bounds center."""
    _, _, src, src_faces, _ = read_mesh(source_blob)
    _, _, out, out_faces, _ = read_mesh(candidate_blob)
    sp, op = corners(src, src_faces, "POSITION"), corners(out, out_faces, "POSITION")
    match = match_triangles(src, src_faces, out, out_faces)
    src_set, out_set = set(match["src_keys"]), set(k for k in match["out_keys"] if k is not None)
    unmatched = [i for i, k in enumerate(match["out_keys"]) if k is None or k not in src_set]
    missing = [i for i, k in enumerate(match["src_keys"]) if k not in out_set]
    src_area = triangle_areas(sp)
    exact = (len(src_faces) == len(out_faces) and match["scale"] == 1.0
             and np.array_equal(sp, op)
             and ("NORMAL" not in src or "NORMAL" not in out
                  or np.array_equal(corners(src, src_faces, "NORMAL"), corners(out, out_faces, "NORMAL"))))
    result = {"exact": bool(exact), "source_triangles": int(len(src_faces)),
              "candidate_triangles": int(len(out_faces)), "uniform_scale": match["scale"],
              "max_snap_distance_source_units": match["max_snap_distance"],
              "snap_tolerance_source_units": match["tolerance"],
              "unmatched_candidate_triangles": len(unmatched),
              "source_triangles_missing": [{"triangle": int(i), "area": float(src_area[i])} for i in missing],
              "visible_source_triangles_missing": int(sum(src_area[i] > 1e-12 for i in missing))}
    if "NORMAL" in out:
        n = out["NORMAL"].astype(np.float64)
        lengths = np.linalg.norm(n, axis=1)
        face = np.cross(op[:, 1] - op[:, 0], op[:, 2] - op[:, 0])
        face_len = np.linalg.norm(face, axis=1)
        ok = face_len > 1e-12
        unit_face = face[ok] / face_len[ok, None]
        dots = np.einsum("tcj,tj->tc", corners(out, out_faces, "NORMAL")[ok], unit_face)
        result["normals"] = {"min_length": float(lengths.min()), "max_length": float(lengths.max()),
                             "min_face_corner_dot": float(dots.min()),
                             "corners_dot_below_0": int((dots < 0).sum()),
                             "corners_dot_below_0_3": int((dots < 0.3).sum())}
    return result


def load_key():
    key = os.environ.get("MESHY_API_KEY")
    if key:
        return key
    env = Path.home() / ".hermes/.env"
    for line in env.read_text().splitlines() if env.exists() else []:
        match = re.fullmatch(r"\s*(?:export\s+)?MESHY_API_KEY\s*=\s*(['\"]?)(.*?)\1\s*", line)
        if match:
            return match.group(2)
    raise SystemExit("MESHY_API_KEY missing")


def build_request(asset, spec, folder):
    config = spec["texturing_after_geometry_approval"]
    if config["advertised_credits"] != 10 or config["max_create_requests"] != 1:
        raise ValueError("Only one 10-credit retexture per asset is authorized")
    request = dict(config["request"])
    prompt = request.pop("text_style_prompt", "")
    if not 1 <= len(prompt) <= 800:
        raise ValueError("Style prompt must be 1-800 characters")
    if request != dict(FIXED, enable_original_uv=True):
        raise ValueError("Request differs from the authorized retexture scope")
    source_path, approved = accepted_source(asset, spec)
    if sha256(source_path.read_bytes()) != approved:
        raise ValueError("Accepted geometry hash mismatch")
    request["text_style_prompt"] = prompt
    receipt = {"route": config["source"]["route"], "accepted_sha256": approved}
    audit = json.loads((folder / "uv-audit.json").read_text())
    blob = (folder / "source-uv.glb").read_bytes()
    if (audit["accepted_sha256"] != approved or audit["output_sha256"] != sha256(blob)
            or not audit["preservation"]["exact"]):
        raise ValueError("source-uv.glb is not the audited UV copy of the approved mesh")
    if verify_against_source(source_path.read_bytes(), blob)["exact"] is not True:
        raise ValueError("source-uv.glb corners differ from the approved mesh")
    request["model_url"] = "data:application/octet-stream;base64," + base64.b64encode(blob).decode()
    receipt.update(model_url_sha256=sha256(blob), model_url_bytes=len(blob))
    return request, receipt


def create_once(asset, spec, api):
    folder = texture_folder(asset, spec)
    request, receipt = build_request(asset, spec, folder)
    balance = api("/v1/balance")
    if balance["balance"] < 10:
        raise ValueError("Insufficient balance")
    recorded = {k: v for k, v in request.items() if k != "model_url"}
    folder.mkdir(exist_ok=True)
    try:
        with (folder / "retexture-submission-lock.json").open("x") as f:
            json.dump({"request": recorded, "source": receipt, "balance_before": balance,
                       "warning": "POST may have been submitted. Never delete this marker to retry blindly."}, f)
    except FileExistsError:
        raise SystemExit("Submission locked; inspect the account, no paid retry") from None
    response = api("/v1/retexture", request)
    task_id = response.get("result")
    if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id):
        raise SystemExit("POST returned no task id; lock retained, reconcile the account manually")
    state = {"task_id": task_id, "task_type": "retexture", "request": recorded, "source": receipt,
             "balance_before": balance, "status": "SUBMITTED"}
    save(folder / "generation.json", state)
    return state


def resume(asset, api, polls=60, wait=10, spec=None):
    folder = texture_folder(asset, spec)
    state_path = folder / "generation.json"
    state = json.loads(state_path.read_text())
    task = {}
    for attempt in range(polls):
        task = api("/v1/retexture/" + state["task_id"])
        state.update({k: task[k] for k in ("status", "progress", "consumed_credits",
                                          "created_at", "finished_at") if k in task})
        save(state_path, state)
        print(json.dumps({k: state.get(k) for k in ("task_id", "status", "progress", "consumed_credits")}),
              flush=True)
        if task.get("status") in ("SUCCEEDED", "FAILED", "CANCELED"):
            break
        if attempt + 1 < polls:
            time.sleep(wait)
    if task.get("status") not in ("SUCCEEDED", "FAILED", "CANCELED"):
        print("Task still running; resume later with GETs only", flush=True)
        return state
    state["balance_after"] = api("/v1/balance")
    delta = state["balance_before"]["balance"] - state["balance_after"]["balance"]
    state["reconciliation"] = {"balance_delta": delta, "task_consumed_credits": state.get("consumed_credits"),
                               "matches": delta == state.get("consumed_credits"),
                               "note": "Concurrent account activity can affect the balance delta."}
    save(state_path, state)
    if task["status"] == "SUCCEEDED":
        download(task["model_urls"]["glb"], folder / "meshy.glb", max_bytes=120 * 1024 * 1024)
        for name, url in (("meshy.png", task.get("thumbnail_url")),
                          ("meshy-alpha.png", task.get("alpha_thumbnail_url"))):
            if url:
                download(url, folder / name)
        save(folder / "texture-audit.json", glb_audit((folder / "meshy.glb").read_bytes()))
    else:
        raise SystemExit("Task did not succeed; no paid retry submitted")
    return state


def material_payload(doc, binary):
    """Copy the one Meshy material, its textures, samplers and embedded images."""
    if len(doc.get("materials", [])) != 1:
        raise ValueError("Expected exactly one Meshy material")
    images = []
    for image in doc.get("images", []):
        view = doc["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        images.append((image["mimeType"], binary[start:start + view["byteLength"]]))
    if doc.get("extensionsUsed") or doc.get("extensionsRequired"):
        raise ValueError("Meshy material uses glTF extensions; copy them deliberately")
    return {"images": images, "textures": doc.get("textures", []),
            "samplers": doc.get("samplers", []), "materials": doc["materials"]}


def assemble(asset, spec):
    """Final candidate: accepted corners and normals + Meshy UVs and PBR material."""
    folder = texture_folder(asset, spec)
    meshy_blob = (folder / "meshy.glb").read_bytes()
    source_path, approved = accepted_source(asset, spec)
    accepted_blob = source_path.read_bytes()
    if sha256(accepted_blob) != approved:
        raise ValueError("Accepted geometry hash mismatch")
    report = {"accepted_sha256": approved, "meshy_sha256": sha256(meshy_blob)}
    uv_blob = (folder / "source-uv.glb").read_bytes()
    doc, binary, out, out_faces, _ = read_mesh(meshy_blob)
    _, _, src, src_faces, _ = read_mesh(uv_blob)
    check = verify_against_source(uv_blob, meshy_blob)
    if check["unmatched_candidate_triangles"]:
        raise SystemExit("Meshy returned triangles that are not in the accepted mesh; inspect manually")
    match = match_triangles(src, src_faces, out, out_faces)
    sp = corners(src, src_faces, "POSITION")
    out_uv = corners(out, out_faces, "TEXCOORD_0")
    src_uv = corners(src, src_faces, "TEXCOORD_0")
    lookup = {}
    for t, k in enumerate(match["out_keys"]):
        lookup.setdefault(k, []).append(t)
    seen = {}
    chosen = np.empty((len(src_faces), 3, 2))
    taken = np.zeros(len(src_faces), bool)
    uv_delta = []
    for t, k in enumerate(match["src_keys"]):
        if k not in lookup:
            chosen[t] = src_uv[t]
            continue
        # Coincident twin faces pair up in order rather than sharing one chart.
        found = lookup[k][seen.get(k, 0) % len(lookup[k])]
        seen[k] = seen.get(k, 0) + 1
        ids = match["out_corner"][found].tolist()
        for c, position_id in enumerate(match["src_corner"][t].tolist()):
            chosen[t, c] = out_uv[found, ids.index(position_id)]
        taken[t] = True
        uv_delta.append(float(np.abs(chosen[t] - src_uv[t]).max()))
    area = triangle_areas(sp)
    if (~taken & (area > 1e-12)).any():
        raise SystemExit("Meshy dropped visible accepted triangles; inspect manually")
    src_normal = corners(src, src_faces, "NORMAL")
    flat_pos = sp.reshape(-1, 3).astype(np.float32)
    flat_normal = src_normal.reshape(-1, 3).astype(np.float32)
    flat_uv = chosen.reshape(-1, 2).astype(np.float32)
    packed = np.concatenate([flat_pos.view(np.uint32), flat_normal.view(np.uint32), flat_uv.view(np.uint32)], 1)
    unique, index = np.unique(packed, axis=0, return_inverse=True)
    faces = index.reshape(-1, 3)
    result = glb_from_arrays(unique[:, :3].view(np.float32), unique[:, 3:6].view(np.float32),
                             unique[:, 6:8].view(np.float32), faces, material_payload(doc, binary))
    report.update(method="accepted corners, prepared normals, Meshy per-corner UVs and material",
                  meshy_used_supplied_uvs=bool(uv_delta) and max(uv_delta) < 1e-4,
                  max_uv_difference_from_supplied=max(uv_delta) if uv_delta else None,
                  triangles_with_supplied_uv_fallback=int((~taken).sum()),
                  meshy_geometry_check=check)
    target = folder / "textured.glb"
    if target.exists() and target.read_bytes() != result:
        raise SystemExit("textured.glb exists with different bytes; keep candidates immutable")
    target.write_bytes(result)
    report.update(textured_sha256=sha256(result), textured_bytes=len(result),
                  accepted_geometry_check=verify_against_source(accepted_blob, result),
                  structure=glb_audit(result))
    save(folder / "geometry-check.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("asset", choices=ASSETS)
    parser.add_argument("command", choices=("prepare", "run", "assemble"))
    parser.add_argument("--generate", action="store_true", help="Permit ONE paid POST if no task is saved")
    args = parser.parse_args()
    spec = json.loads((asset_dir(args.asset) / "spec.json").read_text())
    if args.command == "prepare":
        print(json.dumps(prepare(args.asset, spec), indent=2))
        return
    if args.command == "assemble":
        print(json.dumps(assemble(args.asset, spec), indent=2))
        return
    key = load_key()

    def api(route, payload=None):
        req = urllib.request.Request("https://api.meshy.ai/openapi" + route,
                                     data=json.dumps(payload).encode() if payload is not None else None,
                                     headers={"Authorization": "Bearer " + key,
                                              "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raise SystemExit(f"Meshy HTTP {exc.code}; no automatic retry") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            raise SystemExit("Network failure; POST outcome may be unknown. "
                             "Inspect the account, do not retry blindly") from None

    if not (texture_folder(args.asset, spec) / "generation.json").exists():
        if not args.generate:
            raise SystemExit("No task saved; --generate explicitly authorizes one retexture")
        create_once(args.asset, spec, api)
    state = resume(args.asset, api, spec=spec)
    print(json.dumps({k: state.get(k) for k in ("task_id", "status", "consumed_credits",
                                                "balance_after", "reconciliation")}), flush=True)


if __name__ == "__main__":
    main()
