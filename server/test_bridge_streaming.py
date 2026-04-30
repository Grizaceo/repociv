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
