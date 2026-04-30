"""Tests for reconcile.py — cross-layer state reconciliation."""
from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path

import server.locks as _locks
import server.sessions as _sessions
import server.run_state as _run_state
import server.workspace_state as _ws
import server.event_store as _es
import server.reconcile as _reconcile


def _setup_stores(tmp: str) -> Path:
    """Initialize all stores under a temp directory."""
    base = Path(tmp) / "store"
    _es.init(base)
    _sessions.init(base)
    _run_state.init(base)
    _ws.init(base)
    return base


def test_check_run_consistency_ok():
    with tempfile.TemporaryDirectory() as tmp:
        _setup_stores(tmp)
        _run_state.save("run-1", {"unitId": "unit-1", "status": "running"})
        _sessions.get_or_create("unit-1", defaults={"lastMissionId": "run-1"})
        result = _reconcile.check_run_consistency("run-1")
        assert result.ok
        assert result.issues == []


def test_check_run_consistency_missing():
    with tempfile.TemporaryDirectory() as tmp:
        _setup_stores(tmp)
        result = _reconcile.check_run_consistency("nonexistent")
        assert not result.ok
        assert any("missing" in i for i in result.issues)


def test_check_session_consistency_ok():
    with tempfile.TemporaryDirectory() as tmp:
        _setup_stores(tmp)
        _sessions.append_message("unit-2", "user", "hello")
        result = _reconcile.check_session_consistency("unit-2")
        assert result.ok


def test_check_session_message_count_mismatch():
    with tempfile.TemporaryDirectory() as tmp:
        _setup_stores(tmp)
        # Create session but inject a fake high messageCount
        sess = _sessions.get_or_create("unit-3")
        sess["messageCount"] = 99
        _sessions.save("unit-3", sess)
        result = _reconcile.check_session_consistency("unit-3")
        assert not result.ok
        assert any("messageCount" in i for i in result.issues)


def test_check_workspace_consistency_ok():
    with tempfile.TemporaryDirectory() as tmp:
        _setup_stores(tmp)
        _ws.add_active_mission("ws-1", "run-ws1")
        _run_state.save("run-ws1", {"unitId": "unit-ws1", "status": "running"})
        result = _reconcile.check_workspace_consistency("ws-1")
        assert result.ok


def test_check_workspace_consistency_terminal_mission():
    with tempfile.TemporaryDirectory() as tmp:
        _setup_stores(tmp)
        _ws.add_active_mission("ws-2", "run-ws2")
        _run_state.save("run-ws2", {"unitId": "unit-ws2", "status": "completed"})
        result = _reconcile.check_workspace_consistency("ws-2")
        assert not result.ok
        assert any("terminal" in i for i in result.issues)


def test_check_workspace_consistency_missing_run():
    with tempfile.TemporaryDirectory() as tmp:
        _setup_stores(tmp)
        _ws.add_active_mission("ws-3", "run-gone")
        result = _reconcile.check_workspace_consistency("ws-3")
        assert not result.ok
        assert any("run_state is missing" in i for i in result.issues)


def test_rebuild_workspace_state():
    with tempfile.TemporaryDirectory() as tmp:
        base = _setup_stores(tmp)

        # Manually create a session that belongs to "repos/myproj"
        sessions_dir = base / "sessions" / "unit-rb"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        canonical = {
            "unitId": "unit-rb",
            "workingDirectory": "repos/myproj",
            "messageCount": 5,
            "inputChars": 100,
            "outputChars": 200,
        }
        (sessions_dir / "canonical.json").write_text(json.dumps(canonical))

        # Also create transcript to avoid messageCount mismatch
        (sessions_dir / "transcript.jsonl").write_text(
            json.dumps({"ts": "2026-01-01T00:00:00Z", "role": "user", "content": "x"}) + "\n"
        )

        # workspace_state should NOT exist yet
        assert _ws.load("repos/myproj") is None

        result = _reconcile.rebuild_workspace_state("repos/myproj")
        assert result.rebuilt
        ws = _ws.load("repos/myproj")
        assert ws is not None
        assert ws["resourceUsage"]["totalMessages"] == 5


def test_rebuild_run_state():
    with tempfile.TemporaryDirectory() as tmp:
        _setup_stores(tmp)

        # Inject events
        now = time.time()
        events = [
            {"type": "CommandCreated", "commandId": "run-rebuild", "timestamp": now,
             "data": {"unitId": "unit-rebuild", "harnessId": "test-harness"}},
            {"type": "CommandStarted", "commandId": "run-rebuild", "timestamp": now + 1,
             "data": {}},
            {"type": "AgentOutputChunk", "commandId": "run-rebuild", "timestamp": now + 2,
             "data": {"text": "hello world"}},
            {"type": "CommandCompleted", "commandId": "run-rebuild", "timestamp": now + 3,
             "data": {"result": "ok"}},
        ]
        for e in events:
            _es._append(e)

        result = _reconcile.rebuild_run_state("run-rebuild")
        assert result.rebuilt
        state = _run_state.load("run-rebuild")
        assert state is not None
        assert state["status"] == "completed"
        assert state["harnessId"] == "test-harness"


def test_get_full_status():
    with tempfile.TemporaryDirectory() as tmp:
        _setup_stores(tmp)
        _sessions.get_or_create("unit-fs", defaults={"workingDirectory": "ws-fs",
                                                       "lastMissionId": "run-fs"})
        _run_state.save("run-fs", {"unitId": "unit-fs", "status": "running"})
        _ws.get_or_create("ws-fs")
        _ws.add_active_mission("ws-fs", "run-fs")

        status = _reconcile.get_full_status(workspace_id="ws-fs")
        assert status["workspace"] is not None
        assert status["session"] is not None
        assert status["run"] is not None
        assert status["run"]["status"] == "running"


def test_find_orphaned_runs():
    with tempfile.TemporaryDirectory() as tmp:
        _setup_stores(tmp)

        # run_state exists but no workspace tracks it
        _run_state.save("orphan-1", {"unitId": "orphan-unit", "status": "completed"})
        _sessions.get_or_create("orphan-unit", defaults={"workingDirectory": ""})

        orphans = _reconcile.find_orphaned_runs()
        assert "orphan-1" in orphans


def test_full_reconcile():
    with tempfile.TemporaryDirectory() as tmp:
        base = _setup_stores(tmp)
        _ws.get_or_create("ws-full")
        _ws.add_active_mission("ws-full", "run-ok")
        _run_state.save("run-ok", {"unitId": "unit-ok", "status": "running"})
        _sessions.get_or_create("unit-ok", defaults={"workingDirectory": "ws-full",
                                                       "lastMissionId": "run-ok"})

        result = _reconcile.full_reconcile("ws-full")
        # Should have no critical issues
        critical = [i for i in result.issues if "missing" in i.lower() or "terminal" in i.lower()]
        assert len(critical) == 0
