# Privacy-safe loaded-build diagnostic (R05)

R05 extends the existing authenticated health surface (`GET /health`) with a
`buildDiagnostic` block that reports the code **actually loaded** by the
running process, and is **privacy-safe by contract**.

The old surface reported only a hard-coded `"version": "0.1.0"`, which cannot
distinguish a stale process from a fresh checkout. The new block closes that
gap without leaking anything sensitive.

## What it reports

| Field | Meaning |
| --- | --- |
| `loadedBuild.version` | Version of the loaded build. |
| `loadedBuild.commit` | Git commit of the loaded code. |
| `loadedBuild.buildId` | Build identifier (from `shared/build-info.json` when generated). |
| `loadedBuild.builtAt` | Build timestamp. |
| `loadedBuild.source` | `generated` / `git-fallback` / `unknown` — how the identity was obtained. |
| `startedAt`, `uptimeS` | Process start time and uptime. |
| `auditKeyMode` | `persistent` (verifiable across restarts) or `ephemeral` (per-process, NOT verifiable). |
| `stores.eventStore` | `writable` / `not-writable` / `missing` / `unknown`. |
| `stores.approvalStore` | same status set. |
| `stores.schedulerQueue` | same status set. |
| `recovery.unresolvedDispatches` | Count of durable dispatch intents never claimed (R01 visibility for R12). |

## Immutability

`loadedBuild` and `startedAt` are captured **once at process import** and
frozen. Changing the checkout (git pull, worktree switch) after startup does
**not** change what the running process reports — that mismatch is precisely
what the diagnostic exists to surface. A test asserts a simulated
post-startup checkout change leaves the reported build untouched.

## Privacy contract (hard rule)

The snapshot must never expose:

- tokens, API keys, HMAC key material, passwords, or connection strings;
- environment variable values;
- prompts or argv;
- absolute filesystem/home/config paths.

Store status is therefore a **coarse status enum** (`writable` /
`not-writable` / `missing` / `unknown`), never a path. `auditKeyMode` reports
only the persistent-vs-ephemeral distinction, never the key. Missing or
unsupported backends are reported **honestly** (`missing` / `unknown`), never
as a healthy default and never disguised as "feature absent". The rule is
enforced by `test_snapshot_never_leaks_secret_material`.

## HMAC audit-key mode

`security_harness.audit_key_mode()` reports `persistent` when an operator key
is configured (`REPOCIV_HMAC_KEY`) — audit signatures are then verifiable
across restarts — and `ephemeral` when a per-process key was generated, in
which case tamper-evidence is **not** verifiable across restarts. This makes
the existing ephemeral-key warning an explicit, queryable capability state
without changing signing behavior.

## Testing

`server/test_build_diagnostics.py` (13 tests) covers: reporting the
actually-loaded build; immutability across a simulated checkout change;
honest missing/unknown/unsupported store statuses; the persistent/ephemeral
audit-key distinction; and the no-secret-material privacy rule.
