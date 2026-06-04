"""Tests for subagent_tracker lifecycle."""

from server import subagent_tracker as st
from server import event_store as es


def _reset_tracker():
    st._runs.clear()
    st._tool_use_map.clear()
    st._pending_spawn.clear()


def test_register_spawn_and_complete(monkeypatch, tmp_path):
    _reset_tracker()
    sent = []
    es.init(tmp_path)
    st.configure(send=lambda e: sent.append(e))

    run = st.register_spawn(
        parent_mission_id="m1",
        parent_unit="DAVI",
        kind="explore",
        label="scan repos/repociv",
        parent_city="repociv",
    )
    assert run["id"].startswith("sub-")
    assert run["status"] == "running"
    assert any(e["type"] == "subagent_spawn" for e in sent)
    assert any(e["type"] == "unit_spawn" and e.get("ephemeral") for e in sent)

    active = st.list_active("DAVI")
    assert len(active) == 1

    finished = st.register_complete(run["id"], success=True, summary="done")
    assert finished is not None
    assert finished["status"] == "complete"
    assert st.list_active("DAVI") == []
    assert any(e["type"] == "subagent_complete" for e in sent)
    assert any(e["type"] == "unit_despawn" for e in sent)


def test_map_kind_to_unit_type():
    assert st.map_kind_to_unit_type("explore") == "scout"
    assert st.map_kind_to_unit_type("shell") == "worker"


def test_infer_target_city():
    assert st.infer_target_city("explore /home/gris/.hermes/workspace/repos/other", "repociv") == "other"


def test_request_cancel_stub():
    result = st.request_cancel("sub-deadbeef")
    assert result["ok"] is False
    assert "not_implemented" in result["error"]


def test_register_spawn_includes_status_in_event(monkeypatch, tmp_path):
    _reset_tracker()
    sent = []
    es.init(tmp_path)
    st.configure(send=lambda e: sent.append(e))

    st.register_spawn(
        parent_mission_id="m1",
        parent_unit="DAVI",
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
        parent_unit="DAVI",
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
    st.process_cursor_ndjson_line(line, mission_id="m9", unit_id="DAVI", city_id="repociv")
    assert any(e["type"] == "subagent_spawn" for e in sent)


def test_process_cursor_task_complete(monkeypatch, tmp_path):
    _reset_tracker()
    sent = []
    es.init(tmp_path)
    st.configure(send=lambda e: sent.append(e))
    spawn_line = (
        '{"type":"tool_use","name":"Task","id":"tu-2","input":'
        '{"subagent_type":"explore","description":"scan","run_in_background":true}}'
    )
    st.process_cursor_ndjson_line(spawn_line, mission_id="m9", unit_id="DAVI")
    complete_line = '{"type":"tool_result","tool_use_id":"tu-2","content":"all good"}'
    st.process_cursor_ndjson_line(complete_line, mission_id="m9", unit_id="DAVI")
    assert any(e["type"] == "subagent_complete" for e in sent)
