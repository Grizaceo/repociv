"""Tests for workspace_state.py — workspace-level operational state store."""
from __future__ import annotations

import tempfile
from pathlib import Path

import server.workspace_state as ws


def test_init_creates_dir():
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store"
        ws.init(store)
        assert (store / "workspace-state").is_dir()


def test_get_or_create_defaults():
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store"
        ws.init(store)
        state = ws.get_or_create("repos/some-repo")
        assert state["workspaceId"] == "repos/some-repo"
        assert state["activeMissions"] == []
        assert state["runHistory"] == []
        assert state["resourceUsage"]["totalRuns"] == 0
        assert state["lastMissionId"] == ""
        assert "createdAt" in state
        assert "updatedAt" in state


def test_get_or_create_idempotent():
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store"
        ws.init(store)
        a = ws.get_or_create("ws-a")
        b = ws.get_or_create("ws-a")
        assert a == b


def test_save_and_load():
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store"
        ws.init(store)
        state = ws.get_or_create("ws-x")
        state["color"] = "blue"
        ws.save("ws-x", state)
        loaded = ws.load("ws-x")
        assert loaded is not None
        assert loaded["color"] == "blue"


def test_patch():
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store"
        ws.init(store)
        ws.patch("ws-p", x=1, y=2)
        loaded = ws.load("ws-p")
        assert loaded is not None
        assert loaded["x"] == 1
        assert loaded["y"] == 2
        # patch again
        ws.patch("ws-p", y=42)
        loaded2 = ws.load("ws-p")
        assert loaded2 is not None
        assert loaded2["x"] == 1
        assert loaded2["y"] == 42


def test_add_and_remove_active_mission():
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store"
        ws.init(store)
        ws.add_active_mission("ws-m", "m1")
        ws.add_active_mission("ws-m", "m2")
        active = ws.get_active_missions("ws-m")
        assert active == ["m1", "m2"]

        ws.remove_active_mission("ws-m", "m1")
        active_after = ws.get_active_missions("ws-m")
        assert active_after == ["m2"]

        # Check history
        history = ws.get_run_history("ws-m")
        assert len(history) == 1
        assert history[0]["missionId"] == "m1"


def test_resource_usage():
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store"
        ws.init(store)
        ws.update_resource_usage("ws-r", messages=3, input_chars=100, output_chars=200)
        ws.update_resource_usage("ws-r", messages=2, input_chars=50, output_chars=75)
        state = ws.load("ws-r")
        assert state is not None
        ru = state["resourceUsage"]
        assert ru["totalMessages"] == 5
        assert ru["totalInputChars"] == 150
        assert ru["totalOutputChars"] == 275


def test_list_workspaces():
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store"
        ws.init(store)
        ws.get_or_create("a/b")
        ws.get_or_create("c/d")
        ws.get_or_create("e/f")
        names = ws.list_workspaces()
        assert "a/b" in names
        assert "c/d" in names
        assert "e/f" in names


def test_load_missing_returns_none():
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store"
        ws.init(store)
        assert ws.load("nonexistent") is None


def test_add_active_mission_with_meta():
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store"
        ws.init(store)
        ws.add_active_mission("ws-meta", "m99", {"kind": "patch", "priority": 1})
        state = ws.load("ws-meta")
        assert state is not None
        assert state["mission_m99_meta"]["kind"] == "patch"


def test_remove_updates_resource_usage():
    with tempfile.TemporaryDirectory() as tmp:
        store = Path(tmp) / "store"
        ws.init(store)
        ws.add_active_mission("ws-ru", "m1")
        ws.remove_active_mission("ws-ru", "m1")
        state = ws.load("ws-ru")
        assert state is not None
        assert state["resourceUsage"]["totalRuns"] == 1
