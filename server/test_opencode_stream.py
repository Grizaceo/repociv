"""OpenCode stream contracts captured on f593290 before extraction.

Only fake processes and callbacks; no executable, model or external service.
"""

import json
from types import SimpleNamespace

import pytest

from server import agent_processes
from server import agent_runner as runner


def event(kind, part=None, **kwargs):
    return json.dumps({"type": kind, "part": part, **kwargs})


@pytest.fixture
def run(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("REPOCIV_CONFIG_DIR", str(tmp_path / "config"))
    trace = []
    state = SimpleNamespace(lines=[], code=0, fault=None, on_send=None, stdout_none=False)
    monkeypatch.setattr(runner, "_find_opencode", lambda: "/fake/opencode")
    monkeypatch.setattr(runner, "_spatial_context_block", lambda *_args: "spatial")
    monkeypatch.setattr(runner, "_build_stateful_session_id", lambda *_args, **_kwargs: "thread")
    monkeypatch.setattr(runner, "redact_env_for_spawn", lambda: {"FAKE": "1"})

    def step(name, *args):
        trace.append((name, *args))
        if state.fault == name:
            raise RuntimeError(f"failure:{name}")

    def lines():
        for line in state.lines:
            step("read", line)
            yield line
        step("eof")

    def send(payload):
        assert payload == dict(type="chat_chunk", unit="U", missionId="M", text=payload["text"])
        step("send", payload["text"])
        if state.on_send:
            state.on_send()

    def record(mission, unit, text):
        assert (mission, unit) == ("M", "U")
        step("record", text)

    class Process:
        pid = 42

        @property
        def stdout(self):
            return None if state.stdout_none else lines()

        @property
        def returncode(self):
            step("returncode")
            return state.code

        def wait(self, *, timeout):
            step("wait", timeout)

    def popen(cmd, **kwargs):
        assert cmd == ["/fake/opencode", "run", "--session", "ses_thread", "--format", "json", "--auto", "-m", "model", "spatial\n\ncd work\n\nmission"]
        assert kwargs == dict(stdout="pipe", stderr="stdout", text=True, bufsize=1, cwd="work", env={"FAKE": "1"})
        step("spawn")
        return Process()

    monkeypatch.setattr(runner, "subprocess", SimpleNamespace(Popen=popen, PIPE="pipe", STDOUT="stdout"))
    monkeypatch.setattr(agent_processes, "record_process_binding", lambda *args: step("bind", *args))
    monkeypatch.setattr(runner, "send_to_repociv", send)
    monkeypatch.setattr(runner, "_es", SimpleNamespace(record_output_chunk=record))
    return SimpleNamespace(
        state=state, trace=trace,
        call=lambda: runner._run_opencode_streaming("U", "M", "mission", {}, "work", "city", "model"),
    )


@pytest.mark.parametrize(("lines", "code", "result", "emitted"), [
    ([], 0, (False, "[opencode error] empty final message"), []),
    (["  \n", "null", "[]", "true", "3", '"text"', "{}"], 0,
     (False, "[opencode error] empty final message"), []),
    ([event("text", {"text": "á"}), event("text", {"text": "b\n"})], 0,
     (True, "áb\n"), ["á\n", "b\n"]),
    ([event("text", {"text": " "})], 0, (True, " "), [" \n"]),
    ([event("text", {"text": ""}), event("text", {"text": 4}), event("text", [])], 0,
     (False, "[opencode error] empty final message"), []),
    ([event("tool_use", {"tool": "read"})], 0, (True, ""), ["🔧 read\n"]),
    ([event("tool_use", {})], 0, (True, ""), []),
    ([event("tool_use", {"tool": False})], 0, (True, ""), []),
    ([event("tool_use", [])], 0, (False, "[opencode error] empty final message"), []),
    ([event("error", error={"message": "bad"}), event("error", error={"message": "later"})], 0,
     (False, "[opencode error] bad"), []),
    ([event("error", error={"message": 23})], 0, (False, "[opencode error] 23"), []),
    ([event("error", error={"message": ""})], 0, (False, "[opencode error] unknown"), []),
    ([event("error", error=[])], 0, (False, "[opencode error] unknown"), []),
    ([event("text", {"text": "partial"}), event("error", error={"message": "bad"})], 0,
     (False, "partial[opencode error] bad"), ["partial\n"]),
    ([], 3, (False, "[opencode error] exit_3"), []),
    ([" first ", "second", "third", "fourth"], 2,
     (False, "[opencode error] second | third | fourth"), []),
    ([" a ", " b ", " spaced \n"], 2,
     (False, "[opencode error] a | b | spaced"), []),
    ([str(i) + "!" for i in range(23)], 2,
     (False, "[opencode error] 17! | 18! | 19!"), []),
    (["stray", event("text", {"text": "ok"})], 0, (True, "ok"), ["ok\n"]),
    ([event("text", {"text": "ok"})], 2, (False, "ok[opencode error] exit_2"), ["ok\n"]),
    ([event("tool_use", {"tool": "read"}), "noise"], 2,
     (False, "[opencode error] noise"), ["🔧 read\n"]),
])
def test_original_results_and_callback_order(run, lines, code, result, emitted):
    run.state.lines, run.state.code = lines, code
    assert run.call() == result
    assert run.trace[:2] == [("spawn",), ("bind", 42, "M", "U")]
    assert [e[1] for e in run.trace if e[0] == "read"] == lines
    pairs = [(name, text) for text in emitted for name in ("send", "record")]
    before_wait = run.trace[:run.trace.index(("wait", 600))]
    assert [e for e in before_wait if e[0] in {"send", "record"}] == pairs
    assert before_wait[-1] == ("eof",)
    after_wait = run.trace[run.trace.index(("wait", 600)) + 1:]
    callbacks = [e for e in after_wait if e[0] in {"send", "record"}]
    final_text = result[1].removeprefix("ok").removeprefix("partial") + "\n"
    assert callbacks == ([] if result[0] else [("send", final_text), ("record", final_text)])


@pytest.mark.parametrize("fault", ["spawn", "bind", "read", "send", "record", "eof", "wait", "returncode"])
def test_exceptions_propagate_at_original_boundary(run, fault):
    run.state.lines = [event("text", {"text": "ok"}), "never-read"]
    run.state.fault = fault
    with pytest.raises(RuntimeError, match=f"^failure:{fault}$"):
        run.call()
    assert run.trace[-1][0] == fault
    if fault in {"read", "send", "record"}:
        assert ("read", "never-read") not in run.trace
        assert ("wait", 600) not in run.trace


def test_stdout_none_assertion_preserved(run):
    run.state.stdout_none = True
    with pytest.raises(AssertionError):
        run.call()
    assert run.trace == [("spawn",), ("bind", 42, "M", "U")]


def test_callbacks_resolve_runner_globals_late(run, monkeypatch):
    run.state.lines = [event("text", {"text": "first"}), event("tool_use", {"tool": "read"})]

    def replacement_send(payload):
        run.trace.append(("new-send", payload["text"]))

    def replacement_record(mission, unit, text):
        run.trace.append(("new-record", mission, unit, text))

    def replace():
        monkeypatch.setattr(runner, "send_to_repociv", replacement_send)
        monkeypatch.setattr(runner, "_es", SimpleNamespace(record_output_chunk=replacement_record))

    run.state.on_send = replace
    assert run.call() == (True, "first")
    assert [e for e in run.trace if e[0] in {"send", "record", "new-send", "new-record"}] == [
        ("send", "first\n"), ("new-record", "M", "U", "first\n"),
        ("new-send", "🔧 read\n"), ("new-record", "M", "U", "🔧 read\n"),
    ]


@pytest.mark.parametrize("error_type", [ValueError, TypeError, RuntimeError])
def test_decoder_exception_boundary(run, monkeypatch, error_type):
    run.state.lines = ["raw"]
    run.state.code = 2

    def loads(text):
        run.trace.append(("decode", text))
        raise error_type("decoder-failure")

    monkeypatch.setattr(runner, "json", SimpleNamespace(loads=loads))
    if error_type is ValueError:
        assert run.call() == (False, "[opencode error] raw")
        assert ("wait", 600) in run.trace
    else:
        with pytest.raises(error_type, match="^decoder-failure$"):
            run.call()
        assert run.trace[-1] == ("decode", "raw")
        assert ("wait", 600) not in run.trace


def test_decoder_global_resolved_for_each_line(run, monkeypatch):
    run.state.lines = [event("text", {"text": "first"}), "not-json"]

    def replace():
        monkeypatch.setattr(runner, "json", SimpleNamespace(
            loads=lambda text: {"type": "text", "part": {"text": "second:" + text}},
        ))

    run.state.on_send = replace
    assert run.call() == (True, "firstsecond:not-json")
    assert [e for e in run.trace if e[0] == "send"] == [
        ("send", "first\n"), ("send", "second:not-json\n"),
    ]
