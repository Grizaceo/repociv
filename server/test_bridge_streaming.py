from urllib.error import URLError

from server import bridge


def test_find_openclaw_falls_back_to_npm_global(monkeypatch, tmp_path):
    fake_home = tmp_path / "home"
    fake_bin = fake_home / ".npm-global" / "bin"
    fake_bin.mkdir(parents=True)
    fake_openclaw = fake_bin / "openclaw"
    fake_openclaw.write_text("#!/bin/sh\nexit 0\n")
    fake_openclaw.chmod(0o755)

    monkeypatch.setattr(bridge.shutil, "which", lambda _name: None)
    monkeypatch.setattr(bridge.Path, "home", lambda: fake_home)

    assert bridge._find_openclaw() == str(fake_openclaw)


def test_run_hermes_streaming_emits_chat_chunk_on_transport_error(monkeypatch):
    sent = []
    recorded = []

    def fake_urlopen(*_args, **_kwargs):
        raise URLError("connection refused")

    monkeypatch.setattr(bridge.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(bridge, "send_to_repociv", lambda evt: sent.append(evt))
    monkeypatch.setattr(bridge._es, "record_output_chunk", lambda mission_id, unit_id, text: recorded.append((mission_id, unit_id, text)))

    ok, output = bridge._run_hermes_streaming("DAVI", "m1", "hola")

    assert ok is False
    assert "connection refused" in output
    assert sent == [{
        "type": "chat_chunk",
        "unit": "DAVI",
        "missionId": "m1",
        "text": "[hermes error] <urlopen error connection refused>\n",
    }]
    assert recorded == [("m1", "DAVI", "[hermes error] <urlopen error connection refused>\n")]


def test_send_to_repociv_chat_chunk_updates_session(monkeypatch, tmp_path):
    bridge._sessions.init(tmp_path)
    monkeypatch.setattr(bridge, "_fanout_sse", lambda _event: None)
    monkeypatch.setattr(bridge.urllib.request, "urlopen", lambda *_args, **_kwargs: None)

    bridge.send_to_repociv({"type": "chat_chunk", "unit": "DAVI", "missionId": "m9", "text": "hola"})

    canonical = bridge._sessions.get_or_create("DAVI")
    recent = bridge._sessions.get_recent("DAVI", limit=1)
    assert canonical["lastMissionId"] == "m9"
    assert canonical["messageCount"] == 1
    assert recent[0]["content"] == "hola"


def test_run_hermes_streaming_forwards_model(monkeypatch):
    """El facade bridge._run_hermes_streaming debe pasar 'model' al agent_runner."""
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return True, "ok"

    monkeypatch.setattr(bridge._agent_runner, "_run_hermes_streaming", fake_run)

    bridge._run_hermes_streaming("U1", "M1", "hello", model="kimi-k2.6")

    assert len(calls) == 1
    args, kwargs = calls[0]
    # args = (unit_id, mission_id, mission, config, working_dir, city_id, model)
    assert args[-1] == "kimi-k2.6"
