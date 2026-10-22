"""Single paid preview, resumable reads, no automatic POST retry.

Run with the Hermes venv Python (python-dotenv installed). No secret output.
The asset stays outside public/ until human review and licensing clearance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assets-src/meshy/memory-archive"
BASE = "https://api.meshy.ai/openapi"


def save(path, value):
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n")
    temp.replace(path)


def glb_audit(blob):
    if len(blob) < 20:
        raise ValueError("Truncated GLB")
    magic, version, length = struct.unpack_from("<4sII", blob)
    if magic != b"glTF" or version != 2 or length != len(blob):
        raise ValueError("Invalid GLB header")
    size, kind = struct.unpack_from("<II", blob, 12)
    if kind != 0x4E4F534A or 20 + size > len(blob):
        raise ValueError("Invalid GLB JSON chunk")
    doc = json.loads(blob[20:20 + size])
    if any("uri" in x for x in doc.get("buffers", [])):
        raise ValueError("External buffer reference")
    if any("uri" in x for x in doc.get("images", [])):
        raise ValueError("External image reference")
    triangles = 0
    for mesh in doc.get("meshes", []):
        for prim in mesh["primitives"]:
            if prim.get("mode", 4) != 4:
                raise ValueError("Non-triangle primitive needs manual review")
            accessor = prim.get("indices", prim["attributes"]["POSITION"])
            count = doc["accessors"][accessor]["count"]
            if count % 3:
                raise ValueError("Triangle primitive count not divisible by 3")
            triangles += count // 3
    if not triangles:
        raise ValueError("Empty geometry")
    return {"bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
            "meshes": len(doc.get("meshes", [])), "triangles": triangles,
            "materials": len(doc.get("materials", [])),
            "scope": "structural preflight only; not full glTF validation or visual QA"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate", action="store_true", help="Allow ONE paid preview")
    args = parser.parse_args()
    from dotenv import dotenv_values
    key = os.getenv("MESHY_API_KEY") or dotenv_values(
        Path.home() / ".hermes/.env", interpolate=False).get("MESHY_API_KEY")
    if not key:
        raise SystemExit("MESHY_API_KEY missing")

    def api(route, payload=None):
        req = urllib.request.Request(BASE + route,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raise SystemExit(f"Meshy HTTP {exc.code}; no automatic retry") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            raise SystemExit("Network failure; a POST outcome may be unknown. Inspect account before retrying.") from None

    state_path = OUT / "generation.json"
    if not state_path.exists():
        if not args.generate:
            raise SystemExit("No task. --generate explicitly permits one paid request.")
        spec = json.loads((OUT / "spec.json").read_text())
        if len(spec["request"]["prompt"]) > 800:
            raise SystemExit("Prompt exceeds 800 characters")
        if spec["budget"]["max_create_requests"] != 1 or spec["budget"]["auto_refine"]:
            raise SystemExit("Pilot permits exactly one preview and no auto refine")
        balance = api("/v1/balance")
        if balance["balance"] < spec["budget"]["advertised_preview_credits"]:
            raise SystemExit("Insufficient balance")
        # O_EXCL prevents concurrent double spend; deliberately retained on failure.
        try:
            with (OUT / "submission-lock.json").open("x") as f:
                json.dump({"balance_before": balance, "state": "POST may have been sent; do not retry blindly"}, f)
        except FileExistsError:
            raise SystemExit("Submission lock exists. Inspect the account; do not delete it to retry blindly.") from None
        result = api("/v2/text-to-3d", spec["request"])
        task_id = result["result"]
        save(state_path, {"task_id": task_id, "balance_before": balance,
                          "request": spec["request"], "status": "SUBMITTED"})
    state = json.loads(state_path.read_text())
    task = api("/v2/text-to-3d/" + state["task_id"])
    state.update({name: task[name] for name in
                  ("status", "progress", "consumed_credits", "created_at", "finished_at") if name in task})
    state["balance_after_read"] = api("/v1/balance")
    consumed = state.get("consumed_credits")
    delta = state["balance_before"]["balance"] - state["balance_after_read"]["balance"]
    state["reconciliation"] = {
        "balance_delta": delta, "task_consumed_credits": consumed,
        "matches": consumed is not None and delta == consumed,
        "note": "Other account activity can change the balance independently."}
    if consumed is not None and (delta != consumed or consumed != 5):
        print("WARNING: balance/task cost differs from the 5-credit pilot; inspect account.")
    save(state_path, state)
    if task["status"] == "SUCCEEDED":
        for name, url in (("preview.glb", task["model_urls"]["glb"]),
                          ("preview.png", task.get("thumbnail_url"))):
            path = OUT / name
            if url and not path.exists():
                if not url.startswith("https://"):
                    raise ValueError("Non-HTTPS download refused")
                with urllib.request.urlopen(url, timeout=90) as response:
                    blob = response.read(50 * 1024 * 1024 + 1)
                if len(blob) > 50 * 1024 * 1024:
                    raise ValueError("Download exceeds pilot 50 MiB limit")
                if name.endswith(".glb"):
                    save(OUT / "geometry-audit.json", glb_audit(blob))
                path.write_bytes(blob)
        if (OUT / "preview.glb").exists():
            save(OUT / "geometry-audit.json", glb_audit((OUT / "preview.glb").read_bytes()))
    print(json.dumps({k: state.get(k) for k in
        ("task_id", "status", "progress", "consumed_credits", "balance_after_read")}, indent=2))
    if task["status"] in ("FAILED", "CANCELED"):
        raise SystemExit("Task did not succeed; no retry generated")


if __name__ == "__main__":
    main()
