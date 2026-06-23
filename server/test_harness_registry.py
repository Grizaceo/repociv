"""RepoCiv — Harness Registry Python Loader Tests."""

import pytest
from harness_registry import (
    list_harnesses,
    get_harness,
    infer_harness_for_command,
    _reset_cache,
)
from routes.core import get_harness_by_id


@pytest.fixture(autouse=True)
def reset():
    _reset_cache()


# ── load / list ────────────────────────────────────────────────────────────────

def test_list_harnesses_returns_eight():
    all_h = list_harnesses()
    assert len(all_h) == 8
    ids = sorted(h["id"] for h in all_h)
    assert ids == sorted([
        "hermes-local",
        "openclaw-local",
        "claude-code-local",
        "codex-local",
        "cursor-local",
        "nemoclaw-sandbox",
        "local-cli",
        "reference-only",
    ])


def test_list_harnesses_returns_copy():
    a = list_harnesses()
    b = list_harnesses()
    assert a is not b
    assert a == b


# ── get_harness ───────────────────────────────────────────────────────────────

def test_get_harness_known():
    h = get_harness("reference-only")
    assert h is not None
    assert h["id"] == "reference-only"
    assert h["trustLevel"] == "reference_only"
    assert h["kind"] == "reference"
    assert h["transport"] == "none"


def test_get_harness_unknown():
    assert get_harness("does-not-exist") is None


def test_get_harness_hermes_local():
    h = get_harness("hermes-local")
    assert h is not None
    assert h["trustLevel"] == "local_cli"
    assert h["transport"] == "cli"
    assert "copy_command" in h["recoveryModes"]
    assert "inspect_repo" in h["allowedActions"]
    assert "send_message" in h["blockedActions"]
    assert h["recovery"]["copy_command"]["cwd"] == "~/.hermes"


# ── infer_harness_for_command ──────────────────────────────────────────────────

def test_infer_read_file_prefers_local_cli_over_reference():
    # Both local-cli and reference-only allow read_file.
    # local-cli has higher trust (privileged_external) so it wins.
    h = infer_harness_for_command("read_file")
    assert h is not None
    assert h["trustLevel"] == "privileged_external"


def test_infer_run_tests_skips_reference_only():
    h = infer_harness_for_command("run_tests")
    assert h is not None
    assert h["id"] != "reference-only"
    assert h["trustLevel"] != "reference_only"


def test_infer_delete_file_returns_local_cli():
    h = infer_harness_for_command("delete_file")
    assert h is not None
    assert h["id"] == "local-cli"
    assert h["trustLevel"] == "privileged_external"


def test_infer_unknown_action_returns_none():
    assert infer_harness_for_command("totally_unknown") is None


# ── trust level specifics ──────────────────────────────────────────────────────

def test_reference_only_has_no_recovery():
    h = get_harness("reference-only")
    assert h is not None
    assert h["recoveryModes"] == []
    assert "recovery" not in h or h["recovery"] is None


def test_nemoclaw_sandbox_is_sandboxed():
    h = get_harness("nemoclaw-sandbox")
    assert h is not None
    assert h["trustLevel"] == "sandboxed"
    assert h["transport"] == "http"
    assert "view_logs" in h["recoveryModes"]


# ── GET /harnesses/{id} route handler (regression: used to 500) ─────────────────
# bridge.py dispatches /harnesses/{id} to routes.core.get_harness_by_id, which
# did not exist → AttributeError → 500. These pin the 200/404 contract.

def test_get_harness_by_id_known_returns_200_bare_descriptor():
    status, body = get_harness_by_id({"harness_id": "hermes-local"})
    assert status == 200
    # 200 body is the bare descriptor (recoveryClient.getHarness consumes it directly)
    assert body["id"] == "hermes-local"
    assert "trustLevel" in body


def test_get_harness_by_id_unknown_returns_404_envelope_not_500():
    status, body = get_harness_by_id({"harness_id": "does-not-exist"})
    assert status == 404
    assert set(body.keys()) == {"error", "cause", "hint"}
    assert "does-not-exist" in body["error"]


def test_get_harness_by_id_missing_id_returns_404():
    # Trailing-slash path → bridge passes harness_id="". Must 404, never crash.
    status, body = get_harness_by_id({"harness_id": ""})
    assert status == 404
    assert set(body.keys()) == {"error", "cause", "hint"}


def test_get_harness_by_id_absent_ctx_key_returns_404():
    # Defensive: handler must not KeyError if ctx lacks harness_id entirely.
    status, body = get_harness_by_id({})
    assert status == 404
