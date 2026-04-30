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
