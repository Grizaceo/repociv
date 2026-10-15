"""Tests for Devin and MCode session sources, subagents, liveChat reasons, and hooks."""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

from server import (
    agent_hook_client as ahc,
    agent_hook_install as ahi,
    agent_positions as ap,
    devin_sessions as ds,
    mcode_sessions as ms,
    suvadu_tracker as st,
)
from server.live_session_chat import default_router

NOW_S = 1_800_000_000
NOW_MS = NOW_S * 1000


def _proc(root: Path, pid: int, argv: list[str], cwd: Path | None = None) -> None:
    entry = root / str(pid)
    entry.mkdir(parents=True, exist_ok=True)
    (entry / "cmdline").write_bytes(b"\0".join(a.encode() for a in argv) + b"\0")
    if cwd is not None:
        cwd.mkdir(parents=True, exist_ok=True)
        try:
            os.symlink(cwd, entry / "cwd")
        except OSError:
            pass


def _make_devin_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          working_directory TEXT NOT NULL,
          backend_type TEXT NOT NULL,
          model TEXT NOT NULL,
          agent_mode TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          title TEXT,
          workspace_dirs TEXT,
          hidden INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE message_nodes (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          node_id INTEGER NOT NULL,
          parent_node_id INTEGER,
          chat_message TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE tool_call_state (
          session_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_call_json TEXT,
          tool_call_update_json TEXT,
          PRIMARY KEY (session_id, tool_call_id)
        );
        """
    )
    return conn


def _make_mcode_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE local_runtime_sessions (
          session_id TEXT PRIMARY KEY,
          record_json TEXT NOT NULL DEFAULT '{}',
          updated_at_ms INTEGER NOT NULL,
          agent_name TEXT,
          status TEXT,
          parent_session_id TEXT,
          workspace_dir TEXT,
          project_workspace_dir TEXT,
          title TEXT,
          created_at_ms INTEGER,
          extra_data_json TEXT NOT NULL DEFAULT '{}',
          session_kind TEXT NOT NULL DEFAULT 'conversation'
        );
        CREATE TABLE local_runtime_token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          framework_type TEXT NOT NULL,
          turn_id TEXT,
          model TEXT,
          ts INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          reasoning_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL,
          cache_write_tokens INTEGER NOT NULL
        );
        CREATE TABLE local_runtime_messages (
          session_id TEXT PRIMARY KEY,
          display_messages_json TEXT NOT NULL,
          pi_history_json TEXT NOT NULL DEFAULT '[]'
        );
        """
    )
    return conn


def test_devin_source_polls_sessions_locks_and_chat(tmp_path: Path) -> None:
    repo_a = tmp_path / "repos" / "alpha"
    repo_b = tmp_path / "repos" / "beta"
    for r in (repo_a, repo_b):
        (r / ".git").mkdir(parents=True)

    data_dir = tmp_path / "devin_cli"
    conn = _make_devin_db(data_dir / "sessions.db")
    with conn:
        conn.execute(
            "INSERT INTO sessions VALUES (?, ?, 'windsurf', 'gemini-4-argon-high', 'bypass', ?, ?, ?, '[]', 0)",
            ("clever-zebu", str(repo_a), NOW_S - 60, NOW_S - 10, "Investigar alpha"),
        )
        conn.execute(
            "INSERT INTO sessions VALUES (?, ?, 'windsurf', 'claude-opus-5-5', 'bypass', ?, ?, ?, '[]', 0)",
            ("quiet-otter", str(repo_b), NOW_S - 300, NOW_S - 200, "Revisar beta"),
        )
        conn.execute(
            "INSERT INTO sessions VALUES (?, ?, 'windsurf', 'model', 'bypass', ?, ?, ?, '[]', 1)",
            ("hidden-one", str(repo_a), NOW_S - 30, NOW_S - 5, "Oculta"),
        )
        conn.execute(
            "INSERT INTO tool_call_state VALUES ('clever-zebu', 'tc-1', ?, NULL)",
            (json.dumps({"file_path": f"{repo_a}/src/main.ts"}),),
        )
        conn.execute(
            "INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, 1, NULL, ?, ?)",
            ("clever-zebu", json.dumps({"role": "user", "content": "hola devin"}), NOW_S - 50),
        )
        conn.execute(
            "INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, 2, 1, ?, ?)",
            ("clever-zebu", json.dumps({"role": "assistant", "content": "listo en alpha"}), NOW_S - 10),
        )
    conn.close()

    proc_root = tmp_path / "proc"
    _proc(proc_root, 4100, ["/home/u/.local/bin/devin"], cwd=repo_a)
    locks_dir = data_dir / "session_locks"
    locks_dir.mkdir(parents=True)
    (locks_dir / "clever-zebu.lock").write_text("4100\n", encoding="utf-8")
    (locks_dir / "quiet-otter.lock").write_text("9999\n", encoding="utf-8")  # dead PID

    src = ds.DevinSource(str(data_dir), proc_root=str(proc_root), clock=lambda: float(NOW_S))
    tracker = st.ExternalAgentTracker(
        st.TrackerConfig(bin_path="suv"),
        send=lambda _: None,
        repo_paths=lambda: [str(repo_a), str(repo_b)],
        sources=[src],
        clock=lambda: float(NOW_S),
        live_chat_router=default_router(),
    )
    tracker.poll_once()

    rows = {r["sessionId"]: r for r in tracker.sessions()}
    assert set(rows) == {"devin-clever-zebu", "devin-quiet-otter"}

    live_row = rows["devin-clever-zebu"]
    assert live_row["cityId"] == st.encode_repo_id(str(repo_a))
    assert live_row["state"] == "working"
    assert live_row["liveChat"] == {
        "state": "unavailable",
        "transport": None,
        "reason": "devin_live_chat_unavailable",
    }

    quiet_row = rows["devin-quiet-otter"]
    assert quiet_row["cityId"] == st.encode_repo_id(str(repo_b))
    assert quiet_row["state"] == "idle"

    status, chat_body = tracker.chat("devin-clever-zebu", limit=10)
    assert status == 200 and chat_body["available"] is True
    assert [(m["role"], m["text"]) for m in chat_body["messages"]] == [
        ("user", "hola devin"),
        ("assistant", "listo en alpha"),
    ]


def test_mcode_source_polls_sessions_subagents_tokens_and_active_pids(tmp_path: Path) -> None:
    repo_a = tmp_path / "repos" / "gamma"
    (repo_a / ".git").mkdir(parents=True)

    minimax_home = tmp_path / "minimax"
    active_dir = tmp_path / "mcode-active"
    active_dir.mkdir(parents=True)
    proc_root = tmp_path / "proc"
    _proc(proc_root, 5200, ["/home/u/.minimax-code/bin/mcode"], cwd=repo_a)
    (active_dir / "5200.json").write_text(
        json.dumps({"pid": 5200, "startedAtMs": NOW_MS - 60_000}),
        encoding="utf-8",
    )

    conn = _make_mcode_db(minimax_home / "v2" / "sqlite" / "runtime-state.sqlite")
    with conn:
        conn.execute(
            "INSERT INTO local_runtime_sessions "
            "(session_id, updated_at_ms, agent_name, status, parent_session_id, workspace_dir, title, created_at_ms, extra_data_json, session_kind) "
            "VALUES (?, ?, 'mavis', 'running', NULL, ?, 'Main MCode task', ?, ?, 'conversation')",
            (
                "mvs_main0001",
                NOW_MS - 180_000,  # 3 min old, but live process in same cwd -> thinking
                str(repo_a),
                NOW_MS - 300_000,
                json.dumps({"effectiveModel": "minimax/MiniMax-M3.1"}),
            ),
        )
        for sid, agent_name in (
            ("mvs_sub_exp", "explore"),
            ("mvs_sub_ver", "verifier"),
            ("mvs_sub_wrk", "worker"),
        ):
            conn.execute(
                "INSERT INTO local_runtime_sessions "
                "(session_id, updated_at_ms, agent_name, status, parent_session_id, workspace_dir, title, created_at_ms, extra_data_json, session_kind) "
                "VALUES (?, ?, ?, 'idle', 'mvs_main0001', ?, ?, ?, '{}', 'task')",
                (sid, NOW_MS - 20_000, agent_name, str(repo_a), f"Sub {agent_name}", NOW_MS - 40_000),
            )
        conn.execute(
            "INSERT INTO local_runtime_token_usage "
            "(session_id, agent_name, framework_type, turn_id, model, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens) "
            "VALUES ('mvs_main0001', 'mavis', 'pi-agent', 't1', 'minimax/MiniMax-M3.1', ?, 1000, 500, 100, 400, 0)",
            (NOW_MS - 180_000,),
        )
        conn.execute(
            "INSERT INTO local_runtime_messages VALUES ('mvs_main0001', ?, '[]')",
            (
                json.dumps(
                    [
                        {"role": "user", "content": "analiza gamma", "createdAtMs": NOW_MS - 290_000},
                        {"role": "assistant", "content": "análisis completo", "createdAtMs": NOW_MS - 180_000},
                    ]
                ),
            ),
        )
    conn.close()

    src = ms.MCodeSource(
        str(minimax_home),
        active_dir=str(active_dir),
        proc_root=str(proc_root),
        clock=lambda: float(NOW_S),
    )
    tracker = st.ExternalAgentTracker(
        st.TrackerConfig(bin_path="suv"),
        send=lambda _: None,
        repo_paths=lambda: [str(repo_a)],
        sources=[src],
        clock=lambda: float(NOW_S),
        live_chat_router=default_router(),
    )
    tracker.poll_once()

    rows = {r["sessionId"]: r for r in tracker.sessions()}
    assert set(rows) == {
        "mcode-mvs_main0001",
        "mcode-mvs_sub_exp",
        "mcode-mvs_sub_ver",
        "mcode-mvs_sub_wrk",
    }
    # No duplicate units: 4 distinct sessions -> 4 distinct unit ids
    units = [r["unit"] for r in rows.values()]
    assert len(units) == len(set(units)) == 4

    main_row = rows["mcode-mvs_main0001"]
    assert main_row["state"] == "thinking"  # >2 min old + live .mcode-active process
    assert main_row["subagent"] is False
    assert main_row["totalTokens"] == 2000
    assert main_row["cityId"] == st.encode_repo_id(str(repo_a))
    assert main_row["liveChat"] == {
        "state": "unavailable",
        "transport": None,
        "reason": "mcode_live_chat_unavailable",
    }

    assert rows["mcode-mvs_sub_exp"]["subagent"] is True
    assert rows["mcode-mvs_sub_exp"]["unitType"] == "scout"
    assert rows["mcode-mvs_sub_ver"]["subagent"] is True
    assert rows["mcode-mvs_sub_ver"]["unitType"] == "scout"
    assert rows["mcode-mvs_sub_wrk"]["subagent"] is True
    assert rows["mcode-mvs_sub_wrk"]["unitType"] == "worker"


def test_devin_and_mcode_hook_install_idempotent_and_remove_preserves_foreign(tmp_path: Path) -> None:
    home = tmp_path / "home"
    repo = tmp_path / "repociv"
    repo.mkdir(parents=True)
    devin_cfg = home / ".config" / "devin" / "config.json"
    devin_cfg.parent.mkdir(parents=True)
    original_devin = {
        "version": 1,
        "agent": {"model": "gemini-4-argon-high"},
        "hooks": {
            "PostToolUse": [
                {"matcher": "exec", "hooks": [{"type": "command", "command": "/bin/foreign-hook"}]}
            ]
        },
    }
    devin_cfg.write_text(json.dumps(original_devin, indent=2) + "\n", encoding="utf-8")
    (home / ".minimax").mkdir(parents=True)

    res1 = ahi.install(home, repo, "/usr/bin/python3", remove=False)
    assert str(devin_cfg) in res1["changed"]
    mcode_hooks_path = home / ".minimax" / "plugins" / "repociv-hooks" / "hooks" / "hooks.json"
    mcode_manifest_path = home / ".minimax" / "plugins" / "repociv-hooks" / ".claude-plugin" / "plugin.json"
    assert str(mcode_hooks_path) in res1["changed"]
    assert str(mcode_manifest_path) in res1["changed"]
    assert res1["backup"] is not None

    # Idempotent even across a different python interpreter path
    res2 = ahi.install(home, repo, "/opt/venv/bin/python", remove=False)
    assert res2["changed"] == []

    # Remove only ours, keeping foreign hooks in devin config and cleaning empty repociv-hooks plugin
    res3 = ahi.install(home, repo, "/opt/venv/bin/python", remove=True)
    assert str(devin_cfg) in res3["changed"]
    after_devin = json.loads(devin_cfg.read_text(encoding="utf-8"))
    assert after_devin == original_devin
    assert not mcode_hooks_path.exists()
    assert not mcode_manifest_path.exists()


def test_devin_and_mcode_position_hooks_relocate_existing_units(tmp_path: Path, monkeypatch) -> None:
    repo_a = tmp_path / "a"
    repo_b = tmp_path / "b"
    for r in (repo_a, repo_b):
        (r / ".git").mkdir(parents=True)

    # Devin uses DEVIN_PROJECT_DIR fallback when stdin lacks cwd
    monkeypatch.setenv("DEVIN_PROJECT_DIR", str(repo_a))
    p_devin = ahc.position_payload(
        "devin",
        "tool_use",
        {"session_id": "clever-zebu", "tool_name": "read", "tool_input": {"file_path": f"{repo_b}/README.md"}},
    )
    assert p_devin == {
        "cli": "devin",
        "event": "tool_use",
        "session_id": "clever-zebu",
        "cwd": f"{repo_b}/README.md",
        "authority": "tool",
    }

    p_mcode = ahc.position_payload(
        "mcode",
        "tool_use",
        {"session_id": "mvs_main0001", "cwd": str(repo_a), "tool_input": {"path": f"{repo_b}/src"}},
    )
    assert p_mcode == {
        "cli": "mcode",
        "event": "tool_use",
        "session_id": "mvs_main0001",
        "cwd": f"{repo_b}/src",
        "authority": "tool",
    }

    store = ap.PositionStore()
    r1 = store.ingest(p_devin, [str(repo_a), str(repo_b)], NOW_MS)
    r2 = store.ingest(p_mcode, [str(repo_a), str(repo_b)], NOW_MS)
    assert r1["accepted"] and r1["cityId"] == st.encode_repo_id(str(repo_b))
    assert r2["accepted"] and r2["cityId"] == st.encode_repo_id(str(repo_b))

    obs_d = st.Observation(
        session_id="devin-clever-zebu",
        agent="devin",
        native_id="clever-zebu",
        cwd=str(repo_a),
        model="gemini-4-argon-high",
        first_activity_ms=NOW_MS - 10_000,
        last_activity_ms=NOW_MS - 5_000,
        command_count=1,
        event_count=2,
        total_tokens=None,
        source="devin",
        unit_id="ext-devin-clever-z",
    )
    obs_m = st.Observation(
        session_id="mcode-mvs_main0001",
        agent="mcode",
        native_id="mvs_main0001",
        cwd=str(repo_a),
        model="minimax/MiniMax-M3.1",
        first_activity_ms=NOW_MS - 10_000,
        last_activity_ms=NOW_MS - 5_000,
        command_count=1,
        event_count=2,
        total_tokens=100,
        source="mcode",
        unit_id="ext-mcode-mvs_main",
    )
    overlaid = store.overlay([obs_d, obs_m], NOW_MS)
    assert [o.position_city_id for o in overlaid] == [
        st.encode_repo_id(str(repo_b)),
        st.encode_repo_id(str(repo_b)),
    ]
