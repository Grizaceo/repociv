"""RepoCiv's own Claude Code sessions: explicit ids, per-unit threads, tracker dedupe."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest

from server import agent_runner
from server import claude_sessions as cs
from server import suvadu_tracker as st


@pytest.fixture(autouse=True)
def config_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path / "repociv"))
    return tmp_path / "repociv"


def test_stateful_thread_is_created_then_resumed(config_dir: Path) -> None:
    sid, resume = cs.session_for("MAIN", "carcosa", stateful=True)
    assert resume is False and uuid.UUID(sid)
    again, resume = cs.session_for("main", "carcosa", stateful=True)
    assert (again, resume) == (sid, True)
    other, resume = cs.session_for("MAIN", "singevery", stateful=True)
    assert other != sid and resume is False
    data = json.loads((config_dir / "claude-sessions.json").read_text())
    assert data["threads"] == {"main|carcosa": sid, "main|singevery": other}


def test_stateless_missions_get_a_fresh_id_each_time() -> None:
    a, ra = cs.session_for("SCOUT", "carcosa", stateful=False)
    b, rb = cs.session_for("SCOUT", "carcosa", stateful=False)
    assert a != b and not ra and not rb
    assert {a, b} <= cs.owned_ids()


def test_owned_ids_are_capped_and_include_threads(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cs, "_MAX_OWNED", 3)
    thread, _ = cs.session_for("MAIN", "", stateful=True)
    ids = [cs.session_for("W", "", stateful=False)[0] for _ in range(5)]
    owned = cs.owned_ids()
    assert set(ids[-3:]) <= owned and ids[0] not in owned
    assert thread in owned  # threads survive the cap


def test_forget_thread_and_bad_state_file(config_dir: Path) -> None:
    sid, _ = cs.session_for("MAIN", "x", stateful=True)
    cs.forget_thread("MAIN", "x")
    assert cs.session_for("MAIN", "x", stateful=True)[0] != sid
    (config_dir / "claude-sessions.json").write_text("{not json")
    assert cs.owned_ids() == frozenset()
    (config_dir / "claude-sessions.json").write_text(json.dumps({"threads": {"a|b": "../x"}, "owned": [1]}))
    assert cs.owned_ids() == frozenset()


def test_session_args_resume_only_with_a_transcript(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    args = agent_runner._claude_session_args("MAIN", "CARCOSA", stateful=True)
    assert args[0] == "--session-id"
    sid = args[1]
    # No transcript on disk yet → a new thread, not a --resume that would fail.
    args = agent_runner._claude_session_args("MAIN", "CARCOSA", stateful=True)
    assert args[0] == "--session-id" and args[1] != sid
    transcript = tmp_path / ".claude" / "projects" / "-w-carcosa" / f"{args[1]}.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}\n")
    assert agent_runner._claude_session_args("MAIN", "CARCOSA", stateful=True) == ["--resume", args[1]]
    assert agent_runner._claude_session_args("MAIN", "CARCOSA", stateful=False)[0] == "--session-id"


def test_claude_mission_never_uses_continue(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[list[str]] = []

    class FakeProc:
        stdout: list[str] = []
        returncode = 0

        def __init__(self, cmd: list[str], **_kw: Any) -> None:
            seen.append(cmd)

        def wait(self, timeout: float) -> int:
            return 0

    monkeypatch.setattr(agent_runner, "_find_claude_code", lambda: "/bin/claude")
    monkeypatch.setattr(agent_runner.subprocess, "Popen", FakeProc)
    monkeypatch.setattr(agent_runner, "swarm_track_enabled", lambda: False)
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda _evt: None)
    ok, _ = agent_runner._run_claude_code_streaming("MAIN", "m-1", "hola", {"stateful": True}, None, "carcosa")
    assert ok
    [cmd] = seen
    assert "--continue" not in cmd
    flag = cmd.index("--session-id")
    assert cmd[flag + 1] in cs.owned_ids()


def _sessions_json(*rows: dict[str, Any]) -> str:
    return json.dumps({"sessions": list(rows)})


def test_tracker_skips_repociv_missions_and_their_subagents() -> None:
    mine, theirs, sub = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    now_ms = 1_789_800_000_000

    def row(native: str, parent: str | None = None) -> dict[str, Any]:
        return {"id": f"claude-{native}", "agent": "claude-code", "native_id": native, "cwd": "/w",
                "last_activity_at": now_ms, "parent_id": parent}

    raw = _sessions_json(row(mine), row(theirs), row(sub, parent=f"claude-{mine}"))

    def run(args: list[str]) -> str:
        return raw if args[:2] == ["agent", "sessions"] else ""

    src = st.SuvaduSource(run, lambda: now_ms / 1000, owned_ids=lambda: frozenset({mine}))
    assert [o.native_id for o in src.poll()] == [theirs]
    assert len(st.SuvaduSource(run, lambda: now_ms / 1000).poll()) == 3  # default: skip nothing
