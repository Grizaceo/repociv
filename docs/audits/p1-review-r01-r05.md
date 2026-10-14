# P1 review — R01 (durable approval delivery) / R05 (loaded-build diagnostic)

Date: 2026-10-13 · Reviewed tree: `/home/gris96/.hermes/workspace/ACTIVE/repociv`
Branch: `feat/agent-position-hooks` · Baseline: `a74dd53`
Review mode: **read-only, adversarial**. No source files were written.
Verdict: **BLOCKED — 2 P1 correctness defects, 2 P2, 1 informational.**

This review is independent of `docs/audits/p1-r01-r05-evidence.md`, which
reports the same suites GREEN. The shipped suites pass; the blockers below are
invariants those suites do not exercise, reproduced with real failure
injection against the on-disk code. Every claim is backed by a runnable probe
in `/home/gris96/.hermes/cache/scratch/`.

---

## Test output (reproduced, isolated TMPDIR)

Focused suites, as requested:

```
$ TMPDIR=$(mktemp -d) REPOCIV_CONFIG_DIR=$(mktemp -d) \
    .venv/bin/python -m pytest -q -p no:cacheprovider \
    server/test_durable_dispatch.py server/test_build_diagnostics.py
.........................                                                [100%]
25 passed, 3 warnings in 0.28s
```

Regression sweep (adjacent suites, to confirm the blockers are not caused by an
unrelated break elsewhere):

```
$ .venv/bin/python -m pytest -q -p no:cacheprovider \
    server/test_approval_expiry.py server/test_approval_expiry_transport.py \
    server/test_approval_store.py server/test_durable_dispatch.py \
    server/test_build_diagnostics.py server/test_security_harness.py \
    server/test_scheduler_fatigue.py server/test_execution_protection_routes.py \
    server/test_container_runtime.py server/test_process_control.py
........................................................................ [ 44%]
........................................................................ [ 89%]
.................                                                        [100%]
161 passed, 3 warnings in 3.47s
```

No full suite was run. No live bridge, agent, external provider, push, or
destructive action was exercised; all state was TMPDIR-isolated.

**Green suites are not evidence of the invariant.** `test_durable_dispatch.py`
constructs its crash windows by calling `record_intent` / `pop_approval` /
`claim_intent` by hand and never dispatches the command through the worker, so
the windows below are structurally invisible to it. See "Why the suites miss it".

---

## BLOCKER 1 (P1) — pop→claim window: authorized command permanently lost, no crash required

**Files:** `server/approval_resolution.py:102`, `server/dispatch_ledger.py:124-141`,
`server/dispatch_ledger.py:229-241`, `server/approval_store.py:297-313`

`dispatch_approved` consumes the approval (step 2) and only then writes the
`claimed` marker (step 3). A failure inside `claim_intent` — an ordinary
`OSError`, e.g. `ENOSPC`, not a power cut — leaves:

- the approval **already consumed** (authorization taken, store empty),
- the durable intent still at `state: "intent"`,
- the command **never enqueued**.

`resolve_approval` catches this and answers the caller
`{"ok": false, "status": "unresolved", ...}` — telling the operator the command
was "left for operator review". That remedy is impossible: recovery only
re-dispatches `state: "intent"` through `resolve_approval`, which now finds
`approval not found`. The intent is never released, so the command is
re-reported as unresolved on **every** restart forever, and never runs.

Verified by `probe_a2.py` (real code path, no monkeypatched crash — only
`claim_intent` forced to raise `ENOSPC`):

```
HTTP/WS response the user actually gets:
   {"ok": false, "status": "unresolved", "error": "dispatch intent not durable;
    command left for operator review", "commandId": "D1"}
approval store (was the authorization consumed?): []
scheduler queue: []
durable intent state on disk: intent
operator-triggered recovery after restart -> {'redispatched': [], 'enqueued': [],
                                              'unresolved': ['D1']}
>>> user told 'unresolved/operator review'      = True
>>> approval WAS consumed (authorization taken) = True
>>> command NEVER delivered                     = True
>>> unrecoverable, reported on every restart    = True
```

Also reachable as a plain crash in the same window (`probe_r01.py`, Probe A):
`record_intent` durable → `pop_approval` → crash → `claim_intent` never ran.
Identical outcome: `unresolved: ['A1']`, queue empty, intent stuck.

**Why it violates the stated contract.** `approval_resolution.py:58-63` claims
`claim_intent` runs "before the audit/enqueue writes, so a crash between claim
and enqueue leaves a durable 'consumed' marker". The docstring documents the
window *after* the claim and is silent on the window *before* it — which is
precisely where the approval has been taken and nothing durable records that
fact. R01 criterion 6 ("delivered once, rejected, or reported unresolved —
never silently lost") fails: the command is reported unresolved but the report
is unactionable, so the authorization is effectively burned.

**Required fix (design, not applied):** make the consumed state durable in the
same atomic step as the consume, or record the intent as `claimed` *before*
consuming and treat `claimed`+still-present-approval as "not yet consumed" on
recovery. A `claimed` intent whose approval is missing must also be
self-clearing rather than reported forever.

---

## BLOCKER 2 (P1) — double execution: `_has_queued` cannot see an already-dispatched command

**Files:** `server/scheduler.py:193-214`, `server/scheduler.py:338-352`,
`server/dispatch_ledger.py:242-261`, `server/bridge.py:1287, 1307`

`_has_queued()` deduplicates against (a) the in-memory `_queue` and (b) the
persisted queue file. A command that was already dispatched was **popped** from
`_queue` by `_dispatch_next()` and re-dumped without itself — so it is absent
from both. A `claimed` intent surviving a crash is therefore re-enqueued and
the command **runs a second time**.

`bridge.py` `__main__` creates this ordering directly: `_sched.start_worker()`
(line 1287) starts the dispatch loop, and `dispatch_ledger.recover_intents()`
runs ~20 lines later (line 1307) — after the worker may already have dispatched
the recovered command.

Verified by `probe_d.py` (mirrors the `bridge.__main__` order):

```
queue after _init_from_disk: ['E1']
worker _dispatch_next() -> True
executed so far      : ['E1']
queue after dispatch : []
queue file on disk   : []
durable intent       : True
=== now recovery runs (bridge.py:1307) ===
recover_intents -> {'redispatched': [], 'enqueued': ['E1'], 'unresolved': []}
queue after recovery: ['E1']
EXECUTIONS of E1: ['E1', 'E1'] (count=2)
>>> CONFIRMED BLOCKER: the approved command executed 2 times.
```

`probe_e.py` confirms the ordering dependence:

```
recovery BEFORE dispatch                   -> executions=1 ['E1']
dispatch BEFORE recovery (bridge order)    -> executions=2 ['E1', 'E1']
```

**Why it violates the stated contract.** `dispatch_ledger.py:32-35` asserts "a
command is enqueued at most once at dispatch level … cannot enqueue a second
runnable copy", and `approval_resolution.py:24-26` repeats it. For a
destructive command this is a repeated side effect, which is the exact failure
R01 exists to prevent — and the user explicitly forbids destructive-action
regressions.

**Why the suites miss it:** `test_failure_after_enqueue_before_release_is_idempotent_on_restart`
(line 165) never dispatches the command, so the queue still holds the copy and
`_has_queued` returns True. The invariant is only tested in the ordering that
happens to work.

**Required fix (design, not applied):** dedup must consult a durable
"dispatched/consumed" record (the intent ledger itself, or the event store's
`started`/`queued` audit) rather than only live queue state; alternatively run
`recover_intents()` **before** `start_worker()`. Note the second option alone
still leaves the general race open to a worker that dispatches between the
queue load and the recovery sweep.

---

## P2 — `enqueue_dict` dedup is check-then-act, not atomic

**File:** `server/scheduler.py:228-248`

`_has_queued()` is evaluated **outside** `_queue_lock`; the append happens
**inside** it. N concurrent callers all pass the check and all append.
Verified by `probe_r01.py` Probe C (16 threads, same id):

```
enqueue_dict returned non-empty for N callers: 15
in-memory queue: ['C1' x15]
on-disk queue  : ['C1' x15]
>>> IDEMPOTENCY BROKEN: enqueue_dict is not atomic (check-then-act)
Post-restart dedup (_init_from_disk) collapses it: ['C1'] -> copies: 1
```

Currently only reachable if two same-id enqueues race; `_consume_lock` in
`approval_resolution.py:82` plus the single-use approval pop prevents the
common HTTP/WS duplicate from reaching it, which is why the shipped
`test_concurrent_approval_responses_dispatch_once` passes. It is a latent
P2 because `_init_from_disk` dedup masks it on restart, but the invariant
"`scheduler.enqueue` deduplicates by id" is not actually guaranteed while the
process is live. Fix: move the `_has_queued` check inside `_queue_lock`.

---

## P2 — R05 git fallback can report a foreign commit with a confident status

**File:** `server/build_identity.py:51-64, 70-86`

With no `shared/build-info.json`, `_capture_build()` shells out to
`git rev-parse --short HEAD` with `cwd=_REPO_ROOT` and reports the result with
`source: "git-fallback"` — a healthy-looking value. Nothing verifies the
returned commit belongs to *this* code. For an installed/venv/site-packages
layout whose parent sits inside an unrelated git tree, git returns that tree's
HEAD.

Verified by `probe_f.py`:

```
unrelated repo HEAD : ba5ee1b
git_commit_short()  : ba5ee1b
_capture_build() would report:
   {'version': '0.1.0', 'commit': 'ba5ee1b', 'buildId': 'unknown',
    'builtAt': 'unknown', 'source': 'git-fallback'}
>>> commit reported: ba5ee1b == the FOREIGN repo's HEAD: True
```

This weakens R05 criterion 2 ("reports the actually-loaded commit/build"): a
stale process or a foreign tree is reported indistinguishably from the real
loaded build, which is the exact confusion the diagnostic is meant to resolve.
Mitigation: verify the resolved path is a git work tree containing this
package (e.g. `git rev-parse --show-toplevel` + a path containment check), and
degrade to `unknown` when it is not.

---

## Informational — `/health` leaks an absolute path alongside the new snapshot

**File:** `server/routes/core.py:136` (pre-existing, **not** in this diff)

`"eventStore": str(_es._store_path)` returns a full filesystem path on the same
response that carries `buildDiagnostic`. Verified by `probe_r05.py` scanning
the whole `/health` body:

```
top-level keys: [... 'eventStore' ...]
--- privacy scan of the FULL /health body ---
  LEAK  '/home/gris96'
  LEAK  '/home/'
buildDiagnostic eventStore field: '/home/gris96/.../events.jsonl'
```

The `buildDiagnostic` sub-object itself is clean (store statuses all within the
documented enum, no key/env/argv/prompt material — asserted correctly by
`test_snapshot_never_leaks_secret_material`). The shipped privacy test only
asserts on `body["buildDiagnostic"]`, not on the response it rides on. Not a
regression from this change; flagged because R05's premise is "safe to serve on
an existing authenticated surface" and that surface does leak a path.

---

## What was verified as correct

- **R05 snapshot immutability** — `_LOADED_BUILD` is frozen at import;
  `test_loaded_build_is_immutable_after_checkout_change` correctly asserts it,
  and `probe_r05.py` shows a stable `commit: a74dd53` / `source: git-fallback`.
- **R05 `auditKeyMode`** — `_AUDIT_KEY_MODE` is set inside `_load_hmac_key()`
  before the module-level call, so the ordering is sound; reports `ephemeral`
  honestly in this environment.
- **R05 store status enum** — all three statuses stay within
  `{writable, not-writable, missing, unknown}`; no path leakage inside the block.
- **R01 concurrency of the consume path** — `_consume_lock` + single-use pop do
  hold: 8 racing responses yield exactly one ok and one queued copy
  (`test_concurrent_approval_responses_dispatch_once`).
- **R01 `_init_from_disk` dedup** — duplicate ids in the persisted queue do
  collapse to one copy on restart (observed in Probe C and Probe E ordering 1).
- **Expired-approval recovery** — an expired intent is *not* silently
  authorized; `probe_r01.py` Probe B shows the intent is released and nothing
  is enqueued, matching the documented limitation.

---

## Recommended gate

Do not merge. Blockers 1 and 2 are both reachable from the normal approval path
and both break the "delivered exactly once, never silently lost" invariant that
R01 exists to establish; blocker 2 additionally repeats side effects, which is
the destructive-action class the user explicitly protects. The P2s should be
fixed in the same change since both are one-line-scope corrections to the same
dedup/attestation logic.
