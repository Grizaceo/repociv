"""Single authorized Workshop concept. Never retry POST; resume by saved task ID."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

from pilot import save

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assets-src/meshy/execution-workshop"


def create_once(out, spec, api):
    """Exclusive marker survives ambiguous outcomes; no URLs or encoded images persisted."""
    concept = spec["concept"]
    if concept["max_create_requests"] != 1:
        raise ValueError("Exactly one concept is allowed")
    request = dict(concept["request_without_reference_paths"])
    request.pop("response_format", None)  # MCP formatting option, not an API parameter.
    if request["ai_model"] != "nano-banana-pro" or concept["advertised_credits"] != 9:
        raise ValueError("Only the approved 9-credit Nano Banana Pro concept is allowed")
    refs = []
    fingerprints = []
    for name in concept["reference_relative_paths"]:
        p = ROOT / name
        blob = p.read_bytes()
        if p.suffix.lower() != ".png" or not blob.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Expected PNG reference")
        if len(blob) > 20 * 1024 * 1024:
            raise ValueError("Reference too large")
        refs.append("data:image/png;base64," + base64.b64encode(blob).decode("ascii"))
        fingerprints.append({"path": name, "sha256": hashlib.sha256(blob).hexdigest()})
    if not 1 <= len(refs) <= 5:
        raise ValueError("One to five references required")
    balance = api("/v1/balance")
    if balance["balance"] < 9:
        raise ValueError("Insufficient balance")
    try:
        with (out / "submission-lock.json").open("x") as f:
            json.dump({"balance_before": balance, "references": fingerprints,
                       "warning": "POST outcome may be unknown; never delete to retry blindly"}, f)
    except FileExistsError:
        raise SystemExit("Submission locked; inspect account, do not retry") from None
    request["reference_image_urls"] = refs
    response = api("/v1/image-to-image", request)
    state = {"task_id": response["result"], "task_type": "image-to-image",
             "balance_before": balance, "references": fingerprints,
             "request_without_reference_data": concept["request_without_reference_paths"]}
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
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise SystemExit(f"Meshy HTTP {e.code}; no automatic retry") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            raise SystemExit("Network failure; inspect account before retrying POST") from None

    state_path = OUT / "generation.json"
    if not state_path.exists():
        if not args.generate:
            raise SystemExit("No task saved. Explicit --generate is required")
        create_once(OUT, json.loads((OUT / "spec.json").read_text()), api)
    state = json.loads(state_path.read_text())
    for _ in range(30):
        task = api("/v1/image-to-image/" + state["task_id"])
        state.update({k: task[k] for k in
                      ["status", "progress", "consumed_credits", "created_at", "finished_at"]
                      if k in task})
        save(state_path, state)
        print(json.dumps({k: state.get(k) for k in
                          ["task_id", "status", "progress", "consumed_credits"]}), flush=True)
        if task["status"] in ["SUCCEEDED", "FAILED", "CANCELED"]:
            break
        time.sleep(6)
    state["balance_after"] = api("/v1/balance")
    delta = state["balance_before"]["balance"] - state["balance_after"]["balance"]
    state["reconciliation"] = {"balance_delta": delta,
        "task_consumed_credits": state.get("consumed_credits"),
        "matches": delta == state.get("consumed_credits")}
    save(state_path, state)
    if task["status"] == "SUCCEEDED":
        urls = task.get("image_urls", [])
        if len(urls) != 1 or not urls[0].startswith("https://"):
            raise SystemExit("Expected exactly one HTTPS image; inspect task")
        with urllib.request.urlopen(urls[0], timeout=90) as r:
            blob = r.read(30 * 1024 * 1024 + 1)
        if len(blob) > 30 * 1024 * 1024:
            raise SystemExit("Image too large")
        (OUT / "preview.png").write_bytes(blob)
        print("Downloaded concept preview.png", flush=True)
    print(json.dumps({"balance_after": state["balance_after"],
                      "reconciliation": state["reconciliation"]}), flush=True)
    if task["status"] in ["FAILED", "CANCELED"]:
        raise SystemExit("Task failed; no paid retry submitted")


if __name__ == "__main__":
    main()
