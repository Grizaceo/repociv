# Durable approval delivery (R01) — canonical protocol

This document is the canonical specification of the recoverable approval
delivery boundary. It is the contract the code, tests, and audits in this
change implement. Where behavior is limited, the limit is stated here
explicitly rather than papered over.

## The problem

The original authorization path consumed an approval from
`approval_store` and *afterwards* enqueued the command into the scheduler.
A crash, restart, retry, or a duplicated HTTP/WS response inside that window
could either:

- **lose** an authorized command (consumed, never enqueued), or
- **run it twice** (replayed after restart, or a duplicate response that
  re-authorized).

Neither is acceptable for a durable authorization boundary.

## Non-goals (explicit)

- **Not** moving enqueue before consume. Consuming first and enqueueing
  later is what makes authorization single-use; enqueueing before consume
  would open a re-execution window after restart.
- **Not** a second scheduler or a second queue. The existing scheduler
  remains the single dispatch point; only its enqueue is made idempotent.
- **Not** an "exactly once" claim for external side effects. See
  [Guarantees](#guarantees-and-limits).

## Components

| Module | Role |
| --- | --- |
| `server/dispatch_ledger.py` | Durable, atomic, idempotent intent record + recovery. |
| `server/approval_resolution.py` | Single place where an approval becomes a queued command. |
| `server/approval_store.py` | `resolve_approval` drives the protocol; adds read-only `peek_status`/`_snapshot_pending` and single-use `pop_approval`. |
| `server/scheduler.py` | Idempotent `enqueue`/`enqueue_dict` and deduplicating `_init_from_disk`. |

## The protocol (fixed order)

Every approval resolution (`resolve_approval`, called by both the HTTP
route and the WebSocket handler) runs these steps in order:

1. **Validate, do not consume.** `peek_status` reports
   `pending` / `expired` / `missing` read-only, and `_snapshot_pending`
   copies the pending command. Authorization state does not move yet, so a
   failure in the next step can never leave a consumed approval behind.

2. **`record_intent` — durable intent BEFORE consumption.** An atomic,
   fsync'd, idempotent write of `{commandId, command, state:"intent"}` under
   `<config>/dispatch_ledger/<id>.json`. Raises on I/O failure. At this
   point nothing is authorized and nothing is lost: the approval is still
   pending and the operator can retry.

3. **Consume the approval.** The single-use pop (`pop_approval`) is
   serialized with the intent write (`_consume_lock`), so two concurrent
   responses for the same command cannot both reach the consume step.

4. **`claim_intent` — durable "consumed" marker.** Atomically rewrites the
   intent to `state:"claimed"`. This is what lets a restart tell
   "consumed before the crash" apart from "never consumed".

5. **Audit + enqueue.** The existing event-store audit
   (`CommandApproved` → `CommandQueued`) and the existing scheduler
   `enqueue`. No new queue, no new scheduler.

6. **`done_intent` — release.** Best-effort unlink of the intent file. The
   scheduler queue is itself durable, so a crash between step 5 and 6 leaves
   a claimed intent that recovery replays into an idempotent no-op.

## Recovery after restart

`dispatch_ledger.recover_intents()` (called from `bridge.main` after the
hung-command sweep) replays what a crash left behind:

| Leftover state | Meaning | Recovery action |
| --- | --- | --- |
| `state:"intent"`, approval still pending | Intent durable, approval never consumed. | Re-dispatch through the same single-use `resolve_approval` path — a duplicate response still cannot authorize twice. |
| `state:"intent"`, approval gone | Approval consumed, but the process died (or the claim write failed) before `claim_intent` became durable. | Re-enqueue directly from the durable intent, deduplicated by id against the persisted scheduler queue. This is the only recoverable copy and is never released by a duplicate response. |
| `state:"claimed"` | Approval consumed, command maybe not enqueued. | Re-enqueue directly from the durable intent, deduplicated by id against the persisted scheduler queue. |
| unreadable / corrupt | Cannot be trusted. | Reported `unresolved` for operator review; never replayed, never dropped silently. |
| none | Fully delivered or rejected. | No-op. |

`bridge.main` runs recovery *after* `_recover_hung_commands()` so a recovered
dispatch is never mistaken for a hung run, and *before* task-registry
reconciliation so a later R12 startup integration can layer interrupted-task
recovery on top of an already-reconciled command state.

## Guarantees and limits

**Guaranteed (dispatch level):**

- A command is enqueued **at most one runnable copy**. Repeated HTTP/WS
  responses, concurrent duplicate approvals, worker retries, and restarts
  cannot enqueue a second copy. Enforced by three layers: the single-use
  consume, idempotent `enqueue_dict`, and deduplicating `_init_from_disk`.
- Every command is **delivered once, explicitly rejected, or reported
  unresolved** — never silently lost. A crash before the intent is durable
  leaves the approval pending (retryable); a crash (or claim I/O failure)
  after the consume leaves an unclaimed intent that recovery replays; a crash
  after the claim leaves a durable intent that recovery replays; a corrupt
  intent is surfaced for operator review. A duplicate response is not allowed
  to release an unclaimed intent whose approval is already gone: that record
  is the recoverable copy.
- The durable protocol is **not** dependent on the approval store's in-memory
  state surviving; each durable write is atomic and fsync'd.

**Explicitly NOT guaranteed:**

- **Not exactly-once external side effects.** Dispatch-level dedup means the
  *scheduler* enqueues a command once. If a dispatched worker itself is
  retried after completing a side effect (network call, file write, external
  command), that side effect can still occur twice. This boundary is
  documented and asserted in tests; it is not silently widened into an
  exactly-once claim.
- Recovery of an intent whose approval has since **expired** reports the
  command `unresolved` rather than enqueueing it — authorization never
  overrides expiry.

## Testing

`server/test_durable_dispatch.py` (14 tests) exercises each criterion with
inert fixtures and isolated TMPDIR state: a failure injected after each
durable write then a simulated restart; a claim-write failure followed by a
duplicate response and a restart; concurrent duplicate responses; worker-retry
idempotency; corrupt-intent honesty; and the documented exactly-once
side-effect limit.
