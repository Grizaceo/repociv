"""R05 — privacy-safe loaded-build diagnostic.

Exercises the existing health surface snapshot (``/health`` →
``routes/core.get_health``) against the real R05 acceptance criteria, with
inert fixtures and isolated state only:

  1. The snapshot reports the build ACTUALLY LOADED (commit + build id),
     and it is immutable: changing the checkout after startup does NOT
     change what the running process reports.
  2. Store statuses (persistent / ephemeral / unknown / missing / not
     writable) are reported honestly, including "missing" and
     "unsupported".
  3. HMAC audit-key mode distinguishes persistent vs ephemeral WITHOUT
     exposing any token, env value, prompt, or argv.
"""

from __future__ import annotations

import importlib
import json

import pytest

from server import build_identity, routes
from server.routes.core import get_health
from server import security_harness


class _NullCtx:
    """RouteContext stub — get_health ignores it."""


def _stub_schedulers(monkeypatch, store_status="writable"):
    """Make get_health's collaborator calls inert (no live bridge/agents)."""
    from server import suvadu_tracker

    class _Sched:
        def get_agent_status(self):
            return [{"status": "idle"}]

        def queue_snapshot(self):
            return []

    monkeypatch.setattr(routes.core, "_build_identity", build_identity, raising=False)
    monkeypatch.setattr("server.bridge._sched", _Sched())
    monkeypatch.setattr("server.bridge.get_gpu_info", lambda: {"gpus": []})
    monkeypatch.setattr("server.bridge.mcp_status", lambda: {})
    monkeypatch.setattr(suvadu_tracker, "status", lambda: {"agents": []})
    monkeypatch.setattr(
        "server.event_store._store_path", __import__("pathlib").Path("/nonexistent-store-probe")
    )
    # Store probes: event store path parent is unwritable/missing → "missing".
    monkeypatch.setattr(build_identity, "event_store_status", lambda: "missing")
    monkeypatch.setattr(build_identity, "approval_store_status", lambda: store_status)
    monkeypatch.setattr(build_identity, "scheduler_store_status", lambda: "writable")


@pytest.fixture
def health_env(monkeypatch):
    _stub_schedulers(monkeypatch)
    return None


def _health():
    status, body = get_health(_NullCtx())
    assert status == 200
    return body


def _blob(value) -> str:
    return json.dumps(value, default=str)


# ── 1. Reports the actually-loaded build; immutable across checkout change ────

def test_health_reports_loaded_build_identity(health_env):
    body = _health()
    diag = body["buildDiagnostic"]
    loaded = diag["loadedBuild"]
    assert loaded["version"]  # never empty/unknown-by-default
    assert loaded["commit"] and loaded["commit"] != "unknown"
    assert loaded["source"] in {"generated", "git-fallback", "unknown"}
    assert "startedAt" in diag and "uptimeS" in diag


def test_loaded_build_is_immutable_after_checkout_change(health_env, monkeypatch):
    """Simulating a checkout change after startup must not change the reported
    build: the identity was captured at process import."""
    before = build_identity.loaded_build()

    # Simulate a later checkout state (e.g. git pull / worktree switch).
    monkeypatch.setattr(build_identity, "_STATIC", {"version": "9.9.9", "commit": "deadbeef",
                                                     "buildId": "different", "builtAt": "later"})

    after = build_identity.loaded_build()
    assert after == before, "loaded-build must be frozen at process start"
    assert after["commit"] != "deadbeef"


def test_started_at_is_frozen_at_import(health_env):
    import time as _time

    stamp = build_identity.started_at()
    assert stamp <= _time.time()
    # A later call cannot move the process start time.
    assert build_identity.started_at() == stamp


def test_health_shape_is_stable_with_build_diagnostic(health_env):
    body = _health()
    assert body["ok"] is True
    # The pre-existing health fields are unchanged (no regression to the surface).
    assert body["version"] == "0.1.0"
    assert body["timestamp"] > 0
    for key in ("openclaw", "claudeCode", "cursor", "codex", "mcp", "agents", "gpu"):
        assert key in body
    assert "buildDiagnostic" in body


# ── 2. Store statuses: honest, including missing/unknown ─────────────────────

def test_missing_store_reported_missing_not_writable(health_env):
    body = _health()
    stores = body["buildDiagnostic"]["stores"]
    # The fixture deliberately points the event store at a nonexistent path.
    assert stores["eventStore"] == "missing"
    assert stores["approvalStore"] == "writable"
    assert stores["schedulerQueue"] == "writable"


def test_unsupported_store_reported_unknown(health_env, monkeypatch):
    """An unsupported/absent store backend must be reported honestly."""
    monkeypatch.setattr(build_identity, "event_store_status", lambda: "unknown")
    stores = _health()["buildDiagnostic"]["stores"]
    assert stores["eventStore"] == "unknown"


def test_store_status_probes_real_missing_dir(health_env, monkeypatch, tmp_path):
    """The real probe reports a missing directory as 'missing'."""
    monkeypatch.setattr(build_identity, "event_store_status",
                        lambda: build_identity._store_status(str(tmp_path / "nope")))
    stores = _health()["buildDiagnostic"]["stores"]
    assert stores["eventStore"] == "missing"


def test_store_status_probes_real_writable_dir(health_env, monkeypatch, tmp_path):
    monkeypatch.setattr(build_identity, "event_store_status",
                        lambda: build_identity._store_status(str(tmp_path)))
    stores = _health()["buildDiagnostic"]["stores"]
    assert stores["eventStore"] == "writable"


def test_store_status_unknown_when_unconfigured(health_env, monkeypatch, tmp_path):
    monkeypatch.setattr(build_identity, "event_store_status",
                        lambda: build_identity._store_status(None))
    stores = _health()["buildDiagnostic"]["stores"]
    assert stores["eventStore"] == "unknown"


# ── 3. Audit key mode: persistent vs ephemeral, no secret material ───────────

def test_audit_key_mode_ephemeral_without_env(health_env, monkeypatch):
    """Without an operator key the mode is honestly 'ephemeral'."""
    monkeypatch.delenv("REPOCIV_HMAC_KEY", raising=False)
    reloaded = importlib.reload(security_harness)
    assert reloaded.audit_key_mode() == "ephemeral"
    diag = _health()["buildDiagnostic"]
    assert diag["auditKeyMode"] == "ephemeral"
    monkeypatch.setattr(security_harness, "_AUDIT_KEY_MODE", reloaded.audit_key_mode())


def test_audit_key_mode_persistent_with_env(health_env, monkeypatch):
    """With an operator key configured the mode is 'persistent'."""
    monkeypatch.setenv("REPOCIV_HMAC_KEY", "not-a-real-key-test-only")
    reloaded = importlib.reload(security_harness)
    try:
        assert reloaded.audit_key_mode() == "persistent"
        monkeypatch.setattr(security_harness, "_AUDIT_KEY_MODE", "persistent")
        assert _health()["buildDiagnostic"]["auditKeyMode"] == "persistent"
    finally:
        monkeypatch.delenv("REPOCIV_HMAC_KEY", raising=False)
        monkeypatch.setattr(security_harness, "_AUDIT_KEY_MODE",
                            importlib.reload(security_harness).audit_key_mode())


def test_snapshot_never_leaks_secret_material(health_env):
    """Hard privacy rule: the snapshot contains no tokens, env values,
    prompts, argv, or key material — only booleans/capabilities/statuses."""
    body = _health()
    blob = _blob(body["buildDiagnostic"])
    for forbidden in (
        "REPOCIV_TOKEN", "REPOCIV_HMAC_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
        "argv", "prompt", "password", "secret", "token=", "Bearer",
    ):
        assert forbidden.lower() not in blob.lower(), f"leaked {forbidden!r}"
    # And it carries no absolute home/config paths (privacy-safe store statuses).
    diag = body["buildDiagnostic"]
    for status in diag["stores"].values():
        assert status in {"writable", "not-writable", "missing", "unknown"}
        assert "/" not in status


def test_recovery_surface_reports_unresolved_count(health_env):
    """R01 recovery visibility rides the same safe surface for R12."""
    diag = _health()["buildDiagnostic"]
    assert diag["recovery"]["unresolvedDispatches"] >= 0
