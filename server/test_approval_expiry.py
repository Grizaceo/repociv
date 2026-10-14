"""Expiry contract: bounded, audited, single-use, and independent of UI traffic."""
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from server import approval_store as store
from server import event_store as es
from server import scheduler
from server import sse_server


@pytest.fixture
def expiry_env(isolated_approval_store, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(store.time, "time", lambda: now[0])
    events, queued, messages = [], [], []
    monkeypatch.setattr(es, "record_rejected", lambda cid, reason: events.append((cid, reason)))
    monkeypatch.setattr(es, "record_approved", lambda cid: events.append((cid, "approved")))
    monkeypatch.setattr(es, "record_queued", lambda cid: events.append((cid, "queued")))
    monkeypatch.setattr(scheduler, "enqueue", lambda cmd: queued.append(cmd))
    monkeypatch.setattr(sse_server, "send_to_repociv", messages.append)
    return isolated_approval_store, now, events, queued, messages


def pending(cid="pending", expires_at=1010.0):
    return {"id": cid, "type": "read_file", "target": "repo", "expires_at": expires_at}


@pytest.mark.parametrize("operation", ["list", "pop", "approve", "reject", "sweep"])
def test_loaded_store_expires_at_boundary(expiry_env, operation):
    path, now, events, queued, messages = expiry_env
    store.add_approval(pending())
    now[0] = 1010.0
    if operation == "list":
        assert store.get_approvals() == []
    elif operation == "pop":
        assert store.pop_approval("pending") is None
    elif operation == "sweep":
        assert store.expire_approvals() == ["pending"]
    else:
        result = store.resolve_approval("pending", approved=operation == "approve")
        assert result["ok"] is False
        assert result["status"] == "expired"
    assert queued == []
    assert events == [("pending", "approval expired")]
    assert json.loads((path / "approvals.json").read_text()) == {}
    assert any(m.get("type") == "approval_expired" for m in messages)
    assert store.get_approvals() == []
    assert store.pop_approval("pending") is None
    assert events == [("pending", "approval expired")]


def test_valid_approval_consumed_once(expiry_env):
    _, now, events, queued, _ = expiry_env
    store.add_approval(pending())
    now[0] = 1009.999
    assert store.resolve_approval("pending", approved=True)["status"] == "queued"
    now[0] = 1010.0
    assert store.expire_approvals() == []
    assert store.resolve_approval("pending", approved=True)["ok"] is False
    assert len(queued) == 1
    assert events == [("pending", "approved"), ("pending", "queued")]


@pytest.mark.parametrize("deadline", [None, "bad", float("nan"), float("inf"), True])
def test_invalid_deadline_is_not_authorization(expiry_env, deadline):
    _, _, events, queued, _ = expiry_env
    store.add_approval(pending(expires_at=deadline))
    assert store.resolve_approval("pending", approved=True)["ok"] is False
    assert queued == []
    assert events == [("pending", "invalid approval deadline")]


def test_reload_audits_expired_and_persists_removal(expiry_env, monkeypatch):
    path, now, events, _, _ = expiry_env
    store.add_approval(pending())
    now[0] = 1011.0
    monkeypatch.setattr(store, "_loaded", False)
    monkeypatch.setattr(store, "_approvals", {})
    assert store.get_approvals() == []
    assert events == [("pending", "approval expired")]
    assert json.loads((path / "approvals.json").read_text()) == {}


@pytest.mark.parametrize("created_at", [900.0, None])
def test_legacy_receives_one_persisted_bounded_deadline(expiry_env, monkeypatch, created_at):
    path, now, _, queued, _ = expiry_env
    legacy = pending()
    legacy.pop("expires_at")
    if created_at is not None:
        legacy["created_at"] = created_at
    (path / "approvals.json").write_text(json.dumps({"pending": legacy}))
    monkeypatch.setattr(store, "_loaded", False)
    items = store.get_approvals()
    deadline = (created_at if created_at is not None else now[0]) + store._APPROVAL_TTL_S
    assert items[0]["expires_at"] == deadline
    now[0] += 10
    monkeypatch.setattr(store, "_loaded", False)
    assert store.get_approvals()[0]["expires_at"] == deadline
    now[0] = deadline
    assert not store.resolve_approval("pending", approved=True)["ok"]
    assert not queued


def test_concurrent_expire_and_approve_has_one_terminal_outcome(expiry_env):
    _, now, events, queued, _ = expiry_env
    store.add_approval(pending())
    now[0] = 1010.0
    barrier = threading.Barrier(8)

    def race(i):
        barrier.wait(timeout=5)
        if i % 2:
            return store.resolve_approval("pending", approved=True)
        return store.expire_approvals()

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(race, range(8)))
    assert not queued
    assert events == [("pending", "approval expired")]


def test_concurrent_valid_approvals_enqueue_once(expiry_env):
    _, _, events, queued, _ = expiry_env
    store.add_approval(pending())
    barrier = threading.Barrier(8)

    def approve(_):
        barrier.wait(timeout=5)
        return store.resolve_approval("pending", approved=True)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(approve, range(8)))
    assert sum(result["ok"] for result in results) == 1
    assert len(queued) == 1
    assert events == [("pending", "approved"), ("pending", "queued")]


def test_audit_failure_cannot_authorize(expiry_env, monkeypatch):
    _, now, _, queued, _ = expiry_env
    store.add_approval(pending())
    now[0] = 1010.0

    def unavailable(*args):
        raise OSError("audit unavailable")

    monkeypatch.setattr(es, "record_rejected", unavailable)
    assert store.resolve_approval("pending", approved=True)["status"] == "expired"
    assert queued == []
    assert "pending" in store._approvals


def test_scheduler_sweeps_without_clients(expiry_env, monkeypatch):
    _, now, events, queued, _ = expiry_env
    store.add_approval(pending())
    now[0] = 1010.0
    monkeypatch.setattr(scheduler, "_dispatch_next", lambda: False)

    def stop(_):
        raise SystemExit

    monkeypatch.setattr(scheduler.time, "sleep", stop)
    with pytest.raises(SystemExit):
        scheduler._worker_loop()
    assert events == [("pending", "approval expired")]
    assert queued == []


def test_audit_failure_does_not_hide_healthy_pending(expiry_env, monkeypatch):
    _, now, _, queued, _ = expiry_env
    store.add_approval(pending("dead", expires_at=1000.0))
    store.add_approval(pending("live"))

    def fail(*args):
        raise OSError("disk full")

    monkeypatch.setattr(es, "record_rejected", fail)
    assert [cmd["id"] for cmd in store.get_approvals()] == ["live"]
    assert store.pop_approval("dead") is None
    assert store.resolve_approval("dead", approved=True)["status"] == "expired"
    assert store.resolve_approval("live", approved=True)["ok"]
    assert len(queued) == 1


def test_persist_retry_does_not_duplicate_audit_or_block_other_expiry(expiry_env, monkeypatch):
    _, now, events, _, messages = expiry_env
    store.add_approval(pending("a", expires_at=1000.0))
    store.add_approval(pending("b", expires_at=1000.0))
    persist = store._persist
    attempts = [0]

    def fail_once():
        attempts[0] += 1
        if attempts[0] == 1:
            raise OSError("temporary disk failure")
        persist()

    monkeypatch.setattr(store, "_persist", fail_once)
    assert store.expire_approvals() == ["b"]
    assert [msg["commandId"] for msg in messages if msg["type"] == "approval_expired"] == ["b"]
    assert store.expire_approvals() == ["a"]
    assert events == [("a", "approval expired"), ("b", "approval expired")]
    assert store.get_approvals() == []


def test_worker_dispatches_even_if_sweep_raises(expiry_env, monkeypatch):
    dispatched = []

    def fail():
        raise OSError("unavailable approvals file")

    def dispatch():
        dispatched.append(True)
        return False

    def stop(_):
        raise SystemExit

    monkeypatch.setattr(store, "expire_approvals", fail)
    monkeypatch.setattr(scheduler, "_dispatch_next", dispatch)
    monkeypatch.setattr(scheduler.time, "sleep", stop)
    with pytest.raises(SystemExit):
        scheduler._worker_loop()
    assert dispatched == [True]


@pytest.mark.parametrize("raw", ["", "24h", "abc", "0", "-5"])
def test_invalid_ttl_uses_bounded_default(raw):
    assert store._approval_ttl(raw) == 86400


def test_positive_ttl_is_preserved():
    assert store._approval_ttl("600") == 600
