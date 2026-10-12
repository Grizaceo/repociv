"""Native Codex hook loses workdir; correlate completed execution, not code/output."""
import json
from pathlib import Path

import pytest

from server import agent_hook_client as hc

SID = "01a13045-8b60-7d20-b303-a3adf5fa892a"
TURN = "01a13063-fa48-7552-a5d3-6ffa4dd90b48"
CALL = "exec-fb4af1f2-f901-4f9d-b8d0-46403c2f2a31"


@pytest.fixture
def native(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.delenv("CODEX_HOME", raising=False)
    path = tmp_path / ".codex/sessions/2026/10/12/rollout.jsonl"
    path.parent.mkdir(parents=True)
    meta = {"type": "session_meta", "payload": {"id": SID}}
    item = {"type": "CommandExecution", "id": CALL,
            "cwd": "file:///repo/financial%20lab", "status": "completed", "exit_code": 0,
            "aggregated_output": "SECRET /forged"}
    event = {"type": "event_msg", "payload": {"type": "item_completed", "turn_id": TURN, "item": item}}
    raw = {"session_id": SID, "cwd": "/repo/formal", "hook_event_name": "PostToolUse",
           "tool_name": "Bash", "tool_input": {"command": "pwd && git status --short"},
           "tool_use_id": CALL, "turn_id": TURN, "transcript_path": str(path),
           "tool_response": "SECRET /fake"}

    def save(entries=None):
        path.write_text("\n".join(json.dumps(e) for e in (entries or [meta, event])) + "\n")

    save()
    return raw, meta, event, save, path


def test_real_native_codex_bash_hook_recovers_exact_execution_cwd(native):
    raw, _, _, _, _ = native
    assert hc.position_payload("codex", "tool_use", raw) == {
        "cli": "codex", "event": "tool_use", "session_id": SID,
        "cwd": "/repo/financial lab", "authority": "tool"}


def test_latest_unrelated_execution_is_not_used(native):
    raw, meta, event, save, _ = native
    other = json.loads(json.dumps(event))
    other["payload"]["item"].update(id="exec-other", cwd="file:///forged")
    save([meta, event, other])
    assert hc.position_payload("codex", "tool_use", raw)["cwd"] == "/repo/financial lab"


@pytest.mark.parametrize("change", ["session", "turn", "call", "type", "kind", "status", "exit", "exit_bool", "duplicate"])
def test_exact_source_identity_and_success_required(native, change):
    raw, meta, event, save, _ = native
    p, item = event["payload"], event["payload"]["item"]
    if change == "session":
        meta["payload"]["id"] = "other"
    if change == "turn":
        p["turn_id"] = "other"
    if change == "call":
        item["id"] = "other"
    if change == "type":
        item["type"] = "AgentMessage"
    if change == "kind":
        p["type"] = "item_started"
    if change == "status":
        item["status"] = "failed"
    if change == "exit":
        item["exit_code"] = 1
    if change == "exit_bool":
        item["exit_code"] = False
    save([meta, event, event] if change == "duplicate" else [meta, event])
    assert hc.position_payload("codex", "tool_use", raw)["cwd"] == "/repo/formal"


@pytest.mark.parametrize("cwd", ["https://evil/repo", "file://evil/repo", "file:///repo?secret=x", "file:///repo#x", "relative", "file:///repo%00evil", "file:///repo%0Aevil", "file:///repo\nevil", "file:///repo\tevil", "file:///repo\revil", "file:///" + "x" * 4097])
def test_bad_native_location_is_not_used(native, cwd):
    raw, _, event, save, _ = native
    event["payload"]["item"]["cwd"] = cwd
    save()
    assert hc.position_payload("codex", "tool_use", raw)["cwd"] == "/repo/formal"


@pytest.mark.parametrize("key", ["tool_use_id", "turn_id", "transcript_path", "hook_event_name"])
def test_missing_correlation_falls_back(native, key):
    raw, _, _, _, _ = native
    del raw[key]
    assert hc.position_payload("codex", "tool_use", raw)["cwd"] == "/repo/formal"


def test_no_source_reads_for_other_cli_lifecycle_or_tool(native):
    raw, _, _, _, _ = native
    for cli, event in [("claude", "tool_use"), ("hermes", "tool_use"), ("codex", "turn_end")]:
        assert hc.position_payload(cli, event, raw)["cwd"] == "/repo/formal"
    raw["tool_name"] = "Read"
    assert hc.position_payload("codex", "tool_use", raw)["cwd"] == "/repo/formal"


def test_outside_sessions_symlink_and_missing_file_rejected(native, tmp_path):
    raw, _, _, _, path = native
    outside = tmp_path / "private.jsonl"
    outside.write_bytes(path.read_bytes())
    raw["transcript_path"] = str(outside)
    assert hc.position_payload("codex", "tool_use", raw)["cwd"] == "/repo/formal"
    link = path.parent / "alias.jsonl"
    link.symlink_to(path)
    raw["transcript_path"] = str(link)
    assert hc.position_payload("codex", "tool_use", raw)["cwd"] == "/repo/formal"
    raw["transcript_path"] = str(path.parent / "missing.jsonl")
    assert hc.position_payload("codex", "tool_use", raw)["cwd"] == "/repo/formal"


def test_bounded_tail_can_skip_partial_line(native):
    raw, meta, event, save, _ = native
    save([meta, {"type": "noise", "data": "SECRET" * 200000}, event])
    assert hc.position_payload("codex", "tool_use", raw)["cwd"] == "/repo/financial lab"


def test_malformed_tail_fails_open(native):
    raw, _, _, _, path = native
    path.write_text("bad json SECRET\n")
    assert hc.position_payload("codex", "tool_use", raw)["cwd"] == "/repo/formal"


def test_transcript_code_and_output_never_supply_location(native):
    raw, meta, _, save, _ = native
    save([meta, {"type": "response_item", "payload": {"type": "custom_tool_call", "input": "tools.exec_command({workdir:'/forged'})"}},
          {"type": "event_msg", "payload": {"type": "item_completed", "turn_id": TURN,
           "item": {"id": CALL, "type": "AgentMessage", "cwd": "file:///forged", "output": "/forged"}}}])
    assert hc.position_payload("codex", "tool_use", raw)["cwd"] == "/repo/formal"
