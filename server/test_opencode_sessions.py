"""Tests for the OpenCode session source, plugin hooks and live-chat wiring."""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

from server import (
    agent_hook_client as ahc,
    agent_hook_install as ahi,
    agent_positions as ap,
    opencode_sessions as oc,
    suvadu_tracker as st,
)
from server.live_session_chat import LiveSessionChatRouter, OpenCodeLiveChatAdapter

NOW_S = 1_800_000_000
NOW_MS = NOW_S * 1000


def _make_opencode_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        CREATE TABLE session_v2 (
          id TEXT PRIMARY KEY,
          parent_id TEXT,
          directory TEXT NOT NULL,
          title TEXT,
          agent TEXT,
          model TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          time_archived INTEGER,
          tokens_input INTEGER NOT NULL DEFAULT 0,
          tokens_output INTEGER NOT NULL DEFAULT 0,
          tokens_reasoning INTEGER NOT NULL DEFAULT 0,
          tokens_cache_read INTEGER NOT NULL DEFAULT 0,
          tokens_cache_write INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE session_message (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          seq INTEGER NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        """
    )
    return conn


def test_opencode_source_polls_sessions_liveness_and_chat(tmp_path: Path) -> None:
    repo_a = tmp_path / "repos" / "delta"
    repo_b = tmp_path / "repos" / "epsilon"
    for repo in (repo_a, repo_b):
        (repo / ".git").mkdir(parents=True)

    model = json.dumps({"id": "deepseek-v4.1-flash-free", "providerID": "opencode", "variant": "max"})
    data_dir = tmp_path / "opencode-data"
    conn = _make_opencode_db(data_dir / "opencode.db")
    with conn:
        # Live main session in delta, worked 5s ago.
        conn.execute(
            "INSERT INTO session_v2 (id, parent_id, directory, title, agent, model, "
            "time_created, time_updated, time_archived, tokens_input, tokens_output, "
            "tokens_reasoning, tokens_cache_read, tokens_cache_write) "
            "VALUES (?, NULL, ?, 'Auditar delta', 'build', ?, ?, ?, NULL, 1000, 500, 100, 400, 0)",
            ("ses_live0001", str(repo_a), model, NOW_MS - 300_000, NOW_MS - 5_000),
        )
        # Quiet session in epsilon: no live process, activity aged out.
        conn.execute(
            "INSERT INTO session_v2 (id, parent_id, directory, title, agent, model, "
            "time_created, time_updated, time_archived) "
            "VALUES (?, NULL, ?, 'Revisar epsilon', 'build', ?, ?, ?, NULL)",
            (
                "ses_quiet02",
                str(repo_b),
                json.dumps({"id": "qwen3-coder", "providerID": "opencode"}),
                NOW_MS - 300_000,
                NOW_MS - 200_000,
            ),
        )
        # A RepoCiv mission's own thread: its unit already stands on the map.
        conn.execute(
            "INSERT INTO session_v2 (id, parent_id, directory, title, agent, model, "
            "time_created, time_updated, time_archived) "
            "VALUES ('ses_repociv-main-repociv', NULL, ?, 'misión', 'build', ?, ?, ?, NULL)",
            (str(repo_a), model, NOW_MS - 60_000, NOW_MS - 1_000),
        )
        # A malformed id never becomes a row.
        conn.execute(
            "INSERT INTO session_v2 (id, parent_id, directory, title, agent, model, "
            "time_created, time_updated, time_archived) "
            "VALUES ('bad id!', NULL, ?, 'x', 'build', ?, ?, ?, NULL)",
            (str(repo_a), model, NOW_MS - 60_000, NOW_MS - 1_000),
        )
        # Live subagent under the main session: quiet for 4 min → thinking.
        conn.execute(
            "INSERT INTO session_v2 (id, parent_id, directory, title, agent, model, "
            "time_created, time_updated, time_archived) "
            "VALUES (?, ?, ?, 'Sub explore', 'explore', ?, ?, ?, NULL)",
            ("ses_sub00001", "ses_live0001", str(repo_a), model, NOW_MS - 260_000, NOW_MS - 240_000),
        )
        # Chat transcript: the CLI stores the prompt JSON-quoted; the assistant
        # answer is a content-parts list.
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) "
            "VALUES ('m1', 'ses_live0001', 'user', 1, ?, ?, ?)",
            (
                NOW_MS - 110_000,
                NOW_MS - 110_000,
                json.dumps({"time": {"created": NOW_MS - 110_000}, "text": json.dumps("hola opencode")}),
            ),
        )
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) "
            "VALUES ('m2', 'ses_live0001', 'assistant', 2, ?, ?, ?)",
            (
                NOW_MS - 5_000,
                NOW_MS - 5_000,
                json.dumps(
                    {
                        "time": {"created": NOW_MS - 5_000},
                        "content": [
                            {"type": "reasoning", "text": "no debe verse"},
                            {"type": "text", "text": "listo en delta"},
                        ],
                    }
                ),
            ),
        )
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) "
            "VALUES ('m3', 'ses_live0001', 'tool', 3, ?, ?, '{}')",
            (NOW_MS - 4_000, NOW_MS - 4_000),
        )
    conn.close()

    src = oc.OpenCodeSource(
        str(data_dir),
        bin_path="/bin/opencode",
        proc_root=str(tmp_path / "proc"),
        clock=lambda: float(NOW_S),
        active_ids=lambda: frozenset({"ses_live0001", "ses_sub00001"}),
    )
    router = LiveSessionChatRouter(
        {"opencode": OpenCodeLiveChatAdapter(opencode_bin="/bin/opencode")}
    )
    tracker = st.ExternalAgentTracker(
        st.TrackerConfig(bin_path="suv"),
        send=lambda _: None,
        repo_paths=lambda: [str(repo_a), str(repo_b)],
        sources=[src],
        clock=lambda: float(NOW_S),
        live_chat_router=router,
    )
    tracker.poll_once()

    rows = {r["sessionId"]: r for r in tracker.sessions()}
    assert set(rows) == {
        "opencode-ses_live0001",
        "opencode-ses_quiet02",
        "opencode-ses_sub00001",
    }

    live_row = rows["opencode-ses_live0001"]
    assert live_row["cityId"] == st.encode_repo_id(str(repo_a))
    assert live_row["state"] == "working"
    assert live_row["unit"] == "ext-opencode-live0001"
    assert live_row["totalTokens"] == 2000
    assert live_row["liveChat"] == {
        "state": "available",
        "transport": "opencode-api",
        "reason": None,
    }

    quiet_row = rows["opencode-ses_quiet02"]
    assert quiet_row["cityId"] == st.encode_repo_id(str(repo_b))
    assert quiet_row["state"] == "idle"
    assert quiet_row["liveChat"] == {
        "state": "unavailable",
        "transport": None,
        "reason": "opencode_live_chat_unavailable",
    }

    sub_row = rows["opencode-ses_sub00001"]
    assert sub_row["subagent"] is True
    assert sub_row["unitType"] == "scout"
    assert sub_row["state"] == "thinking"  # live but quiet for 4 minutes

    status, chat_body = tracker.chat("opencode-ses_live0001", limit=10)
    assert status == 200 and chat_body["available"] is True
    assert chat_body["title"] == "Auditar delta"
    assert [(m["role"], m["text"]) for m in chat_body["messages"]] == [
        ("user", "hola opencode"),
        ("assistant", "listo en delta"),
    ]


def test_opencode_plugin_install_is_idempotent_and_remove_preserves_foreign(
    tmp_path: Path,
) -> None:
    home = tmp_path / "home"
    repo = tmp_path / "repociv"
    (repo / "server").mkdir(parents=True)
    plugins = home / ".config" / "opencode" / "plugins"
    plugins.mkdir(parents=True)
    foreign = plugins / "other.js"
    foreign.write_text("// foreign plugin\n", encoding="utf-8")

    res1 = ahi.install(home, repo, "/usr/bin/python3", remove=False)
    plugin = plugins / "repociv-hooks.js"
    assert str(plugin) in res1["changed"]
    content = plugin.read_text(encoding="utf-8")
    assert ahi.OPENCODE_PLUGIN_MARKER in content
    assert str(repo / "server" / "agent_hook_client.py") in content
    assert plugin.stat().st_mode & 0o777 == 0o600

    # Same interpreter: nothing to rewrite.
    res2 = ahi.install(home, repo, "/usr/bin/python3", remove=False)
    assert str(plugin) not in res2["changed"]

    res3 = ahi.install(home, repo, "/usr/bin/python3", remove=True)
    assert str(plugin) in res3["changed"]
    assert not plugin.exists()
    assert foreign.read_text(encoding="utf-8") == "// foreign plugin\n"


def test_opencode_plugin_skips_missing_and_foreign_config_dirs(tmp_path: Path) -> None:
    repo = tmp_path / "repociv"
    (repo / "server").mkdir(parents=True)

    # No ~/.config/opencode at all: nothing is created, nothing is changed.
    bare_home = tmp_path / "bare-home"
    bare_home.mkdir()
    assert ahi.install(bare_home, repo, "/python", remove=False)["changed"] == []
    assert not (bare_home / ".config" / "opencode").exists()

    # A file at OUR path that is not ours survives remove untouched.
    home = tmp_path / "home"
    plugins = home / ".config" / "opencode" / "plugins"
    plugins.mkdir(parents=True)
    same = plugins / "repociv-hooks.js"
    same.write_text("// not ours\n", encoding="utf-8")
    res = ahi.install(home, repo, "/python", remove=True)
    assert str(same) not in res["changed"]
    assert same.read_text(encoding="utf-8") == "// not ours\n"


def test_opencode_position_hooks_relocate_existing_units(tmp_path: Path) -> None:
    repo_a = tmp_path / "a"
    repo_b = tmp_path / "b"
    for repo in (repo_a, repo_b):
        (repo / ".git").mkdir(parents=True)

    # The plugin emits the session's directory; prompts never leave the hook.
    p_turn = ahc.position_payload(
        "opencode",
        "turn_start",
        {"session_id": "ses_live0001", "cwd": str(repo_a), "prompt": {"text": "SECRET"}},
    )
    assert p_turn == {
        "cli": "opencode",
        "event": "turn_start",
        "session_id": "ses_live0001",
        "cwd": str(repo_a),
        "authority": "cwd",
    }

    # A file tool names its path in camelCase (opencode's shape).
    p_tool = ahc.position_payload(
        "opencode",
        "tool_use",
        {
            "session_id": "ses_live0001",
            "cwd": str(repo_a),
            "tool_input": {"filePath": f"{repo_b}/src/app.ts", "content": "SECRET"},
        },
    )
    assert p_tool == {
        "cli": "opencode",
        "event": "tool_use",
        "session_id": "ses_live0001",
        "cwd": f"{repo_b}/src/app.ts",
        "authority": "tool",
    }
    assert "SECRET" not in json.dumps(p_tool)

    store = ap.PositionStore()
    r1 = store.ingest(p_turn, [str(repo_a), str(repo_b)], NOW_MS)
    r2 = store.ingest(p_tool, [str(repo_a), str(repo_b)], NOW_MS)
    assert r1["accepted"] and r1["cityId"] == st.encode_repo_id(str(repo_a))
    assert r2["accepted"] and r2["cityId"] == st.encode_repo_id(str(repo_b))

    obs = st.Observation(
        session_id="opencode-ses_live0001",
        agent="opencode",
        native_id="ses_live0001",
        cwd=str(repo_a),
        model="opencode/deepseek-v4.1-flash-free#max",
        first_activity_ms=NOW_MS - 10_000,
        last_activity_ms=NOW_MS - 5_000,
        command_count=1,
        event_count=2,
        total_tokens=None,
        source="opencode",
        unit_id="ext-opencode-live0001",
        live=True,
    )
    overlaid = store.overlay([obs], NOW_MS)
    assert [o.position_city_id for o in overlaid] == [st.encode_repo_id(str(repo_b))]


def test_running_session_ids_parses_the_body_not_the_exit_code(monkeypatch) -> None:
    class _Proc:
        def __init__(self, returncode: int, stdout: str) -> None:
            self.returncode, self.stdout, self.stderr = returncode, stdout, ""

    monkeypatch.setattr(
        oc.subprocess,
        "run",
        lambda *a, **k: _Proc(
            0, '{"data":{"ses_a":{"type":"running"},"ses_b":{"type":"idle"}}}'
        ),
    )
    assert oc._running_session_ids("/bin/opencode") == frozenset({"ses_a"})

    # The CLI exits 0 even on HTTP errors: an error body is "unknown", not "none live".
    monkeypatch.setattr(oc.subprocess, "run", lambda *a, **k: _Proc(0, '{"_tag":"NotFoundError"}'))
    assert oc._running_session_ids("/bin/opencode") is None
    monkeypatch.setattr(oc.subprocess, "run", lambda *a, **k: _Proc(1, ""))
    assert oc._running_session_ids("/bin/opencode") is None
    assert oc._running_session_ids("") is None


def test_proc_fallback_matches_the_real_entrypoint_and_marks_sessions_live(tmp_path: Path) -> None:
    """The shipped binary runs as ``opencode.exe``; the fallback must still see it."""
    repo = tmp_path / "repos" / "delta"
    (repo / ".git").mkdir(parents=True)
    other = tmp_path / "repos" / "other"
    other.mkdir(parents=True)
    proc_root = tmp_path / "proc"

    def fake_proc(pid: str, cmdline: str, cwd: Path) -> None:
        entry = proc_root / pid
        entry.mkdir(parents=True)
        (entry / "cmdline").write_bytes(cmdline.encode())
        os.symlink(cwd, entry / "cwd")

    fake_proc("100", "/opt/opencode/bin/opencode.exe\0run\0--session\0ses_live0001\0", repo)
    fake_proc("101", "/usr/bin/opencode\0run\0", repo)  # plain entrypoint also matches
    fake_proc("102", "/usr/bin/opencode-helper\0serve\0", other)  # never a loose substring
    assert oc._live_opencode_cwds(str(proc_root)) == frozenset({str(repo)})

    data_dir = tmp_path / "data"
    conn = _make_opencode_db(data_dir / "opencode.db")
    for sid, directory in (("ses_live0001", repo), ("ses_elsewhere01", other)):
        conn.execute(
            "INSERT INTO session_v2 (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)",
            (sid, str(directory), NOW_MS - 1_000, NOW_MS - 1_000),
        )
    conn.commit()
    conn.close()

    # Service unreachable (no bin): the source degrades to the /proc scan.
    src = oc.OpenCodeSource(
        str(data_dir),
        bin_path="",
        proc_root=str(proc_root),
        clock=lambda: float(NOW_S),
        active_ids=None,
    )
    rows = {obs.native_id: obs for obs in src.poll()}
    assert rows["ses_live0001"].live is True
    assert rows["ses_elsewhere01"].live is False  # helper process never counts


def test_model_label_and_source_from_env(monkeypatch) -> None:
    assert (
        oc._model_label(
            json.dumps({"id": "deepseek-v4.1-flash-free", "providerID": "opencode", "variant": "max"})
        )
        == "opencode/deepseek-v4.1-flash-free#max"
    )
    assert oc._model_label(json.dumps({"id": "m", "variant": "default"})) == "m"
    assert oc._model_label("not json") == ""
    assert oc._model_label(None) == ""

    monkeypatch.setenv("REPOCIV_OPENCODE_SESSIONS", "0")
    assert oc.source_from_env() is None
    monkeypatch.setenv("REPOCIV_OPENCODE_SESSIONS", "1")
    assert isinstance(oc.source_from_env(), oc.OpenCodeSource)
