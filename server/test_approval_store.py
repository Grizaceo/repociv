"""Tests for server/approval_store.py — permissions (0600) and TTL pruning.

Covers:
  1. add_approval persists approvals.json with mode 0600 (owner-only)
  2. add_approval stamps expires_at (default 24h, env-configurable)
  3. expired pendings are pruned on reload and absent from get_approvals()
  4. legacy material without expires_at survives reload (no data loss)
  5. pop_approval single-use still works (no regression)
  6. mission cascade removes only matching pendings
"""
from __future__ import annotations

import importlib
import json
import time
from pathlib import Path

import pytest

from server import approval_store as store


@pytest.fixture
def cfg_dir(isolated_approval_store: Path) -> Path:
    """Use the shared fixture that restores environment and singleton state."""
    return isolated_approval_store


def _approvals_path(cfg_dir: Path) -> Path:
    return cfg_dir / "approvals.json"


def _cmd(cmd_id: str) -> dict:
    return {"id": cmd_id, "type": "deploy", "target": "prod", "risk": "high"}


# ── 1. Permisos 0600 ─────────────────────────────────────────────────────────

class TestPermissions:
    def test_add_approval_writes_0600(self, cfg_dir: Path) -> None:
        store.add_approval(_cmd("cmd-1"))
        path = _approvals_path(cfg_dir)
        assert path.exists()
        assert oct(path.stat().st_mode)[-3:] == "600", (
            f"approvals.json must be owner-only, got "
            f"{oct(path.stat().st_mode)[-3:]}"
        )

    def test_no_tmp_file_left_behind(self, cfg_dir: Path) -> None:
        store.add_approval(_cmd("cmd-1"))
        leftovers = list(cfg_dir.glob("approvals.json*"))
        assert leftovers == [_approvals_path(cfg_dir)]


# ── 2. TTL stamping ──────────────────────────────────────────────────────────

class TestTTLStamp:
    def test_expires_at_stamped(self, cfg_dir: Path) -> None:
        before = time.time()
        store.add_approval(_cmd("cmd-1"))
        after = time.time()
        raw = json.loads(_approvals_path(cfg_dir).read_text())
        exp = raw["cmd-1"]["expires_at"]
        assert before + 86400 <= exp <= after + 86400

    def test_explicit_expires_at_not_overwritten(
        self, cfg_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        importlib.reload(store)
        cmd = _cmd("cmd-1")
        cmd["expires_at"] = time.time() + 12345
        store.add_approval(cmd)
        raw = json.loads(_approvals_path(cfg_dir).read_text())
        assert raw["cmd-1"]["expires_at"] == cmd["expires_at"]

    def test_env_ttl_configurable(
        self, cfg_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        with monkeypatch.context() as mp:
            mp.setenv("REPOCIV_APPROVAL_TTL_S", "60")
            reloaded = importlib.reload(store)
            assert reloaded._APPROVAL_TTL_S == 60
            before = time.time()
            reloaded.add_approval(_cmd("cmd-1"))
            after = time.time()
            raw = json.loads(_approvals_path(cfg_dir).read_text())
            exp = raw["cmd-1"]["expires_at"]
            assert before + 60 <= exp <= after + 60


# ── 3. Pruning de expirados ──────────────────────────────────────────────────

class TestTTLPruning:
    def test_expired_not_returned_after_reload(self, cfg_dir: Path) -> None:
        store.add_approval(_cmd("alive"))
        # Inject an already-expired pending directly to disk.
        path = _approvals_path(cfg_dir)
        raw = json.loads(path.read_text())
        raw["dead"] = _cmd("dead")
        raw["dead"]["expires_at"] = time.time() - 10
        path.write_text(json.dumps(raw))

        importlib.reload(store)
        ids = {c["id"] for c in store.get_approvals()}
        assert "dead" not in ids, "expired pending survived reload"
        assert "alive" in ids

    def test_expired_pop_returns_none(self, cfg_dir: Path) -> None:
        path = _approvals_path(cfg_dir)
        raw = {"dead": _cmd("dead")}
        raw["dead"]["expires_at"] = time.time() - 10
        path.write_text(json.dumps(raw))

        importlib.reload(store)
        assert store.pop_approval("dead") is None

    def test_legacy_without_expires_at_survives(self, cfg_dir: Path) -> None:
        """Pendings written before this change carry no expires_at — pruning
        must not destroy them (fail-open on missing field)."""
        path = _approvals_path(cfg_dir)
        raw = {"legacy": _cmd("legacy")}  # no expires_at
        path.write_text(json.dumps(raw))

        importlib.reload(store)
        ids = {c["id"] for c in store.get_approvals()}
        assert "legacy" in ids


# ── 4. Cascade de cancel por misión (M1) ─────────────────────────────────────

def _spawn_cmd(cmd_id: str, mission: str = "") -> dict:
    return {
        "id": cmd_id,
        "type": "subagent_spawn",
        "target": "MAIN",
        "payload": {"parentMissionId": mission} if mission else {},
        "created_by": "MAIN",
        "risk": "high",
    }


class TestMissionCascade:
    def test_cancel_mission_rejects_child_pendings(self, cfg_dir: Path) -> None:
        """Cancelling a parent mission must cascade-reject its
        waiting_approval children instead of leaving them orphaned."""
        store.add_approval(_spawn_cmd("c1", mission="m-1"))
        store.add_approval(_spawn_cmd("c2", mission="m-1"))
        store.add_approval(_spawn_cmd("c-other", mission="m-2"))

        rejected = store.cancel_mission("m-1")
        assert {r["id"] for r in rejected} == {"c1", "c2"}, (
            "cascade must reject exactly the mission's own pendings"
        )
        # Only the mission's children are gone; another mission's pending survives.
        assert {c["id"] for c in store.get_approvals()} == {"c-other"}

    def test_cancel_mission_is_single_use(self, cfg_dir: Path) -> None:
        store.add_approval(_spawn_cmd("c1", mission="m-1"))
        assert store.cancel_mission("m-1")
        assert store.cancel_mission("m-1") == [], "second cascade finds nothing"
        assert store.get_approvals() == []

    def test_cancel_mission_persists_to_disk(self, cfg_dir: Path) -> None:
        store.add_approval(_spawn_cmd("c1", mission="m-1"))
        store.cancel_mission("m-1")
        importlib.reload(store)
        assert store.get_approvals() == [], "cascade must survive a reload"

    def test_cancel_mission_unknown_mission_noop(self, cfg_dir: Path) -> None:
        store.add_approval(_spawn_cmd("c1", mission="m-1"))
        assert store.cancel_mission("does-not-exist") == []
        assert {c["id"] for c in store.get_approvals()} == {"c1"}

    def test_cancel_mission_empty_id_matches_nothing(self, cfg_dir: Path) -> None:
        """An empty mission id must never cascade (legacy pendings carry
        no parentMissionId; they must not be swept by a blank match)."""
        store.add_approval(_spawn_cmd("legacy"))  # no mission in payload
        store.add_approval(_spawn_cmd("c1", mission="m-1"))
        assert store.cancel_mission("") == []
        assert {c["id"] for c in store.get_approvals()} == {"legacy", "c1"}

    def test_cancel_mission_tolerates_non_dict_payload(self, cfg_dir: Path) -> None:
        """A corrupt pending (payload not a dict) must not crash the cascade
        nor be swept — the request-path handler can't 500 on bad disk state."""
        store.add_approval(_spawn_cmd("legacy"))
        store.add_approval({"id": "weird", "type": "x", "target": "t",
                            "payload": "not-a-dict"})
        store.add_approval(_spawn_cmd("c1", mission="m-1"))
        rejected = store.cancel_mission("m-1")
        assert {r["id"] for r in rejected} == {"c1"}
        assert {c["id"] for c in store.get_approvals()} == {"legacy", "weird"}


# ── 5. No-regresión: single-use ──────────────────────────────────────────────

class TestNoRegression:
    def test_pop_is_single_use(self, cfg_dir: Path) -> None:
        store.add_approval(_cmd("cmd-1"))
        assert store.pop_approval("cmd-1") is not None
        assert store.pop_approval("cmd-1") is None

    def test_pop_removes_from_get_approvals(self, cfg_dir: Path) -> None:
        store.add_approval(_cmd("cmd-1"))
        store.add_approval(_cmd("cmd-2"))
        store.pop_approval("cmd-1")
        ids = {c["id"] for c in store.get_approvals()}
        assert ids == {"cmd-2"}

    def test_reset_for_tests_clears_file(self, cfg_dir: Path) -> None:
        store.add_approval(_cmd("cmd-1"))
        store.reset_for_tests()
        assert not _approvals_path(cfg_dir).exists()
        assert store.get_approvals() == []
