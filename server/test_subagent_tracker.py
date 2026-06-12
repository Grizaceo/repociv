"""Tests for subagent_tracker lifecycle."""

from server import subagent_tracker as st
from server import event_store as es


def _reset_tracker():
    st._runs.clear()
    st._tool_use_map.clear()
    st._pending_spawn.clear()
    st._last_progress_at.clear()


def test_register_spawn_and_complete(monkeypatch, tmp_path):
    _reset_tracker()
    sent = []
    es.init(tmp_path)
    st.configure(send=lambda e: sent.append(e))

    run = st.register_spawn(
        parent_mission_id="m1",
        parent_unit="MAIN",
        kind="explore",
        label="scan repos/repociv",
        parent_city="repociv",
    )
    assert run["id"].startswith("sub-")
    assert run["status"] == "running"
    assert any(e["type"] == "subagent_spawn" for e in sent)
    assert any(e["type"] == "unit_spawn" and e.get("ephemeral") for e in sent)

    active = st.list_active("MAIN")
    assert len(active) == 1

    finished = st.register_complete(run["id"], success=True, summary="done")
    assert finished is not None
    assert finished["status"] == "complete"
    assert st.list_active("MAIN") == []
    assert any(e["type"] == "subagent_complete" for e in sent)
    assert any(e["type"] == "unit_despawn" for e in sent)


def test_map_kind_to_unit_type():
    assert st.map_kind_to_unit_type("explore") == "scout"
    assert st.map_kind_to_unit_type("shell") == "worker"


def test_infer_target_city():
    assert st.infer_target_city("explore /tmp/workspace/repos/other", "repociv") == "other"


def test_request_cancel_not_found():
    result = st.request_cancel("sub-deadbeef")
    assert result["ok"] is False
    assert result["error"] == "not_found"


def test_request_cancel_running(monkeypatch, tmp_path):
    _reset_tracker()
    sent = []
    es.init(tmp_path)
    st.configure(send=lambda e: sent.append(e))

    run = st.register_spawn(
        parent_mission_id="m1",
        parent_unit="MAIN",
        kind="explore",
        label="scan",
        parent_city="repociv",
    )
    result = st.request_cancel(run["id"])
    assert result["ok"] is True
    assert any(e["type"] == "subagent_cancel" for e in sent)
    complete = next(e for e in sent if e["type"] == "subagent_complete")
    assert complete["success"] is False
    assert any(e["type"] == "unit_despawn" for e in sent)
    assert st.list_active("MAIN") == []
    finished = st.get_run(run["id"])
    assert finished is not None
    assert finished["status"] == "cancelled"


def test_extract_output_file_path():
    text = '{"output_file":"/tmp/agent-out.txt","summary":"done"}'
    assert st._extract_output_file_path(text) == "/tmp/agent-out.txt"


def test_register_spawn_includes_status_in_event(monkeypatch, tmp_path):
    _reset_tracker()
    sent = []
    es.init(tmp_path)
    st.configure(send=lambda e: sent.append(e))

    st.register_spawn(
        parent_mission_id="m1",
        parent_unit="MAIN",
        kind="explore",
        label="scan",
        status="running",
    )
    spawn_evt = next(e for e in sent if e["type"] == "subagent_spawn")
    assert spawn_evt.get("status") == "running"


def test_proposed_spawn_emits_no_unit_spawn(monkeypatch, tmp_path):
    _reset_tracker()
    sent = []
    es.init(tmp_path)
    st.configure(send=lambda e: sent.append(e))

    st.register_spawn(
        parent_mission_id="m1",
        parent_unit="MAIN",
        kind="explore",
        label="risky task",
        status="proposed",
        risk="destructive",
    )
    assert any(e["type"] == "subagent_spawn" and e.get("status") == "proposed" for e in sent)
    assert not any(e["type"] == "unit_spawn" for e in sent)


def test_process_cursor_task_spawn(monkeypatch, tmp_path):
    _reset_tracker()
    sent = []
    es.init(tmp_path)
    st.configure(send=lambda e: sent.append(e))
    line = (
        '{"type":"tool_use","name":"Task","id":"tu-1","input":'
        '{"subagent_type":"explore","description":"find bugs","run_in_background":true}}'
    )
    st.process_cursor_ndjson_line(line, mission_id="m9", unit_id="MAIN", city_id="repociv")
    assert any(e["type"] == "subagent_spawn" for e in sent)


def test_register_spawn_emits_progress(monkeypatch, tmp_path):
    _reset_tracker()
    sent = []
    es.init(tmp_path)
    st.configure(send=lambda e: sent.append(e))

    st.register_spawn(
        parent_mission_id="m1",
        parent_unit="MAIN",
        kind="explore",
        label="scan repos",
        parent_harness="cursor",
        harness="cursor",
    )
    progress = [e for e in sent if e["type"] == "subagent_progress"]
    assert len(progress) >= 2
    spawn_evt = next(e for e in sent if e["type"] == "subagent_spawn")
    assert spawn_evt.get("harness") == "cursor"
    assert spawn_evt.get("parentHarness") == "cursor"


def test_process_claude_task_spawn(monkeypatch, tmp_path):
    _reset_tracker()
    sent = []
    es.init(tmp_path)
    st.configure(send=lambda e: sent.append(e))
    from server.mission_harness import MissionHarnessContext

    ctx = MissionHarnessContext(
        mission_id="m9",
        unit_id="MAIN",
        city_id="repociv",
        resolved_harness="claude-code",
    )
    line = (
        '{"type":"tool_use","name":"Task","id":"tu-cl","input":'
        '{"subagent_type":"explore","description":"claude scan","run_in_background":true}}'
    )
    st.process_claude_stream_line(line, ctx=ctx)
    spawn = next(e for e in sent if e["type"] == "subagent_spawn")
    assert spawn.get("harness") == "claude-code"


def test_process_cursor_task_complete(monkeypatch, tmp_path):
    _reset_tracker()
    sent = []
    es.init(tmp_path)
    st.configure(send=lambda e: sent.append(e))
    spawn_line = (
        '{"type":"tool_use","name":"Task","id":"tu-2","input":'
        '{"subagent_type":"explore","description":"scan","run_in_background":true}}'
    )
    st.process_cursor_ndjson_line(spawn_line, mission_id="m9", unit_id="MAIN")
    complete_line = '{"type":"tool_result","tool_use_id":"tu-2","content":"all good"}'
    st.process_cursor_ndjson_line(complete_line, mission_id="m9", unit_id="MAIN")
    assert any(e["type"] == "subagent_complete" for e in sent)
