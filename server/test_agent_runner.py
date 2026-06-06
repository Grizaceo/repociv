import json
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


def test_execute_streaming_cursor_bypass_uses_cursor_agent(monkeypatch):
    called = {}
    monkeypatch.setattr(agent_runner, "_container_mode_enabled", lambda: False)
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda evt: None)

    def fake_cursor_runner(unit_id, mission_id, mission, config, working_dir=None, city_id="", model=""):
        called["args"] = (unit_id, mission_id, mission, city_id, model)
        return True, "ok"

    monkeypatch.setattr(agent_runner, "_run_cursor_agent_streaming", fake_cursor_runner)

    ok, output = agent_runner._execute_streaming("CURSOR", "m-cur", "inspect repo", city_id="repociv", model="gpt-5.4")

    assert ok is True
    assert output == "ok"
    assert called["args"] == ("CURSOR", "m-cur", "inspect repo", "repociv", "gpt-5.4")


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


# ─── _repos_root() env-var priority (regression: MAP_ROOT bug) ────────────────

def test_repos_root_prefers_map_root(monkeypatch, tmp_path):
    """REPOCIV_MAP_ROOT wins over REPOCIV_REPOS_ROOT and WORKSPACE_ROOT."""
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(tmp_path / "missing-state.json"))
    map_root = tmp_path / "map"
    repos_root = tmp_path / "repos"
    ws_root = tmp_path / "ws"
    for d in (map_root, repos_root, ws_root):
        d.mkdir()
    monkeypatch.setenv("REPOCIV_MAP_ROOT", str(map_root))
    monkeypatch.setenv("REPOCIV_REPOS_ROOT", str(repos_root))
    monkeypatch.setenv("WORKSPACE_ROOT", str(ws_root))
    assert agent_runner._repos_root() == str(map_root)


def test_repos_root_falls_back_to_repos_root(monkeypatch, tmp_path):
    """When MAP_ROOT is unset, REPOCIV_REPOS_ROOT is used."""
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(tmp_path / "missing-state.json"))
    repos_root = tmp_path / "repos"
    ws_root = tmp_path / "ws"
    for d in (repos_root, ws_root):
        d.mkdir()
    monkeypatch.delenv("REPOCIV_MAP_ROOT", raising=False)
    monkeypatch.setenv("REPOCIV_REPOS_ROOT", str(repos_root))
    monkeypatch.setenv("WORKSPACE_ROOT", str(ws_root))
    assert agent_runner._repos_root() == str(repos_root)


def test_repos_root_falls_back_to_workspace_root(monkeypatch, tmp_path):
    """When MAP_ROOT and REPOS_ROOT are unset, WORKSPACE_ROOT is used."""
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(tmp_path / "missing-state.json"))
    ws_root = tmp_path / "ws"
    ws_root.mkdir()
    monkeypatch.delenv("REPOCIV_MAP_ROOT", raising=False)
    monkeypatch.delenv("REPOCIV_REPOS_ROOT", raising=False)
    monkeypatch.setenv("WORKSPACE_ROOT", str(ws_root))
    assert agent_runner._repos_root() == str(ws_root)


def test_repos_root_falls_back_to_default(monkeypatch, tmp_path):
    """When all env vars are unset, the hardcoded default is used."""
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(tmp_path / "missing-state.json"))
    monkeypatch.delenv("REPOCIV_MAP_ROOT", raising=False)
    monkeypatch.delenv("REPOCIV_REPOS_ROOT", raising=False)
    monkeypatch.delenv("WORKSPACE_ROOT", raising=False)
    from pathlib import Path
    expected = str(Path.home() / ".hermes" / "workspace" / "repos")
    assert agent_runner._repos_root() == expected


def test_repos_root_expands_tilde(monkeypatch, tmp_path):
    """The result is os.path.expanduser'd — ~ gets resolved."""
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(tmp_path / "missing-state.json"))
    monkeypatch.delenv("REPOCIV_MAP_ROOT", raising=False)
    monkeypatch.delenv("REPOCIV_REPOS_ROOT", raising=False)
    monkeypatch.setenv("WORKSPACE_ROOT", "~/my-repos")
    from pathlib import Path
    assert agent_runner._repos_root() == str(Path.home() / "my-repos")


def test_repos_root_empty_string_treated_as_unset(monkeypatch, tmp_path):
    """An empty string in MAP_ROOT must not block fallback to REPOS_ROOT/WORKSPACE_ROOT.

    os.environ.get returns '' for an empty value; the previous implementation
    used nested os.environ.get which would treat '' as truthy-ish only in
    specific fall-through patterns. The new chain uses `or`, which short-
    circuits on '', correctly falling through to the next var.
    """
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(tmp_path / "missing-state.json"))
    repos_root = tmp_path / "repos"
    repos_root.mkdir()
    monkeypatch.setenv("REPOCIV_MAP_ROOT", "")
    monkeypatch.setenv("REPOCIV_REPOS_ROOT", str(repos_root))
    assert agent_runner._repos_root() == str(repos_root)


def test_repos_root_prefers_state_file(monkeypatch, tmp_path):
    active = tmp_path / "legal-roots"
    active.mkdir()
    state_file = tmp_path / "state.json"
    state_file.write_text(
        json.dumps({
            "version": 1,
            "activeRoot": str(active),
            "roots": {str(active): {"selectedRepoPaths": []}},
        }),
        encoding="utf-8",
    )
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state_file))
    monkeypatch.setenv("REPOCIV_MAP_ROOT", "/should/not/win")

    assert agent_runner._repos_root() == str(active)


def test_resolve_city_path_decodes_repo_id(monkeypatch, tmp_path):
    repo = tmp_path / "repo-a"
    repo.mkdir()
    state_file = tmp_path / "state.json"
    state_file.write_text(
        json.dumps({"version": 1, "activeRoot": str(tmp_path), "roots": {}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("REPOCIV_STATE_FILE", str(state_file))

    repo_id = "repo:" + __import__("base64").urlsafe_b64encode(str(repo).encode("utf-8")).decode("ascii").rstrip("=")
    assert agent_runner._resolve_city_path(repo_id) == str(repo)
