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
        lambda unit_id, mission_id, mission, working_dir=None, city_id="": (True, "done"),
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
