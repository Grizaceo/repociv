"""Tests for session_resume: the command handed back, and when none is."""

from __future__ import annotations

from server import session_resume as sr


def test_claude_resumes_from_its_own_directory():
    plan = sr.plan(agent="claude-code", native_id="5805ab57-15ab-48a6", cwd="/w/repociv")

    assert plan["mode"] == "resume"
    # The cd is load-bearing: claude resolves a session against the project dir.
    assert plan["command"] == "cd /w/repociv && claude --resume 5805ab57-15ab-48a6"


def test_codex_resume():
    plan = sr.plan(agent="openai-codex", native_id="019a-uuid", cwd="/w/lab")

    assert plan["command"] == "cd /w/lab && codex resume 019a-uuid"


def test_hermes_carries_its_profile_home_and_restores_its_own_cwd():
    plan = sr.plan(
        agent="hermes", native_id="20260919_174051_b5cd89", cwd="/w/anything",
        profile="cobalt", hermes_home="/home/u/.hermes",
    )

    assert plan["command"] == (
        "HERMES_HOME=/home/u/.hermes/profiles/cobalt hermes chat --resume 20260919_174051_b5cd89"
    )
    assert "cd " not in plan["command"]


def test_hermes_default_profile_is_the_root():
    for profile in ("", "default"):
        plan = sr.plan(agent="hermes", native_id="s1", cwd="", profile=profile,
                       hermes_home="/home/u/.hermes")
        assert plan["command"].startswith("HERMES_HOME=/home/u/.hermes hermes chat")


def test_paths_with_spaces_are_quoted():
    plan = sr.plan(agent="claude", native_id="a b", cwd="/w/my repo")

    assert plan["command"] == "cd '/w/my repo' && claude --resume 'a b'"


def test_a_live_session_gets_no_command():
    plan = sr.plan(agent="hermes", native_id="s1", cwd="/w", live=True)

    assert plan["mode"] == "attached"
    assert plan["command"] == ""
    assert "arriendo" in plan["note"]


def test_a_live_session_that_ended_can_still_be_resumed():
    # The process lingers (or the cwd heuristic caught a sibling), but the
    # source says the session is over: resuming it is safe.
    plan = sr.plan(agent="hermes", native_id="s1", cwd="/w", live=True, ended=True)

    assert plan["mode"] == "resume"


def test_unknown_agent_says_so():
    plan = sr.plan(agent="opencode", native_id="s1", cwd="/w")

    assert plan["mode"] == "unavailable"
    assert plan["command"] == ""
    assert "opencode" in plan["note"]


def test_missing_id_is_not_guessed():
    plan = sr.plan(agent="claude-code", native_id="", cwd="/w")

    assert (plan["mode"], plan["command"]) == ("unavailable", "")


def test_agent_family():
    assert sr.agent_family("claude-code") == "claude"
    assert sr.agent_family("Claude") == "claude"
    assert sr.agent_family("openai-codex") == "codex"
    assert sr.agent_family("hermes") == "hermes"
    assert sr.agent_family("cursor") == ""
    assert sr.agent_family("") == ""
