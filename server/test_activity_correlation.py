"""Isolated canonical history tests: no agent launch, no real user tasks."""
import json
from server import agent_processes as ap, event_store as es
from server.routes.core import get_log


def test_identity_start_ticks_boot_and_exit(tmp_path):
    boot = tmp_path / "sys/kernel/random/boot_id"
    boot.parent.mkdir(parents=True)
    boot.write_text("boot1")
    folder = tmp_path / "10"
    folder.mkdir()
    stat = folder / "stat"
    stat.write_text("10 (worker (helper)) " + " ".join(["S", "1"] + ["0"] * 17 + ["100"]))
    assert ap.process_identity(10, tmp_path) == "boot1:10:100"
    stat.write_text(stat.read_text().replace("100", "200"))
    assert ap.process_identity(10, tmp_path) == "boot1:10:200"
    boot.write_text("boot2")
    assert ap.process_identity(10, tmp_path) == "boot2:10:200"
    boot.write_text("boot:malformed")
    assert ap.process_identity(10, tmp_path) is None
    stat.unlink()
    assert ap.process_identity(10, tmp_path) is None


def test_explicit_binding_and_fail_open(monkeypatch):
    events = []
    monkeypatch.setattr(ap, "process_identity", lambda pid: "boot:10:100")
    monkeypatch.setattr(es, "record_event", lambda kind, data, **_kw: events.append((kind, data)))
    ap.record_process_binding(10, "run", "WORKER")
    assert events == [("ProcessBound", {"commandId": "run", "agentId": "WORKER", "pid": 10, "processIdentity": "boot:10:100"})]
    monkeypatch.setattr(ap, "process_identity", lambda pid: None)
    ap.record_process_binding(10, "run", "WORKER")
    assert len(events) == 1
    monkeypatch.setattr(ap, "process_identity", lambda pid: "boot:10:100")
    def broken(*args, **_kw):
        raise OSError("private disk path")
    monkeypatch.setattr(es, "record_event", broken)
    ap.record_process_binding(10, "run", "WORKER")


def test_metadata_history_survives_chunks_and_excludes_private_data(tmp_path, monkeypatch):
    from server import bridge  # initialize once before rebinding the canonical store
    assert bridge._es is es
    path = tmp_path / "events.jsonl"
    monkeypatch.setattr(es, "_store_path", path)
    es.record_event("TaskRunLinked", {"runId": "run", "commandId": "run", "taskKey": "repo::issue"})
    es.record_event("ProcessBound", {"commandId": "run", "processIdentity": "boot:10:100", "pid": 10, "argv": "SECRET"})
    es.record_completed("run", "SECRET")
    es.record_event("TaskPhaseRecorded", {"taskKey": "repo::issue", "phase": "complete", "prompt": "SECRET"})
    for i in range(600):
        es.record_output_chunk("run", "SECRET", "SECRET")
    es.record_started("new")
    with path.open("a") as f:
        f.write('not json\n[]\n{"type":"other","data":[]}\n')
    before = path.read_bytes()
    rows = []
    params = {"metadata": "1", "paged": "1", "n": "1"}
    while True:
        code, page = get_log({"params": params})
        assert code == 200
        assert len(page["events"]) <= 1
        rows = page["events"] + rows
        if not page["more"]:
            break
        params["before"] = str(page["before"])

    assert {e["type"] for e in rows} >= {"TaskRunLinked", "ProcessBound", "CommandCompleted", "TaskPhaseRecorded"}
    assert "SECRET" not in json.dumps(rows)
    assert "AgentOutputChunk" not in json.dumps(rows)
    assert [e["type"] for e in rows[:4]] == ["TaskRunLinked", "ProcessBound", "CommandCompleted", "TaskPhaseRecorded"]
    assert len({e["id"] for e in rows if e["id"]}) == len([e for e in rows if e["id"]])
    assert path.read_bytes() == before


def test_phase_history_records_declared_state_only(monkeypatch):
    from server import task_orchestrator as to
    events = []
    monkeypatch.setattr(es, "record_event", lambda kind, data, **_kw: events.append((kind, data)))
    for phase in ("executing", "complete", "failed", "cancelled"):
        to._record_task_phase("repo::issue", {"phase": phase, "lastError": "SECRET"})
    assert [data["phase"] for _, data in events] == ["executing", "complete", "failed", "cancelled"]
    assert "SECRET" not in str(events)


def test_metadata_pages_bound_response_and_read_work(tmp_path, monkeypatch):
    from server import bridge
    assert bridge._es is es
    path = tmp_path / "large.jsonl"
    with path.open("w") as stream:
        for index in range(1200):
            stream.write(json.dumps({"id": str(index), "type": "CommandCompleted", "commandId": str(index), "data": {"result": "SECRET" * 100}, "timestamp": index}) + "\n")
    monkeypatch.setattr(es, "_store_path", path)
    cursor = None
    collected = []
    while True:
        params = {"metadata": "1", "paged": "1", "n": "100"}
        if cursor is not None:
            params["before"] = str(cursor)
        code, page = get_log({"params": params})
        assert code == 200
        assert len(page["events"]) <= 100
        assert "SECRET" not in json.dumps(page)
        collected = page["events"] + collected
        if not page["more"]:
            break
        assert cursor is None or page["before"] < cursor
        cursor = page["before"]
    assert [row["id"] for row in collected] == [str(index) for index in range(1200)]
    assert len({row["sourceOffset"] for row in collected}) == 1200
    assert get_log({"params": {"metadata": "1", "paged": "1", "before": "bad"}})[0] == 400


def test_oversized_line_cannot_stall_history_cursor(tmp_path, monkeypatch):
    path = tmp_path / "oversized.jsonl"
    path.write_text(json.dumps({"type": "AgentOutputChunk", "data": {"text": "x" * 300000}}) + "\n")
    monkeypatch.setattr(es, "_store_path", path)
    code, page = get_log({"params": {"metadata": "1", "paged": "1"}})
    assert code == 200
    assert page["before"] < path.stat().st_size
