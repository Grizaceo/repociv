"""R01 — recoverable durable approval delivery.

Exercises the durable dispatch ledger + idempotent scheduler enqueue against
the real R01 acceptance criteria, using only inert fixtures and isolated
TMPDIR state (no live bridge, agents, providers, or real approvals):

  1. A failure injected after EACH durable write is recoverable after a
     simulated process restart (the ledger/scheduler state is rebuilt from
     disk exactly as a restart would).
  2. Each command is delivered once, explicitly rejected, or reported
     unresolved — never silently lost.
  3. Repeated HTTP/WS responses, worker retries and restarts cannot enqueue
     a second runnable copy.
  4. Deduplicated dispatch does NOT guarantee exactly-once external side
     effects (documented limit, asserted as the queue-level guarantee only).
"""

from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from server import approval_store as store
from server import dispatch_ledger, event_store as es, scheduler, sse_server


# ── Isolation ────────────────────────────────────────────────────────────────

@pytest.fixture
def delivery_env(isolated_approval_store, monkeypatch):
    """Isolated approval store + event store + scheduler + dispatch ledger."""
    cfg = isolated_approval_store
    # Real JSONL audit trail in the isolated config dir.
    monkeypatch.setattr(es, "_store_path", cfg / "events.jsonl")
    monkeypatch.setattr(es, "_ledger_ingest", lambda event: None)
    # No live UI fanout.
    monkeypatch.setattr(sse_server, "send_to_repociv", lambda event: None)
    # Isolated scheduler: in-memory reset + durable queue under the cfg dir.
    monkeypatch.setattr(scheduler, "_queue", [])
    monkeypatch.setattr(scheduler, "_leases", {})
    monkeypatch.setattr(scheduler, "_heartbeat", {})
    monkeypatch.setattr(scheduler, "_worker_running", False)
    monkeypatch.setattr(scheduler, "_QUEUE_FILE", cfg / "scheduler-queue.json")
    dispatch_ledger.reset_for_tests()
    return cfg


def _pending(cid: str) -> dict:
    return {"id": cid, "type": "read_file", "target": "repo", "risk": "medium"}


def _queue_ids() -> list[str]:
    return [c["id"] for c in scheduler.queue_snapshot()]


def _queue_file_ids(cfg) -> list[str]:
    path = cfg / "scheduler-queue.json"
    if not path.exists():
        return []
    return [c["id"] for c in json.loads(path.read_text())]


def _restart(cfg):
    """Simulate a bridge process restart of the scheduler + ledger state.

    The in-memory queue is dropped and rebuilt from the durable file, exactly
    like ``scheduler._init_from_disk`` does at startup.
    """
    scheduler._queue.clear()
    scheduler._leases.clear()
    scheduler._heartbeat.clear()
    scheduler._init_from_disk()


# ── 1. Failure injected after each durable write, then restart ───────────────

def test_crash_before_intent_write_keeps_approval_pending(delivery_env, monkeypatch):
    """A failure BEFORE the intent is durable leaves the approval pending —
    nothing authorized, nothing lost."""
    store.add_approval(_pending("c1"))

    def boom(*_a, **_k):
        raise OSError("disk full before durable intent")

    monkeypatch.setattr(dispatch_ledger, "record_intent", boom)
    result = store.resolve_approval("c1", approved=True)

    assert result["ok"] is False
    assert result["status"] == "unresolved"
    # The approval is STILL pending (never consumed): the operator can retry.
    assert [c["id"] for c in store.get_approvals()] == ["c1"]
    assert dispatch_ledger.unresolved() == []
    assert _queue_ids() == []


def test_crash_after_intent_before_consume_redelivers_on_restart(delivery_env):
    """Crash between the durable intent and the consume step. On restart the
    approval is still pending and the intent replays it through the same
    single-use consume path — delivered exactly once."""
    store.add_approval(_pending("c1"))

    # Simulate: intent written durably, then the process died before consume.
    dispatch_ledger.record_intent("c1", _pending("c1"))
    assert _queue_ids() == []

    result = dispatch_ledger.recover_intents()
    assert result["redispatched"] == ["c1"]
    assert _queue_ids() == ["c1"], "command delivered exactly once after restart"
    # Approval consumed, intent released.
    assert store.get_approvals() == []
    assert dispatch_ledger.unresolved() == []


def test_crash_after_consume_before_enqueue_reenqueues_on_restart(delivery_env):
    """Crash between consuming the approval and enqueuing. The durable
    'claimed' intent re-enqueues the command on restart without
    re-authorizing it."""
    store.add_approval(_pending("c1"))

    # Consume the approval and claim the intent, but never enqueue (crash).
    assert store.pop_approval("c1") is not None
    dispatch_ledger.record_intent("c1", _pending("c1"))
    assert dispatch_ledger.claim_intent("c1") is True
    assert _queue_ids() == []

    result = dispatch_ledger.recover_intents()
    assert result["enqueued"] == ["c1"]
    assert _queue_ids() == ["c1"], "consumed command is not lost across restart"


def test_enqueue_failure_after_claim_is_recovered_on_restart(delivery_env):
    """A real failure at the enqueue step (after the claim is durable) leaves a
    durable intent that restart recovery replays."""
    store.add_approval(_pending("c1"))

    real_enqueue = scheduler.enqueue

    def boom(_cmd):
        raise OSError("scheduler queue write failed")

    scheduler.enqueue = boom
    try:
        result = store.resolve_approval("c1", approved=True)
    finally:
        scheduler.enqueue = real_enqueue

    # Reported as unresolved, not silently dropped.
    assert result["ok"] is False
    assert result["status"] == "unresolved"
    # The durable intent survived and still carries the consumed command.
    assert dispatch_ledger.unresolved() == []

    result = dispatch_ledger.recover_intents()
    assert result["enqueued"] == ["c1"]
    assert _queue_ids() == ["c1"], "queue holds only the recovered command"


def test_failure_after_enqueue_before_release_is_idempotent_on_restart(delivery_env, monkeypatch):
    """Crash between enqueue and the ledger release: the command is already
    durable in the scheduler queue, and replay must not create a second copy."""
    cfg = delivery_env
    store.add_approval(_pending("c1"))
    store.resolve_approval("c1", approved=True)
    assert _queue_ids() == ["c1"]
    # The intent was released on the happy path; no ledger residue remains.
    assert dispatch_ledger.unresolved() == []

    # Rebuild the post-crash state: enqueued command + a still-claimed intent
    # (the release never ran).
    dispatch_ledger.record_intent("c1", _pending("c1"))
    assert dispatch_ledger.claim_intent("c1") is True
    result = dispatch_ledger.recover_intents()
    assert result["enqueued"] == []
    assert _queue_ids() == ["c1"], "no second runnable copy after restart"
    assert _queue_file_ids(cfg).count("c1") == 1


# ── 2 & 3. No silent loss; no second runnable copy ───────────────────────────

def test_repeated_http_ws_responses_enqueue_once(delivery_env):
    """A duplicated approval response (HTTP retry + WS replay) must not
    authorize or enqueue a second runnable copy."""
    store.add_approval(_pending("c1"))

    first = store.resolve_approval("c1", approved=True)
    # Duplicate response — the approval is already consumed.
    second = store.resolve_approval("c1", approved=True)

    assert first["status"] == "queued"
    assert second["ok"] is False
    assert second["error"] == "approval not found"
    assert _queue_ids() == ["c1"]


def test_concurrent_approval_responses_dispatch_once(delivery_env):
    """Concurrent duplicate responses race: exactly one wins the consume and
    enqueues once."""
    store.add_approval(_pending("c1"))
    barrier = threading.Barrier(8)

    def approve(_):
        barrier.wait(timeout=5)
        return store.resolve_approval("c1", approved=True)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(approve, range(8)))

    assert sum(1 for r in results if r.get("ok")) == 1
    assert _queue_ids() == ["c1"]
    assert dispatch_ledger.unresolved() == []


def test_worker_retry_after_restart_does_not_duplicate(delivery_env):
    """Worker retries the recovery sweep after a restart; the scheduler's
    idempotent enqueue keeps a single copy."""
    cfg = delivery_env
    store.add_approval(_pending("c1"))
    assert store.resolve_approval("c1", approved=True)["status"] == "queued"

    _restart(cfg)
    # First recovery pass after restart.
    dispatch_ledger.recover_intents()
    # A second (retried) recovery pass must still be a no-op.
    dispatch_ledger.recover_intents()
    assert _queue_ids() == ["c1"]
    assert _queue_file_ids(cfg) == ["c1"]


def test_restart_recovers_queued_command_from_disk(delivery_env):
    """The scheduler queue itself survives a restart and reloads one copy."""
    cfg = delivery_env
    store.add_approval(_pending("c1"))
    store.resolve_approval("c1", approved=True)
    assert _queue_file_ids(cfg) == ["c1"]

    _restart(cfg)
    assert _queue_ids() == ["c1"]


def test_corrupt_intent_is_reported_unresolved_not_replayed(delivery_env):
    """An unreadable durable intent is surfaced for operator review, never
    silently dropped and never replayed."""
    cfg = delivery_env
    store.add_approval(_pending("c1"))
    store.resolve_approval("c1", approved=True)

    ledger_dir = cfg / "dispatch_ledger"
    ledger_dir.mkdir(parents=True, exist_ok=True)
    (ledger_dir / "corrupt.json").write_text("{not json")

    result = dispatch_ledger.recover_intents()
    assert result["unresolved"] == ["corrupt"]
    assert dispatch_ledger.unresolved() == ["corrupt"]


def test_rejected_command_is_terminal_and_not_recovered(delivery_env):
    """An explicit rejection is terminal: it never reappears via recovery."""
    store.add_approval(_pending("c1"))
    result = store.resolve_approval("c1", approved=False, reject_reason="user rejected")
    assert result["status"] == "rejected"

    result = dispatch_ledger.recover_intents()
    assert result == {"redispatched": [], "enqueued": [], "unresolved": []}
    assert _queue_ids() == []


# ── 4. Documented limit: dispatch dedup ≠ exactly-once side effects ──────────

def test_dispatch_dedup_is_queue_level_not_external_exactly_once(delivery_env):
    """The guarantee is dispatch-level. External side effects are NOT covered:
    this asserts the boundary of the guarantee (documented, not silently
    widened). A dispatcher that runs twice would see the command twice, but
    the queue only ever holds one runnable copy."""
    cfg = delivery_env
    store.add_approval(_pending("c1"))
    store.resolve_approval("c1", approved=True)

    # Even a direct duplicate enqueue (as a buggy retry would do) is dropped.
    scheduler.enqueue_dict(_pending("c1"))
    assert _queue_ids() == ["c1"]
    assert _queue_file_ids(cfg) == ["c1"]


def test_claimed_intent_normalizes_status_and_preserves_existing_queue(delivery_env):
    """Replaying a claimed intent normalizes status to 'queued' and
    requires_approval to False, and _init_from_disk merges without clobbering."""
    cfg = delivery_env
    store.add_approval(_pending("c1"))
    store.resolve_approval("c1", approved=True)
    assert _queue_file_ids(cfg) == ["c1"]

    # Record and claim a second command whose raw dict still has pending_approval
    raw_c2 = {**_pending("c2"), "status": "pending_approval", "requires_approval": True}
    dispatch_ledger.record_intent("c2", raw_c2)
    dispatch_ledger.claim_intent("c2")

    _restart(cfg)
    result = dispatch_ledger.recover_intents()
    assert result["enqueued"] == ["c2"]
    scheduler._init_from_disk()
    snap = {c["id"]: c for c in scheduler.queue_snapshot()}
    assert set(snap.keys()) == {"c1", "c2"}
    assert snap["c2"]["status"] == "queued"
    assert snap["c2"]["requires_approval"] is False
