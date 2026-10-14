# R04 / R06 verification record

Baseline: a74dd53, initially clean checkout. No production activation.

## R04 red

Command: `.venv/bin/python -m pytest -q -p no:cacheprovider server/test_execution_protection_routes.py`

Executed result: **2 failed, 3 passed**, 0.22 s. Actual runner route allowed a
read-write repository mount because a single high configuration finding was
classified L1, below its blocking threshold. Public container helper also
accepted unsafe `network=host` directly. Final launches were mocks that throw;
no Docker daemon, CLI model or provider was called.

Fixes: direct helper now applies the pre-launch gate before subprocess. The
harness owner is correcting the configuration findings blocking predicate for
pre-launch/runtime recheck. Fresh green verification: `.venv/bin/python -m pytest -q -p no:cacheprovider server/test_execution_protection_routes.py server/test_container_runtime.py` returned **13 passed**, 0.10 s, one warning about this isolated process's ephemeral audit signing key. This does not identify production key mode.

Canonical matrix: `docs/EXECUTION_PROTECTION_MATRIX.md`. This separates common
admission from trusted direct Python invocation, lists all seven adapters and
explicit network/mount/secret/audit limitations. CLI routes are host execution,
not sandboxed. runtime_enforce is not continuous surveillance.

## R06

Added explicit current-contract links and historical/current distinctions to
SCOPE, ROADMAP, Spanish/English README, SECURITY and COMPARISON. Retained both
2D and 3D, fail-closed approval expiry and supported position hooks. Comparison
errata explicitly limits Cloudflare-header bypass claim to **not demonstrated**,
notes fail-open reviewer behavior in the inspected local AgentCraft 0.5.1
artifact and withdraws unreproducible numeric marker as evidence. No capabilities
retired/revived from stale skills. Current-profile orchestrator skill now forbids
automatic production restart and points to canonical route protections.

Parent integration will append fresh gate, independent review and acceptance
results. Writing documentation alone does not close an item.
