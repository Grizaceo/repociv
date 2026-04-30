from __future__ import annotations

from server.command_schema import validate_command
from server import bridge
from server import policy as _policy


def test_e2e_probe_validates_as_low_risk_command():
    cmd = validate_command({
        "type": "e2e_probe",
        "target": "repociv-e2e",
        "payload": {"unit": "DAVI", "marker": "probe-test"},
        "created_by": "pytest",
    })

    assert cmd.type == "e2e_probe"
    assert cmd.risk == "low"


def test_e2e_probe_is_auto_safe_policy():
    cmd = validate_command({
        "type": "e2e_probe",
        "target": "repociv-e2e",
        "payload": {"unit": "DAVI", "marker": "probe-test"},
        "created_by": "pytest",
    })

    decision, reason = _policy.decide(cmd)

    assert decision == "auto-safe"
    assert reason == ""


def test_e2e_probe_dispatch_emits_mission_chat_and_terminal_events(monkeypatch, tmp_path):
    events: list[dict] = []
    monkeypatch.setattr(bridge, "send_to_repociv", lambda event: events.append(event))
    bridge._es.init(tmp_path)

    cmd = validate_command({
        "type": "e2e_probe",
        "target": "repociv-e2e",
        "payload": {"unit": "DAVI", "marker": "probe-test"},
        "created_by": "pytest",
    })
    cmd.id = "probe-cmd-1"

    bridge._dispatch_command(cmd)

    types = [evt["type"] for evt in events]
    assert types[:3] == ["mission_start", "chat_chunk", "mission_complete"]
    assert types[-1] == "log"
    assert events[0]["missionId"] == "probe-cmd-1"
    assert events[0]["questName"] == "E2E probe: probe-test"
    assert events[1]["unit"] == "DAVI"
    assert "probe-test" in events[1]["text"]
    assert events[2]["success"] is True

    stored = bridge._es.read_events(since=0)
    assert any(evt["type"] == "CommandCompleted" and evt["commandId"] == "probe-cmd-1" for evt in stored)
