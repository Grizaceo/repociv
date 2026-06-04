from urllib.error import URLError

from server import agent_runner


def test_run_hermes_streaming_sends_working_directory(monkeypatch, tmp_path):
    captured = {}
    sent = []
    recorded = []

    class FakeResponse:
        def __enter__(self):
            return self
        def __exit__(self, *_args):
            return False
        def read(self):
            return b'{"choices":[{"message":{"content":"ok"}}]}'

    def fake_urlopen(req, timeout=0):
        captured["payload"] = req.data
        return FakeResponse()

    monkeypatch.setattr(agent_runner.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda evt: sent.append(evt))
    monkeypatch.setattr(agent_runner._es, "record_output_chunk", lambda mission_id, unit_id, text: recorded.append((mission_id, unit_id, text)))

    ok, output = agent_runner._run_hermes_streaming("DAVI", "m1", "hola", working_dir=str(tmp_path))

    assert ok is True
    assert output == "ok"
    assert f'"working_directory": "{tmp_path}"'.encode() in captured["payload"]
    assert sent[-1] == {"type": "chat_chunk", "unit": "DAVI", "missionId": "m1", "text": "ok"}
    assert recorded[-1] == ("m1", "DAVI", "ok")


def test_run_hermes_streaming_emits_visible_error(monkeypatch):
    sent = []
    recorded = []

    def fake_urlopen(*_args, **_kwargs):
        raise URLError("connection refused")

    monkeypatch.setattr(agent_runner.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda evt: sent.append(evt))
    monkeypatch.setattr(agent_runner._es, "record_output_chunk", lambda mission_id, unit_id, text: recorded.append((mission_id, unit_id, text)))

    ok, output = agent_runner._run_hermes_streaming("DAVI", "m1", "hola")

    assert ok is False
    assert "connection refused" in output
    assert sent == [{"type": "chat_chunk", "unit": "DAVI", "missionId": "m1", "text": "[hermes error] <urlopen error connection refused>\n"}]
    assert recorded == [("m1", "DAVI", "[hermes error] <urlopen error connection refused>\n")]


def test_run_agent_persists_session_and_run_state(monkeypatch, tmp_path):
    sent = []
    saved = []
    completions = []
    failures = []
    outcomes = []

    agent_runner._sessions.init(tmp_path)
    agent_runner._run_state.init(tmp_path)

    monkeypatch.setattr(agent_runner, "save_mission", lambda mission: saved.append(dict(mission)))
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda evt: sent.append(dict(evt)))
    monkeypatch.setattr(agent_runner._es, "record_started", lambda mission_id: None)
    monkeypatch.setattr(agent_runner._es, "record_completed", lambda mission_id, result='': completions.append((mission_id, result)))
    monkeypatch.setattr(agent_runner._es, "record_failed", lambda mission_id, error='': failures.append((mission_id, error)))
    monkeypatch.setattr(agent_runner._ds, "record_outcome", lambda mission_id, status, duration: outcomes.append((mission_id, status)))
    monkeypatch.setattr(agent_runner, "_resolve_city_path", lambda city_id: f"/tmp/{city_id}")
    monkeypatch.setattr(
        agent_runner,
        "_execute_streaming",
        lambda *args, **kwargs: (True, "done"),
    )

    agent_runner.run_agent("DAVI", "repociv", "arregla tests", command_id="m42")

    canonical = agent_runner._sessions.get_or_create("DAVI")
    run_state = agent_runner._run_state.load("m42")

    assert canonical["repo"] == "repociv"
    assert canonical["workingDirectory"] == "/tmp/repociv"
    assert canonical["lastMissionId"] == "m42"
    assert canonical["messageCount"] == 1
    assert run_state is not None
    assert run_state["status"] == "completed"
    assert run_state["phase"] == "completed"
    assert completions == [("m42", "done")]
    assert failures == []
    assert outcomes == [("m42", "success")]


# ─── cursor-agent harness ──────────────────────────────────────────────────────

def test_find_cursor_agent_returns_none_when_not_installed(monkeypatch):
    """_find_cursor_agent() returns None when the binary is absent."""
    monkeypatch.setattr(agent_runner.shutil, "which", lambda _name: None)
    # Patch Path.exists to False for all cursor-agent candidate paths
    from unittest.mock import patch
    with patch("pathlib.Path.exists", return_value=False):
        result = agent_runner._find_cursor_agent()
    assert result is None


def test_has_cursor_false_when_agent_not_installed(monkeypatch):
    """`_has_cursor()` is False when cursor-agent is absent."""
    monkeypatch.setattr(agent_runner, "_find_cursor_agent", lambda: None)
    assert agent_runner._has_cursor() is False


def test_run_cursor_agent_streaming_missing_binary(monkeypatch):
    """Returns (False, error) with an install hint when cursor-agent is absent."""
    sent = []
    recorded = []
    monkeypatch.setattr(agent_runner, "_find_cursor_agent", lambda: None)
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda evt: sent.append(evt))
    monkeypatch.setattr(agent_runner._es, "record_output_chunk",
                        lambda m, u, t: recorded.append(t))

    ok, output = agent_runner._run_cursor_agent_streaming("WORKER", "m1", "list files", config={})

    assert ok is False
    assert "cursor-agent not found" in output
    assert "cursor.com/install" in output
    assert sent[0]["type"] == "chat_chunk"


class TestParseCursorNdjsonChunk:
    """Unit tests for the NDJSON chunk parser."""

    def test_empty_line_returns_empty(self):
        assert agent_runner._parse_cursor_ndjson_chunk("") == ""
        assert agent_runner._parse_cursor_ndjson_chunk("   ") == ""

    def test_text_event_returns_text(self):
        line = '{"type": "text", "text": "hello world"}'
        assert agent_runner._parse_cursor_ndjson_chunk(line) == "hello world"

    def test_assistant_event_extracts_content_array(self):
        line = '{"type": "assistant", "message": {"content": [{"type": "text", "text": "done"}, {"type": "tool_use"}]}}'
        assert agent_runner._parse_cursor_ndjson_chunk(line) == "done"

    def test_assistant_event_string_content(self):
        line = '{"type": "assistant", "message": {"content": "simple string"}}'
        assert agent_runner._parse_cursor_ndjson_chunk(line) == "simple string"

    def test_tool_use_event_filtered_out(self):
        line = '{"type": "tool_use", "name": "read_file", "input": {}}'
        assert agent_runner._parse_cursor_ndjson_chunk(line) == ""

    def test_tool_result_filtered_out(self):
        line = '{"type": "tool_result", "content": "file contents"}'
        assert agent_runner._parse_cursor_ndjson_chunk(line) == ""

    def test_ping_filtered_out(self):
        assert agent_runner._parse_cursor_ndjson_chunk('{"type": "ping"}') == ""

    def test_result_event(self):
        line = '{"type": "result", "output": "task complete"}'
        assert agent_runner._parse_cursor_ndjson_chunk(line) == "task complete"

    def test_invalid_json_returns_raw_line(self):
        raw = "plain text output not json"
        assert agent_runner._parse_cursor_ndjson_chunk(raw) == raw

    def test_unknown_type_returns_empty(self):
        line = '{"type": "metadata", "tokens": 42}'
        assert agent_runner._parse_cursor_ndjson_chunk(line) == ""


def test_run_cursor_agent_streaming_success(monkeypatch, tmp_path):
    """Full streaming path with a fake cursor-agent subprocess."""
    import subprocess as _sp
    from io import StringIO

    sent = []
    recorded = []
    monkeypatch.setattr(agent_runner, "_find_cursor_agent", lambda: "/fake/cursor-agent")
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda evt: sent.append(evt))
    monkeypatch.setattr(agent_runner._es, "record_output_chunk",
                        lambda m, u, t: recorded.append(t))

    # Simulate cursor-agent emitting NDJSON lines
    fake_ndjson = "\n".join([
        '{"type": "text", "text": "Analyzing repo..."}',
        '{"type": "tool_use", "name": "read_file"}',   # should be filtered
        '{"type": "text", "text": "Done."}',
        "",
    ])

    class FakeProc:
        returncode = 0
        stdout = StringIO(fake_ndjson)
        def wait(self, timeout=None): pass

    monkeypatch.setattr(_sp, "Popen", lambda *_a, **_kw: FakeProc())

    ok, output = agent_runner._run_cursor_agent_streaming(
        "WORKER", "m99", "inspect repo", config={}, working_dir=str(tmp_path)
    )

    assert ok is True
    assert output == "Analyzing repo...Done."
    # tool_use was filtered — only 2 text chunks + 1 harness announcement
    text_chunks = [e["text"] for e in sent if e["type"] == "chat_chunk"]
    assert "[harness: cursor-agent]" in text_chunks[0]
    assert "Analyzing repo..." in text_chunks[1]
    assert "Done." in text_chunks[2]
    assert not any("tool_use" in c for c in text_chunks)


def test_cursor_streaming_detects_background_task(monkeypatch, tmp_path):
    """Task tool_use with run_in_background triggers subagent_tracker."""
    import subprocess as _sp
    from io import StringIO
    from server import subagent_tracker as _st

    _st._runs.clear()
    _st._tool_use_map.clear()
    sent = []
    monkeypatch.setattr(agent_runner, "_find_cursor_agent", lambda: "/fake/cursor-agent")
    monkeypatch.setattr(agent_runner._es, "record_output_chunk", lambda *_a: None)
    agentpatch = lambda evt: sent.append(evt)
    agent_runner.configure(send=agentpatch)

    fake_ndjson = "\n".join([
        '{"type":"tool_use","name":"Task","id":"tu-bg","input":'
        '{"subagent_type":"explore","description":"scan","run_in_background":true}}',
        '{"type":"tool_result","tool_use_id":"tu-bg","content":"summary text"}',
    ])

    class FakeProc:
        returncode = 0
        stdout = StringIO(fake_ndjson)
        def wait(self, timeout=None): pass

    monkeypatch.setattr(_sp, "Popen", lambda *_a, **_kw: FakeProc())

    ok, _output = agent_runner._run_cursor_agent_streaming(
        "DAVI", "m-task", "mission", config={}, working_dir=str(tmp_path), city_id="repociv",
    )
    assert ok is True
    assert any(e.get("type") == "subagent_spawn" for e in sent)
    assert any(e.get("type") == "subagent_complete" for e in sent)


def test_run_cursor_agent_streaming_model_flag(monkeypatch, tmp_path):
    """--model flag is passed when a model is specified."""
    import subprocess as _sp
    from io import StringIO

    captured_cmd = []
    monkeypatch.setattr(agent_runner, "_find_cursor_agent", lambda: "/fake/cursor-agent")
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda _e: None)
    monkeypatch.setattr(agent_runner._es, "record_output_chunk", lambda *_a: None)

    class FakeProc:
        returncode = 0
        stdout = StringIO("")
        def wait(self, timeout=None): pass

    def fake_popen(cmd, **_kw):
        captured_cmd.extend(cmd)
        return FakeProc()

    monkeypatch.setattr(_sp, "Popen", fake_popen)

    agent_runner._run_cursor_agent_streaming(
        "WORKER", "m1", "task", config={}, model="claude-opus-4-5", working_dir=str(tmp_path)
    )

    assert "--model" in captured_cmd
    assert "claude-opus-4-5" in captured_cmd
    assert "--workspace" in captured_cmd
    assert "--trust" in captured_cmd
    assert "--print" in captured_cmd
