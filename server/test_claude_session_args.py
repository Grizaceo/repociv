"""Claude resume/replacement contracts captured before extraction (bcf54f3).

All stores, transcripts and spawned processes are isolated or fake.
"""

from types import SimpleNamespace

import pytest

from server import agent_runner as runner
from server import suvadu_tracker


@pytest.fixture
def policy(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path / "config"))
    events = []
    state = SimpleNamespace(
        replies=[("old", True), ("new", False)], transcript=None,
        fault=None, on_transcript=None, on_slug=None,
    )

    def step(name, *args):
        events.append((name, *args))
        if state.fault == name:
            raise RuntimeError(f"failure:{name}")

    def slug(city):
        step("slug", city)
        if state.on_slug:
            state.on_slug()
        return "normalized"

    def session_for(unit, city, *, stateful):
        step("session", unit, city, stateful)
        return state.replies.pop(0)

    def forget(unit, city):
        step("forget", unit, city)
        return "ignored"

    def transcript(harness, session):
        step("transcript", harness, session)
        if state.on_transcript:
            state.on_transcript()
        return state.transcript

    monkeypatch.setattr(runner, "_session_city_slug", slug)
    monkeypatch.setattr(runner, "_claude_sessions", SimpleNamespace(
        session_for=session_for, forget_thread=forget,
    ))
    monkeypatch.setattr(suvadu_tracker, "transcript_path", transcript)
    return SimpleNamespace(
        state=state, events=events,
        call=lambda stateful=True: runner._claude_session_args(" Unit ", "CITY", stateful=stateful),
    )


@pytest.mark.parametrize("stateful", [True, False])
@pytest.mark.parametrize(("resume", "transcript", "expected", "steps"), [
    (False, None, ["--session-id", "old"], ["slug", "session"]),
    (True, "/exists", ["--resume", "old"], ["slug", "session", "transcript"]),
    (True, "", ["--resume", "old"], ["slug", "session", "transcript"]),
    (True, False, ["--resume", "old"], ["slug", "session", "transcript"]),
    (True, None, ["--session-id", "new"], ["slug", "session", "transcript", "forget", "session"]),
    ("truthy", None, ["--session-id", "new"], ["slug", "session", "transcript", "forget", "session"]),
])
def test_original_results_and_callback_order(policy, stateful, resume, transcript, expected, steps):
    policy.state.replies[0] = ("old", resume)
    policy.state.transcript = transcript
    assert policy.call(stateful) == expected
    calls = {
        "slug": ("slug", "CITY"),
        "session": ("session", " Unit ", "normalized", stateful),
        "transcript": ("transcript", "claude-code", "old"),
        "forget": ("forget", " Unit ", "normalized"),
    }
    assert policy.events == [calls[name] for name in steps]


@pytest.mark.parametrize("second_resume", [True, False, "truthy", None])
def test_replacement_not_rechecked_or_normalized(policy, second_resume):
    policy.state.replies[1] = ("", second_resume)
    assert policy.call() == ["--resume" if second_resume else "--session-id", ""]
    assert [e[0] for e in policy.events] == ["slug", "session", "transcript", "forget", "session"]


@pytest.mark.parametrize("fault", ["slug", "session", "transcript", "forget"])
def test_exceptions_propagate_without_later_callbacks(policy, fault):
    policy.state.fault = fault
    with pytest.raises(RuntimeError, match=f"^failure:{fault}$"):
        policy.call()
    steps = ["slug", "session", "transcript", "forget"]
    assert [e[0] for e in policy.events] == steps[:steps.index(fault) + 1]


def test_second_store_failure_propagates(policy):
    policy.state.replies = [("old", True)]
    with pytest.raises(IndexError, match="pop from empty list"):
        policy.call()
    assert [e[0] for e in policy.events] == ["slug", "session", "transcript", "forget", "session"]


@pytest.mark.parametrize("replacement_stage", ["slug", "transcript", "forget"])
def test_store_global_is_resolved_late(policy, monkeypatch, replacement_stage):
    def session_for(unit, city, *, stateful):
        policy.events.append(("replacement-session", unit, city, stateful))
        return "replacement", True

    def forget(unit, city):
        policy.events.append(("replacement-forget", unit, city))

    replacement = SimpleNamespace(session_for=session_for, forget_thread=forget)
    replace = lambda: monkeypatch.setattr(runner, "_claude_sessions", replacement)
    if replacement_stage == "forget":
        runner._claude_sessions.forget_thread = lambda *_args: replace()
    else:
        setattr(policy.state, f"on_{replacement_stage}", replace)
    policy.state.transcript = "/exists" if replacement_stage == "slug" else None
    assert policy.call() == ["--resume", "replacement"]
    expected_last = (
        ("transcript", "claude-code", "replacement") if replacement_stage == "slug"
        else ("replacement-session", " Unit ", "normalized", True)
    )
    assert policy.events[-1] == expected_last
    if replacement_stage == "transcript":
        assert policy.events[-2] == ("replacement-forget", " Unit ", "normalized")


def test_transcript_function_is_imported_before_slug(policy, monkeypatch):
    def unexpected(*_args):
        pytest.fail("transcript was rebound after the original local import")

    policy.state.on_slug = lambda: monkeypatch.setattr(suvadu_tracker, "transcript_path", unexpected)
    policy.state.transcript = "/exists"
    assert policy.call() == ["--resume", "old"]
    assert policy.events[-1] == ("transcript", "claude-code", "old")


@pytest.mark.parametrize("stateful", [True, False])
def test_fake_claude_process_uses_real_isolated_session_store(monkeypatch, tmp_path, stateful):
    from server import agent_processes, claude_sessions

    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setattr(runner, "_find_claude_code", lambda: "/fake/claude")
    monkeypatch.setattr(runner, "_spatial_context_block", lambda *_args: "spatial")
    monkeypatch.setattr(runner, "redact_env_for_spawn", lambda: {"FAKE": "1"})
    monkeypatch.setattr(runner, "swarm_track_enabled", lambda: False)
    monkeypatch.setattr(runner, "_harness_ctx", lambda *_args, **_kwargs: None)
    events = []
    commands = []

    class FakeProcess:
        pid = 4321
        returncode = 0

        def __init__(self):
            self.stdout = iter(["hello\n", "world"])

        def wait(self, *, timeout):
            events.append(("wait", timeout))

    def popen(cmd, **kwargs):
        commands.append(cmd)
        assert kwargs == dict(stdout="pipe", stderr="stdout", text=True, bufsize=1,
                              cwd=str(tmp_path), env={"FAKE": "1"}, start_new_session=True)
        events.append(("spawn",))
        return FakeProcess()

    monkeypatch.setattr(runner, "subprocess", SimpleNamespace(Popen=popen, PIPE="pipe", STDOUT="stdout"))
    monkeypatch.setattr(agent_processes, "record_process_binding", lambda *args: events.append(("bind", *args)))
    monkeypatch.setattr(runner, "send_to_repociv", lambda event: events.append(("send", event["text"])))
    monkeypatch.setattr(runner, "_es", SimpleNamespace(
        record_output_chunk=lambda *args: events.append(("record", *args)),
    ))
    monkeypatch.setattr(suvadu_tracker, "transcript_path", lambda *_args: str(tmp_path / "transcript"))
    for _ in range(2):
        assert runner._run_claude_code_streaming(
            "UNIT", "mission", "task", {"stateful": stateful}, str(tmp_path), " A / B ", "model",
        ) == (True, "hello\nworld")
    assert commands[0][:5] == ["/fake/claude", "--print", "--dangerously-skip-permissions", "--model", "model"]
    # Session flag follows the explicit model pair.
    first_id, second_id = commands[0][6], commands[1][6]
    assert commands[0][5] == "--session-id"
    assert commands[1][5] == ("--resume" if stateful else "--session-id")
    assert (first_id == second_id) is stateful
    assert {first_id, second_id} <= claude_sessions.owned_ids()
    assert "--continue" not in commands[0] + commands[1]
    one_run = [
        ("spawn",), ("bind", 4321, "mission", "UNIT"),
        ("send", "hello\n"), ("record", "mission", "UNIT", "hello\n"),
        ("send", "world"), ("record", "mission", "UNIT", "world"), ("wait", 600),
    ]
    assert events == one_run * 2
