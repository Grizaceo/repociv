from server import agent_runner


def test_run_codex_streaming_emits_only_last_message(monkeypatch, tmp_path):
    sent = []
    recorded = []

    class FakeProc:
        returncode = 0

        def __init__(self, cmd, **kwargs):
            self.cmd = cmd
            self.kwargs = kwargs

        def communicate(self, timeout=None):
            last_message_path = self.cmd[self.cmd.index("--output-last-message") + 1]
            with open(last_message_path, "w", encoding="utf-8") as f:
                f.write("respuesta final\n")
            return None, "codex banner that must not be streamed"

    monkeypatch.setattr(agent_runner, "_find_codex", lambda: "/usr/bin/codex")
    monkeypatch.setattr(agent_runner.subprocess, "Popen", FakeProc)
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda evt: sent.append(evt))
    monkeypatch.setattr(
        agent_runner._es,
        "record_output_chunk",
        lambda mission_id, unit_id, text: recorded.append((mission_id, unit_id, text)),
    )

    ok, output = agent_runner._run_codex_streaming(
        "WORKER", "m-codex", "haz algo", {"agent": "worker"}, working_dir=str(tmp_path), city_id="repociv"
    )

    assert ok is True
    assert output == "respuesta final"
    assert sent == [{"type": "chat_chunk", "unit": "WORKER", "missionId": "m-codex", "text": "respuesta final\n"}]
    assert recorded == [("m-codex", "WORKER", "respuesta final\n")]


def test_run_codex_streaming_reports_stderr_on_failure(monkeypatch, tmp_path):
    sent = []
    recorded = []

    class FakeProc:
        returncode = 7

        def __init__(self, cmd, **kwargs):
            self.cmd = cmd
            self.kwargs = kwargs

        def communicate(self, timeout=None):
            return None, "auth failed"

    monkeypatch.setattr(agent_runner, "_find_codex", lambda: "/usr/bin/codex")
    monkeypatch.setattr(agent_runner.subprocess, "Popen", FakeProc)
    monkeypatch.setattr(agent_runner, "send_to_repociv", lambda evt: sent.append(evt))
    monkeypatch.setattr(
        agent_runner._es,
        "record_output_chunk",
        lambda mission_id, unit_id, text: recorded.append((mission_id, unit_id, text)),
    )

    ok, output = agent_runner._run_codex_streaming(
        "WORKER", "m-codex", "haz algo", {"agent": "worker"}, working_dir=str(tmp_path), city_id="repociv"
    )

    assert ok is False
    assert output == "[codex error] auth failed"
    assert sent == [{"type": "chat_chunk", "unit": "WORKER", "missionId": "m-codex", "text": "[codex error] auth failed\n"}]
    assert recorded == [("m-codex", "WORKER", "[codex error] auth failed\n")]