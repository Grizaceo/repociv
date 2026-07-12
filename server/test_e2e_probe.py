from __future__ import annotations

from server.command_schema import validate_command
from server import bridge
from server import policy as _policy


def test_e2e_probe_validates_as_low_risk_command():
    cmd = validate_command({
        "type": "e2e_probe",
        "target": "repociv-e2e",
        "payload": {"unit": "MAIN", "marker": "probe-test"},
        "created_by": "pytest",
    })

    assert cmd.type == "e2e_probe"
    assert cmd.risk == "low"


def test_validate_command_honors_client_supplied_risk():
    cmd = validate_command({
        "type": "run_tests",
        "target": "my-repo",
        "risk": "high",
    })
    assert cmd.risk == "high"


def test_validate_command_falls_back_for_invalid_risk():
    cmd = validate_command({
        "type": "run_tests",
        "target": "my-repo",
        "risk": "bananas",
    })
    assert cmd.risk == "low"


def test_e2e_probe_is_auto_safe_policy():
    cmd = validate_command({
        "type": "e2e_probe",
        "target": "repociv-e2e",
        "payload": {"unit": "MAIN", "marker": "probe-test"},
        "created_by": "pytest",
    })

    decision, reason = _policy.decide(cmd)

    assert decision == "auto-safe"
    assert reason == ""


def test_e2e_probe_dispatch_emits_mission_and_chat_events(monkeypatch, tmp_path):
    events: list[dict] = []
    monkeypatch.setattr(bridge, "send_to_repociv", lambda event: events.append(event))
    bridge.init_bridge_state(tmp_path)

    cmd = validate_command({
        "type": "e2e_probe",
        "target": "repociv-e2e",
        "payload": {"unit": "MAIN", "marker": "probe-test"},
        "created_by": "pytest",
    })
    cmd.id = "probe-cmd-1"

    bridge._dispatch_command(cmd)

    types = [evt["type"] for evt in events]
    assert types[:3] == ["mission_start", "chat_chunk", "mission_complete"]
    assert types[-1] == "log"
    assert events[0]["missionId"] == "probe-cmd-1"
    assert events[0]["questName"] == "E2E probe: probe-test"
    assert events[1]["unit"] == "MAIN"
    assert "probe-test" in events[1]["text"]
    assert events[2]["success"] is True

    log_path = tmp_path / "events.jsonl"
    assert log_path.exists()
    log_text = log_path.read_text(encoding="utf-8")
    assert "CommandCompleted" in log_text
    assert "probe-cmd-1" in log_text
    evidence = bridge._es.command_evidence("probe-cmd-1")
    assert evidence is not None
    assert evidence["artifactRefs"] == [
        {"kind": "run_state", "id": "probe-cmd-1"},
        {"kind": "session", "id": "MAIN"},
    ]
