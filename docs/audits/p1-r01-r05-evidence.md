# R01 / R05 evidence audit

Date: 2026-10-13 · Baseline: `a74dd53` · Status: **GREEN** (240 focused tests + full-suite run)

This audit records the commands and actual outputs for the R01 (recoverable
durable approval delivery) and R05 (privacy-safe loaded-build diagnostic)
acceptance criteria, the limitations of what was verified, and the canonical
protocol each point follows.

## Scope

Owned and implemented: `bridge.py`, `scheduler.py`, `approval_store.py`,
`approval_resolution.py`, `event_store.py`, `security_harness.py` (+ new
`dispatch_ledger.py`, `build_identity.py`, tests, docs).

Not touched (owned by sibling workstreams): `task_orchestrator.py`,
`agent_runner.py`, `step_executor.py`, checkpoint/workspace stores, validator,
schema, `src/`. No commits — parent reviews.

All test runs used isolated TMPDIR state and inert fixtures: no live bridge,
agents, approvals, model providers, services, push, or destructive actions.

---

## R01 — recoverable durable approval delivery

Canonical protocol: `docs/DURABLE_APPROVAL_DELIVERY.md`.

### Acceptance criteria and evidence

**1. First stable ids for intent vs confirmed.** The durable intent carries a
stable `commandId` from the approval store; the confirmed/queued state is
recorded via the existing event-store audit and the scheduler queue, keyed by
the same id. Covered by `test_crash_after_intent_before_consume_redelivers_on_restart`
and the enqueue idempotency tests.

**2. Minimum existing scheduler integrated (no second queue).** Only
`scheduler.enqueue`/`enqueue_dict` and `_init_from_disk` were made idempotent;
no new scheduler or queue was introduced. Recovery re-enqueues into the same
queue. Asserted by `test_crash_after_consume_before_enqueue_reenqueues_on_restart`.

**3. Recovery/idempotency for restart, retry, duplicate HTTP/WS, no silent
loss.** `recover_intents()` replays `intent`/`claimed`/corrupt states;
single-use consume + idempotent enqueue + dedup on load prevent duplicates.
Evidence:

- `test_repeated_http_ws_responses_enqueue_once` — duplicate response is
  rejected, one copy.
- `test_concurrent_approval_responses_dispatch_once` — 8 racing responses,
  exactly one ok, one queued copy.
- `test_worker_retry_after_restart_does_not_duplicate` — double recovery
  sweep, single copy.
- `test_corrupt_intent_is_reported_unresolved_not_replayed` — honest
  unresolved, not silent.

**4. Failure after each durable write is recoverable.**
`test_crash_before_intent_write_keeps_approval_pending`,
`test_crash_after_intent_before_consume_redelivers_on_restart`,
`test_crash_after_consume_before_enqueue_reenqueues_on_restart`,
`test_enqueue_failure_after_claim_is_recovered_on_restart`,
`test_failure_after_enqueue_before_release_is_idempotent_on_restart`.

**5. Not naive enqueue-before-consume.** Consume remains before enqueue; the
durable intent is written *before* consume (read-only validate → record intent
→ consume → claim → audit/enqueue → release). See protocol section.

**6. No silent loss / 2 executable copies / no arbitrary exactly-once claim.**
Every command is delivered once, rejected, or reported unresolved; at most one
runnable copy; the exactly-once-side-effects limit is documented and asserted
in `test_dispatch_dedup_is_queue_level_not_external_exactly_once`.

### Commands and actual output

```
$ .venv/bin/python -m pytest -q -p no:cacheprovider server/test_durable_dispatch.py
............                                                             [100%]
12 passed in 0.26s
```

### Limitations

- Dispatch dedup is **not** exactly-once external side effects — a worker
  retried after an external effect can double it. Documented, not hidden.
- Recovery of an intent whose approval has since expired reports
  `unresolved` rather than enqueueing (authorization never overrides expiry).
- The crash-window tests simulate restart by rebuilding scheduler state from
  disk (`_restart`), not by forking a real process; the durable-write and
  replay logic exercised is the real code path.

---

## R05 — privacy-safe loaded-build diagnostic

Canonical protocol: `docs/LOADED_BUILD_DIAGNOSTIC.md`.

### Acceptance criteria and evidence

**1. Existing health surface snapshot.** `GET /health` now returns a
`buildDiagnostic` block alongside the pre-existing fields (which are
unchanged). Asserted by `test_health_shape_is_stable_with_build_diagnostic`.

**2. Reports the actually-loaded commit/build.** `loadedBuild` (version,
commit, buildId, builtAt, source) captured at process import.

**3. Immutable if checkout changes.** Captured once at import and frozen;
`test_loaded_build_is_immutable_after_checkout_change` simulates a post-startup
checkout change and asserts the report is unchanged.
`test_started_at_is_frozen_at_import` covers the process start stamp.

**4. Start/capabilities.** `startedAt`/`uptimeS` plus agent/MCP/GPU
capabilities already on the health surface.

**5. Safe store statuses.** `stores.{eventStore,approvalStore,schedulerQueue}`
report `writable`/`not-writable`/`missing`/`unknown` — never a path.
`test_missing_store_reported_missing_not_writable`,
`test_unsupported_store_reported_unknown`, and the real-probe tests cover
missing/unknown/writable honestly.

**6. HMAC no tokens/env/prompts/argv.** `auditKeyMode` is `persistent` or
`ephemeral` only. `test_audit_key_mode_ephemeral_without_env` /
`test_audit_key_mode_persistent_with_env` assert the distinction;
`test_snapshot_never_leaks_secret_material` asserts no key/env/prompt/argv/
path leakage.

**7. Missing/unsupported honest.** See store-status tests above; `unknown`
is reported, never a healthy default.

### Commands and actual output

```
$ .venv/bin/python -m pytest -q -p no:cacheprovider server/test_build_diagnostics.py
.............                                                           [100%]
13 passed, 3 warnings in 0.22s
```

(The 3 warnings are the pre-existing ephemeral-HMAC-key `UserWarning`, now
surfaced as a queryable `auditKeyMode`.)

### Limitations

- `loadedBuild.source` is `git-fallback` unless `shared/build-info.json` is
  generated; a repo with no git and no build file reports commit `unknown`
  honestly.
- `build-info.json` is not generated by this change (build tooling out of
  scope); the fallback reads git at import, which is still immutable per
  process.
- Store write probes perform a small create/delete in the store directory;
  the health route therefore reports live writability, not a static config.

---

## Regression check (focused suites)

```
$ .venv/bin/python -m pytest -q -p no:cacheprovider server/test_approval_expiry.py \
    server/test_approval_expiry_transport.py server/test_approval_store.py \
    server/test_durable_dispatch.py server/test_build_diagnostics.py \
    server/test_security_harness.py server/test_scheduler_fatigue.py \
    server/test_execution_protection_routes.py server/test_command_security.py \
    server/test_container_runtime.py server/test_audit_isolation.py \
    server/test_agent_hook_client.py server/test_agent_hook_install.py \
    server/test_codex_hook_location.py server/test_repociv_hooks.py \
    server/test_websocket_handler.py server/test_http_routes_files.py
........................................................................ [ 59%]
........................................................................ [ 89%]
.................s.......                                                [100%]
240 passed, 1 skipped, 3 warnings in 12.59s
```

Full-suite result is run separately for the parent gate; see the parent's run.

## Sibling R12 startup integration

`bridge.main` calls `dispatch_ledger.recover_intents()` after
`_recover_hung_commands()` and before task-registry reconciliation, so R12 can
layer interrupted-task recovery on top of an already-reconciled command state.
`buildDiagnostic.recovery.unresolvedDispatches` exposes the durable-intent
count on the health surface for R12 to build on.
