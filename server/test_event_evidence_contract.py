from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from server import event_store, run_state
from server.command_schema import Command
from server.context_pack import build_context_pack
from server.routes.core import get_command_artifacts


def make_command(command_id: str = "cmd-contract") -> Command:
    return Command(
        id=command_id,
        type="execute_agent",
        target="repo-a",
        payload={
            "unit": "WORKER",
            "city": "repo-a",
            "repoPath": "/workspace/repo-a",
            "mission": "Implement",
            "model": "sonnet",
        },
        risk="medium",
        created_by="user",
    )


def test_terminal_event_is_versioned_and_self_describing(monkeypatch, tmp_path: Path):
    event_store.init(tmp_path)
    monkeypatch.setattr(event_store, "_ledger_ingest", lambda _event: None)
    cmd = make_command()
    event_store.record_created(cmd.id, cmd.created_by, asdict(cmd))
    event_store.record_started(cmd.id)
    event_store.record_completed(
        cmd.id,
        "done",
        {
            "durationS": 2.5,
            "artifactRefs": [
                {"kind": "run_state", "id": cmd.id},
                {"kind": "session", "id": "WORKER"},
            ],
        },
    )

    events = event_store.read_command_events(cmd.id)
    assert [event["type"] for event in events] == [
        "CommandCreated",
        "CommandStarted",
        "CommandCompleted",
    ]
    assert all(event["schemaVersion"] == 1 for event in events)
    terminal = events[-1]
    assert terminal["actor"] == "WORKER"
    assert terminal["data"] == {
        "status": "completed",
        "outcome": "success",
        "commandType": "execute_agent",
        "target": "repo-a",
        "repoPath": "/workspace/repo-a",
        "unitId": "WORKER",
        "model": "sonnet",
        "startedAt": terminal["data"]["startedAt"],
        "finishedAt": terminal["data"]["finishedAt"],
        "durationS": 2.5,
        "result": "done",
        "error": "",
        "reason": "",
        "artifactRefs": [
            {"kind": "run_state", "id": cmd.id},
            {"kind": "session", "id": "WORKER"},
        ],
    }


def test_terminal_context_survives_process_cache_loss(monkeypatch, tmp_path: Path):
    event_store.init(tmp_path)
    monkeypatch.setattr(event_store, "_ledger_ingest", lambda _event: None)
    cmd = make_command("cmd-restart")
    event_store.record_created(cmd.id, cmd.created_by, asdict(cmd))
    event_store.record_started(cmd.id)
    event_store._command_contexts.clear()
    event_store.record_failed(cmd.id, "after restart")

    terminal = event_store.read_command_events(cmd.id)[-1]
    assert terminal["data"]["repoPath"] == "/workspace/repo-a"
    assert terminal["data"]["unitId"] == "WORKER"
    assert terminal["data"]["commandType"] == "execute_agent"
    assert terminal["data"]["startedAt"] > 0
    assert terminal["data"]["durationS"] >= 0


def test_context_pack_reads_canonical_nested_event_shape(monkeypatch, tmp_path: Path):
    event_store.init(tmp_path)
    monkeypatch.setattr(event_store, "_ledger_ingest", lambda _event: None)
    cmd = make_command("cmd-context")
    event_store.record_created(cmd.id, cmd.created_by, asdict(cmd))
    event_store.record_started(cmd.id)
    event_store.record_failed(cmd.id, "timeout", {"durationS": 3.0})

    pack = build_context_pack("WORKER", "/workspace/repo-a", event_store)
    assert pack["last_status"] == "failed"
    assert pack["last_error"] == "timeout"
    assert pack["recent_events"][-1]["commandId"] == cmd.id
    assert pack["recent_events"][-1]["data"]["repoPath"] == "/workspace/repo-a"


def test_command_artifact_endpoint_joins_events_and_run_state(monkeypatch, tmp_path: Path):
    event_store.init(tmp_path)
    run_state.init(tmp_path)
    monkeypatch.setattr(event_store, "_ledger_ingest", lambda _event: None)
    cmd = make_command("cmd-artifacts")
    event_store.record_created(cmd.id, cmd.created_by, asdict(cmd))
    event_store.record_started(cmd.id)
    run_state.save(
        cmd.id,
        {
            "status": "completed",
            "filesTouched": ["src/main.ts"],
            "result": "done",
        },
    )
    event_store.record_completed(
        cmd.id,
        "done",
        {"artifactRefs": [{"kind": "run_state", "id": cmd.id}]},
    )

    status, body = get_command_artifacts({"command_id": cmd.id})
    assert status == 200
    assert body["commandId"] == cmd.id
    assert body["terminalEvent"]["type"] == "CommandCompleted"
    assert body["runState"]["filesTouched"] == ["src/main.ts"]
    assert body["artifactRefs"] == [{"kind": "run_state", "id": cmd.id}]


def test_command_artifact_endpoint_404_for_unknown(tmp_path: Path):
    event_store.init(tmp_path)
    run_state.init(tmp_path)
    assert get_command_artifacts({"command_id": "missing"})[0] == 404
