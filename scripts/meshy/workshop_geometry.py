"""One approved 5-credit untextured Workshop mesh; GET-only resume by default."""
import argparse
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

from pilot import glb_audit, save

ROOT = Path(__file__).resolve().parents[2]
ASSET = ROOT / "assets-src/meshy/execution-workshop"
OUT = ASSET / "geometry"
SOURCE_ID = "01a165c7-ddb4-7453-8364-c1edc5eba490"
TARGET_POLYCOUNT = 4000


def create_once(out, spec, source, api):
    config = spec["geometry_after_concept_approval"]
    request = dict(config["request_without_input_task_id"])
    request.pop("response_format", None)
    expected = {"ai_model": "meshy-t2.5", "model_type": "smart-topology",
        "target_polycount": TARGET_POLYCOUNT, "topology": "triangle", "should_texture": False,
        "enable_pbr": False, "target_formats": ["glb"], "alpha_thumbnail": True,
        "multi_view_thumbnails": True, "auto_size": False}
    if request != expected or config["advertised_credits"] != 5 or config["max_create_requests"] != 1:
        raise ValueError("Request exceeds authorized 5-credit geometry scope")
    if source.get("task_id") != SOURCE_ID or source.get("status") != "SUCCEEDED":
        raise ValueError("Expected successful approved Workshop concept")
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", SOURCE_ID):
        raise ValueError("Invalid source task ID")
    verified = api("/v1/image-to-image/" + SOURCE_ID)
    if verified.get("status") != "SUCCEEDED" or len(verified.get("image_urls", [])) != 1:
        raise ValueError("Live source must be SUCCEEDED with exactly one image")
    balance = api("/v1/balance")
    if balance["balance"] < 5:
        raise ValueError("Insufficient balance")
    request["input_task_id"] = SOURCE_ID
    out.mkdir(parents=True, exist_ok=True)
    try:
        with (out / "submission-lock.json").open("x") as f:
            json.dump({"request": request, "balance_before": balance,
                "warning": "POST may have been submitted. Never delete this marker to retry blindly."}, f)
    except FileExistsError:
        raise SystemExit("Submission locked; inspect account, no paid retry") from None
    response = api("/v1/image-to-3d", request)
    state = {"task_id": response["result"], "task_type": "image-to-3d",
        "request": request, "balance_before": balance, "status": "SUBMITTED"}
    save(out / "generation.json", state)
    return state


def download(url, path, max_bytes=50 * 1024 * 1024):
    if not isinstance(url, str) or not url.startswith("https://"):
        raise ValueError("HTTPS artifact URL required")
    if path.exists():
        return
    with urllib.request.urlopen(url, timeout=90) as response:
        blob = response.read(max_bytes + 1)
    if len(blob) > max_bytes:
        raise ValueError("Artifact too large")
    if path.suffix == ".glb":
        glb_audit(blob)
    elif not blob.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("Expected PNG thumbnail")
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(blob)
    tmp.replace(path)


def main():
    from dotenv import dotenv_values
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate", action="store_true")
    args = parser.parse_args()
    key = dotenv_values(Path.home() / ".hermes/.env", interpolate=False).get("MESHY_API_KEY")
    if not key:
        raise SystemExit("Meshy key missing")

    def api(route, payload=None):
        req = urllib.request.Request("https://api.meshy.ai/openapi" + route,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=90) as response:
                return json.load(response)
        except urllib.error.HTTPError as e:
            raise SystemExit(f"Meshy HTTP {e.code}; no automatic retry") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            raise SystemExit("Network failure; POST outcome may be unknown. Inspect account, do not retry blindly") from None

    state_path = OUT / "generation.json"
    if not state_path.exists():
        if not args.generate:
            raise SystemExit("No task saved; --generate explicitly authorizes one mesh")
        create_once(OUT, json.loads((ASSET / "spec.json").read_text()),
            json.loads((ASSET / "generation.json").read_text()), api)
    state = json.loads(state_path.read_text())
    for _ in range(25):
        task = api("/v1/image-to-3d/" + state["task_id"])
        state.update({k: task[k] for k in ["status", "progress", "consumed_credits",
            "created_at", "finished_at"] if k in task})
        save(state_path, state)
        print(json.dumps({k: state.get(k) for k in
            ["task_id", "status", "progress", "consumed_credits"]}), flush=True)
        if task["status"] in ["SUCCEEDED", "FAILED", "CANCELED"]:
            break
        time.sleep(8)
    state["balance_after"] = api("/v1/balance")
    delta = state["balance_before"]["balance"] - state["balance_after"]["balance"]
    state["reconciliation"] = {"balance_delta": delta,
        "task_consumed_credits": state.get("consumed_credits"),
        "matches": delta == state.get("consumed_credits"),
        "note": "Concurrent account activity can affect balance delta."}
    save(state_path, state)
    if task["status"] == "SUCCEEDED":
        download(task["model_urls"]["glb"], OUT / "preview.glb")
        if task.get("thumbnail_url"):
            download(task["thumbnail_url"], OUT / "preview.png")
        for side in ["front", "right", "back", "left"]:
            if task.get("thumbnail_urls", {}).get(side):
                download(task["thumbnail_urls"][side], OUT / f"preview.{side}.png")
        audit = glb_audit((OUT / "preview.glb").read_bytes())
        save(OUT / "geometry-audit.json", audit)
        print(json.dumps(audit), flush=True)
    print(json.dumps({"balance_after": state["balance_after"],
        "reconciliation": state["reconciliation"]}), flush=True)
    if task["status"] in ["FAILED", "CANCELED"]:
        raise SystemExit("Task failed; no paid retry submitted")


if __name__ == "__main__":
    main()
