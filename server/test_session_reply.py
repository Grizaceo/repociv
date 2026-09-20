"""Tests for session_reply: what argv a turn gets, and when it is refused."""

from __future__ import annotations

import pytest

from server import session_reply as sr


def _build(**over):
    args = {"agent": "claude-code", "native_id": "n1", "cwd": "/w/repo", "text": "seguí"}
    args.update(over)
    return sr.build(**args)


# ─── argv ────────────────────────────────────────────────────────────────────
def test_claude_turn_inherits_repociv_mission_flags():
    spec = _build()

    # Same flags server/agent_runner.py gives RepoCiv's own missions.
    assert spec["argv"] == [
        "claude", "--print", "--dangerously-skip-permissions", "--resume", "n1", "seguí",
    ]
    assert spec["cwd"] == "/w/repo" and spec["env"] == {}


def test_codex_turn():
    spec = _build(agent="openai-codex", native_id="uuid-1")

    assert spec["argv"] == [
        "codex", "exec", "resume", "--dangerously-bypass-approvals-and-sandbox",
        "uuid-1", "seguí",
    ]
    assert spec["cwd"] == "/w/repo"


def test_hermes_turn_points_at_its_profile_and_sets_no_cwd():
    spec = _build(agent="hermes", native_id="s1", profile="cobalt", hermes_home="/home/u/.hermes")

    assert spec["argv"] == [
        "hermes", "chat", "-q", "seguí", "-Q", "--source", "tool", "--resume", "s1",
    ]
    # Hermes restores the session's own directory; HERMES_HOME picks the profile.
    assert spec["cwd"] == ""
    assert spec["env"] == {"HERMES_HOME": "/home/u/.hermes/profiles/cobalt"}


def test_the_message_is_one_argv_entry_never_a_shell_string():
    spec = _build(text="rm -rf / ; echo $HOME `whoami`")

    assert spec["argv"][-1] == "rm -rf / ; echo $HOME `whoami`"
    assert spec["argv"][0] == "claude"


def test_model_is_only_passed_when_asked():
    assert "--model" not in _build()["argv"]
    assert _build(model="claude-opus-5")["argv"][3:5] == ["--model", "claude-opus-5"]


# ─── Refusals ────────────────────────────────────────────────────────────────
def test_a_live_session_is_refused():
    with pytest.raises(sr.ReplyRefused, match="session_is_live"):
        _build(live=True)


def test_a_live_session_the_source_says_ended_is_allowed():
    assert _build(live=True, ended=True)["argv"][0] == "claude"


def test_an_agent_without_a_resume_is_refused():
    with pytest.raises(sr.ReplyRefused, match="no_resume_path"):
        _build(agent="opencode")


def test_an_empty_message_is_refused():
    for text in ("", "   ", "\n\t"):
        with pytest.raises(sr.ReplyRefused, match="empty_message"):
            _build(text=text)


def test_missing_id_is_refused():
    with pytest.raises(sr.ReplyRefused, match="no_resume_path"):
        _build(native_id="")


# ─── Run bookkeeping ─────────────────────────────────────────────────────────
def test_start_refuses_a_second_turn_while_one_runs(monkeypatch):
    monkeypatch.setattr(sr, "_RUNS", {})
    monkeypatch.setattr(sr, "_binary", lambda family: "/usr/bin/true")
    started: list[tuple] = []

    class _Thread:
        def __init__(self, **kwargs):
            started.append((kwargs["name"],))

        def start(self):
            pass

    monkeypatch.setattr(sr.threading, "Thread", _Thread)
    spec = _build()

    first = sr.start("claude-n1", spec)
    assert first["state"] == "running"
    assert sr.status("claude-n1")["state"] == "running"
    with pytest.raises(sr.ReplyRefused, match="already_running"):
        sr.start("claude-n1", spec)
    assert len(started) == 1


def test_start_refuses_when_the_cli_is_missing(monkeypatch):
    monkeypatch.setattr(sr, "_RUNS", {})
    monkeypatch.setattr(sr, "_binary", lambda family: None)

    with pytest.raises(sr.ReplyRefused, match="claude_not_found"):
        sr.start("claude-n1", _build())


def test_status_of_an_unknown_session_is_none(monkeypatch):
    monkeypatch.setattr(sr, "_RUNS", {})
    assert sr.status("nope") is None


def test_a_failing_turn_records_the_tail_of_its_output(monkeypatch):
    monkeypatch.setattr(sr, "_RUNS", {"s": {"state": "running", "error": ""}})

    class _Done:
        returncode = 2
        stdout = "boom happened"
        stderr = "fatal: "

    monkeypatch.setattr(sr.subprocess, "run", lambda *a, **k: _Done())
    sr._run("s", {"argv": ["x"], "cwd": "", "env": {}})

    run = sr.status("s")
    assert run["state"] == "failed" and "boom happened" in run["error"]


def test_a_timeout_is_recorded_not_raised(monkeypatch):
    monkeypatch.setattr(sr, "_RUNS", {"s": {"state": "running", "error": ""}})

    def _boom(*a, **k):
        raise sr.subprocess.TimeoutExpired(cmd="x", timeout=1)

    monkeypatch.setattr(sr.subprocess, "run", _boom)
    sr._run("s", {"argv": ["x"], "cwd": "", "env": {}})

    assert sr.status("s")["state"] == "failed"
    assert sr.status("s")["error"] == "timeout"
