"""One approved 10-credit Observatory texture refine; GET-only resume after save."""
import argparse
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

from pilot import glb_audit, save
from workshop_geometry import download

ROOT = Path(__file__).resolve().parents[2]
ASSET = ROOT / "assets-src/meshy/observatory"
OUT = ASSET / "textured"
SOURCE_ID = "01a165f2-17f0-76cc-83ab-4fc6d267e41e"


def create_once(out, spec, api):
    config = spec["texturing_after_geometry_approval"]
    request = dict(config["request"])
    expected = {"ai_model": "meshy-7", "input_task_id": SOURCE_ID, "enable_original_uv": False, "enable_pbr": True,
        "texture_resolution": "2k", "target_formats": ["glb"],
        "alpha_thumbnail": True}
    if set(request) != set(expected) | {"text_style_prompt"} or any(request.get(k) != v for k, v in expected.items()) or not 1 <= len(request.get("text_style_prompt", "")) <= 800:
        raise ValueError("Request exceeds authorized 10-credit texture scope")
    if config["advertised_credits"] != 10 or config["max_create_requests"] != 1:
        raise ValueError("Only the approved single 10-credit refine is allowed")
    geometry = api("/v1/image-to-3d/" + SOURCE_ID)
    if geometry.get("status") != "SUCCEEDED":
        raise ValueError("Expected SUCCEEDED approved geometry to refine")
    balance = api("/v1/balance")
    if balance["balance"] < 10:
        raise ValueError("Insufficient balance")
    out.mkdir(parents=True, exist_ok=True)
    try:
        with (out / "retexture-submission-lock.json").open("x") as f:
            json.dump({"request": request, "balance_before": balance,
                "warning": "POST may have been submitted. Never delete this marker to retry blindly."}, f)
    except FileExistsError:
        raise SystemExit("Submission locked; inspect account, no paid retry") from None
    response = api("/v1/retexture", request)
    state = {"task_id": response["result"], "task_type": "retexture",
        "request": request, "balance_before": balance, "status": "SUBMITTED"}
    save(out / "generation.json", state)
    return state


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
            raise SystemExit("No task saved; --generate explicitly authorizes one refine")
        create_once(OUT, json.loads((ASSET / "spec.json").read_text()), api)
    state = json.loads(state_path.read_text())
    task = {}
    for _ in range(30):
        task = api("/v1/retexture/" + state["task_id"])
        state.update({k: task[k] for k in ["status", "progress", "consumed_credits",
            "created_at", "finished_at"] if k in task})
        save(state_path, state)
        print(json.dumps({k: state.get(k) for k in
            ["task_id", "status", "progress", "consumed_credits"]}), flush=True)
        if task["status"] in ["SUCCEEDED", "FAILED", "CANCELED"]:
            break
        time.sleep(10)
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
        audit = glb_audit((OUT / "preview.glb").read_bytes())
        if audit["materials"] < 1:
            raise SystemExit("Textured GLB has no materials; inspect task") from None
        save(OUT / "texture-audit.json", audit)
        print(json.dumps(audit), flush=True)
    print(json.dumps({"balance_after": state["balance_after"],
        "reconciliation": state["reconciliation"]}), flush=True)
    if task["status"] in ["FAILED", "CANCELED"]:
        raise SystemExit("Task failed; no paid retry submitted")


if __name__ == "__main__":
    main()
