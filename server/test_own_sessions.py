"""Tests for own_sessions: disk snapshot + Hermes-lease liveness, fail-open."""

from __future__ import annotations

import json
from typing import Any

import pytest

from server import own_sessions as osn
from server import session_liveness as sl


@pytest.fixture()
def store(tmp_path, monkeypatch):
    (tmp_path / "MAIN").mkdir()
    (tmp_path / "MAIN" / "canonical.json").write_text(json.dumps({
        "unitId": "MAIN",
        "runtimeId": "hermes-local",
        "sessionKey": "main",
        "summary": "Dime Donde Estas",
        "repo": "formal-math-lab",
        "workingDirectory": "/w/formal-math-lab",
        "lastMissionId": "m1",
        "messageCount": 128,
        "inputChars": 145,
        "outputChars": 4941,
        "updatedAt": "2026-09-20T19:00:16Z",
    }))
    monkeypatch.setattr(osn, "_STORE_DIR", str(tmp_path))
    return tmp_path


def _patch_probe(monkeypatch, liveness: sl.Liveness) -> None:
    monkeypatch.setattr(sl, "probe", lambda *a, **k: liveness)


def test_snapshot_rebuilds_row_from_canonical(store, monkeypatch):
    _patch_probe(monkeypatch, sl.Liveness(ok=False))  # probe degraded → unknown
    snap = osn.snapshot()
    [row] = snap["agents"]
    assert row["unit"] == "MAIN"
    assert row["civ"] == "capital"
    assert row["unitType"] == "hero"  # hermes-local → hero
    assert row["cityId"] == "formal-math-lab"
    assert row["cityRepoPath"] == "/w/formal-math-lab"
    assert row["mission"] == "Dime Donde Estas"
    assert row["state"] == "unknown"
    assert snap["livenessOk"] is False


def test_snapshot_liveness_working_and_idle(store, monkeypatch):
    # Lease registry contains the native session id, pid alive → working.
    _patch_probe(monkeypatch, sl.Liveness(
        hermes_sessions=frozenset({"sess-123"}),
        agent_cwds=frozenset(),
        ok=True,
    ))
    snap = osn.snapshot()
    [row] = snap["agents"]
    assert row["state"] == "unknown"  # canonical has no nativeSessionId yet

    # With a native session id recorded, the lease decides.
    canonical = store / "MAIN" / "canonical.json"
    data = json.loads(canonical.read_text())
    data["nativeSessionId"] = "sess-123"
    canonical.write_text(json.dumps(data))
    assert osn.snapshot()["agents"][0]["state"] == "working"

    data["nativeSessionId"] = "sess-dead"
    canonical.write_text(json.dumps(data))
    assert osn.snapshot()["agents"][0]["state"] == "idle"


def test_snapshot_fail_open_on_broken_store(store, monkeypatch):
    (store / "BROKEN").mkdir()
    (store / "BROKEN" / "canonical.json").write_text("{not json")
    _patch_probe(monkeypatch, sl.Liveness(ok=False))
    snap = osn.snapshot()
    assert [r["unit"] for r in snap["agents"]] == ["MAIN"]


def test_snapshot_fail_open_when_probe_raises(store, monkeypatch):
    def boom(*a: Any, **k: Any) -> sl.Liveness:
        raise RuntimeError("no /proc")

    monkeypatch.setattr(osn._liveness, "probe", boom)
    snap = osn.snapshot()
    assert snap["agents"][0]["state"] == "unknown"
    assert snap["livenessOk"] is False


def test_unit_type_map(store, monkeypatch):
    canonical = store / "MAIN" / "runtime.json"  # (unused file, keep store clean)
    canonical.write_text("{}")
    _patch_probe(monkeypatch, sl.Liveness(ok=False))
    for runtime, want in [("claude", "claude"), ("codex", "codex"),
                          ("cursor", "cursor"), ("praetorian", "praetorian"),
                          ("hermes", "hero"), ("hermes:opus", "hero"), ("", "hero")]:
        data = json.loads((store / "MAIN" / "canonical.json").read_text())
        data["runtimeId"] = runtime
        (store / "MAIN" / "canonical.json").write_text(json.dumps(data))
        assert osn.snapshot()["agents"][0]["unitType"] == want, runtime


def test_store_dir_default():
    assert osn.store_dir().endswith("sessions")