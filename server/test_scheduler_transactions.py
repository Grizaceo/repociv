from __future__ import annotations

import time
from dataclasses import asdict
from pathlib import Path

import pytest

from server import approval_store, scheduler
from server.command_schema import Command


@pytest.fixture
def isolated_scheduler(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(scheduler, "_QUEUE_FILE", tmp_path / "scheduler-queue.json")
    with scheduler._queue_lock:
        scheduler._queue.clear()
    with scheduler._lease_lock:
        scheduler._leases.clear()
    scheduler._dispatcher = None
    yield tmp_path
    with scheduler._queue_lock:
        scheduler._queue.clear()
    with scheduler._lease_lock:
        scheduler._leases.clear()
    scheduler._dispatcher = None


@pytest.fixture
def isolated_approvals(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(approval_store, "_approvals_path", lambda: tmp_path / "approvals.json")
    approval_store.reset_for_tests()
    return tmp_path


def command(command_id: str = "cmd-tx") -> Command:
    return Command(
        id=command_id,
        type="execute_agent",
        target="repo-a",
        payload={"unit": "WORKER", "repoPath": "/selected/repo-a"},
        risk="medium",
        requires_approval=False,
        status="queued",
    )


def test_enqueue_persist_failure_does_not_mutate_memory(monkeypatch, isolated_scheduler):
    monkeypatch.setattr(
        scheduler,
        "_dump_queue",
        lambda _queue: (_ for _ in ()).throw(OSError("disk full")),
    )
    with pytest.raises(OSError, match="disk full"):
        scheduler.enqueue(command())
    assert scheduler.queue_snapshot() == []


def test_enqueue_is_idempotent_by_command_id(isolated_scheduler):
    assert scheduler.enqueue(command()) is True
    assert scheduler.enqueue(command()) is False
    assert [item["id"] for item in scheduler.queue_snapshot()] == ["cmd-tx"]


def test_dispatch_persist_failure_keeps_queued_and_releases_lease(
    monkeypatch, isolated_scheduler
):
    scheduler.enqueue(command())
    monkeypatch.setattr(
        scheduler,
        "_dump_queue",
        lambda _queue: (_ for _ in ()).throw(OSError("disk full")),
    )
    with pytest.raises(OSError, match="disk full"):
        scheduler._dispatch_next()
    assert scheduler.queue_snapshot()[0]["status"] == "queued"
    assert scheduler._leases.get("WORKER", 0) == 0


def test_dispatch_exception_records_failure_and_removes_running_item(
    monkeypatch, isolated_scheduler
):
    failed = []
    monkeypatch.setattr(
        scheduler._es,
        "record_failed",
        lambda command_id, error, metadata=None: failed.append((command_id, error)),
    )
    scheduler.set_dispatcher(lambda _cmd: (_ for _ in ()).throw(RuntimeError("boom")))
    scheduler.enqueue(command())
    assert scheduler._dispatch_next() is True
    deadline = time.time() + 2
    while scheduler.queue_snapshot() and time.time() < deadline:
        time.sleep(0.01)
    assert scheduler.queue_snapshot() == []
    assert failed and failed[0][0] == "cmd-tx"
    assert "boom" in failed[0][1]


def test_restart_requeues_running_items(monkeypatch, isolated_scheduler):
    scheduler._QUEUE_FILE.write_text(
        '[{"id":"cmd-recover","type":"execute_agent","target":"repo-a",'
        '"payload":{"unit":"WORKER"},"status":"running"}]',
        encoding="utf-8",
    )
    scheduler._init_from_disk()
    assert scheduler.queue_snapshot()[0]["status"] == "queued"


def test_approval_enqueue_failure_preserves_pending(
    monkeypatch, isolated_approvals
):
    pending = asdict(command("cmd-approval"))
    pending["status"] = "waiting_approval"
    approval_store.add_approval(pending)
    monkeypatch.setattr(
        scheduler,
        "enqueue",
        lambda _cmd: (_ for _ in ()).throw(OSError("disk full")),
    )

    result = approval_store.resolve_approval("cmd-approval", approved=True)
    assert result["ok"] is False
    assert result["status"] == "waiting_approval"
    assert [item["id"] for item in approval_store.get_approvals()] == ["cmd-approval"]


def test_approval_pop_persist_failure_keeps_pending(
    monkeypatch, isolated_approvals
):
    pending = asdict(command("cmd-pop-fail"))
    approval_store.add_approval(pending)
    monkeypatch.setattr(
        approval_store,
        "_persist",
        lambda _candidate=None: (_ for _ in ()).throw(OSError("disk full")),
    )
    with pytest.raises(OSError, match="disk full"):
        approval_store.pop_approval("cmd-pop-fail")
    assert [item["id"] for item in approval_store.get_approvals()] == ["cmd-pop-fail"]


def test_approval_success_enqueues_before_removal(
    monkeypatch, isolated_approvals
):
    pending = asdict(command("cmd-approval-ok"))
    pending["status"] = "waiting_approval"
    approval_store.add_approval(pending)
    calls = []
    monkeypatch.setattr(scheduler, "enqueue", lambda cmd: calls.append(cmd.id) or True)
    monkeypatch.setattr("server.event_store.record_approved", lambda _id: None)
    monkeypatch.setattr("server.event_store.record_queued", lambda _id: None)
    monkeypatch.setattr("server.sse_server.send_to_repociv", lambda _event: None)

    result = approval_store.resolve_approval("cmd-approval-ok", approved=True)
    assert result == {"ok": True, "status": "queued", "commandId": "cmd-approval-ok"}
    assert calls == ["cmd-approval-ok"]
    assert approval_store.get_approvals() == []
