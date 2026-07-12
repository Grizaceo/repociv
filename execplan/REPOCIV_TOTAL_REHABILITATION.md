# RepoCiv Total Rehabilitation

This ExecPlan is a living document. `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be updated after every milestone.

The plan follows `/home/gris/.hermes/skills/execplan/references/PLANS.md` and is self-contained for a contributor starting from branch `audit/repociv-total-rehabilitation-20260712` at HEAD `1088dfa2a400` plus the preserved WIP.

## Purpose / Big Picture

RepoCiv must become a daily local instrument for this observable sequence:

1. choose one or more real repositories;
2. choose an agent and give it a real task in one selected repository;
3. observe queued/running/completed/failed state;
4. approve or reject risky work;
5. inspect output/evidence;
6. find the same lifecycle in the ledger.

The implementation will preserve the Civ/RimWorld visual metaphor, the 2D/3D/local views, local-first single-user operation, agent profiles, MCP, strict TypeScript, design tokens, visual assets and test budgets. It will remove or defer subsystems that do not improve the sequence above.

## Baseline and evidence

Canonical evidence:

- `/home/gris/.hermes/workspace/reports/repociv/REPOCIV_TOTAL_AUDIT_2026-07-12.md`
- `/home/gris/.hermes/workspace/reports/repociv/REPOCIV_FEATURE_MATRIX_2026-07-12.md`
- `/home/gris/.hermes/workspace/reports/repociv/REPOCIV_VISUAL_UX_AUDIT_2026-07-12.md`
- `/home/gris/.hermes/workspace/reports/repociv/2026-07-12T060520Z_forensic_baseline/`
- `/home/gris/.hermes/workspace/reports/repociv/2026-07-12_visual_baseline/`

Baseline gate results:

- HEAD: TypeScript and ESLint pass; Prettier, Vitest coverage, Ruff scripts and one Pytest fail.
- WIP: TypeScript, ESLint, Vitest coverage, build, Ruff, Pytest and bundle/assets pass; Prettier fails on `src/main.ts` only.
- Directed E2E WIP: 5 passed, 6 failed; failures include `networkidle` on a page with persistent transports.
- Eager JS: 143 KB gzip (budget 185 KB).
- npm audit: zero known vulnerabilities.
- Mobile: 390 px viewport has 789 px document width.

## Progress

- [x] (2026-07-12) Preserve WIP as binary patch, status, metadata and manifests outside the repo.
- [x] (2026-07-12) Contrast clean HEAD, WIP and controlled runtime.
- [x] (2026-07-12) Produce total audit, feature matrix and visual/UX audit.
- [x] (2026-07-12) Create branch `audit/repociv-total-rehabilitation-20260712` without discarding WIP.
- [x] (2026-07-12) Milestone 0 — cycle 1 (Claude) `VERIFIED=false`, cycle 2 (Claude) `VERIFIED=true`; delayed delegate returned `VERIFIED=false`; all E1–E10 corrections landed; final independent cycle returned `VERIFIED=true`, `BLOCKERS=[]`.
- [x] (2026-07-12) Milestone 0.5 — WIP split into `dfcd0d4` (simulation/subsystem prune, canonical gate green), `ad23712` (config path regression, 26 tests), and `a34aa71` (public docs/archive). Broken E2E WIP was DEFERRED, not committed: 7/20 passed; patch SHA-256 `ece2a80a74f0250536dc0e62fcef77a3220769b34be0f03ace557aea5374f217`.
- [x] (2026-07-12) Milestone 1 — Git argv-only; loopback bind; selected-repository membership; realpath/symlink file boundary; JSON + same-origin or token mutation guard; wildcard CORS removed. Focused 23 tests, TypeScript, ESLint and runtime probes passed (403 foreign Origin, 415 text/plain, 200 token, selected repo 200, unselected same-root repo 404).
- [x] (2026-07-12) Milestone 1.5 — shared HTTP/SSE/WS trust policy; no-token local mode is same-origin-only; configured token is mandatory even same-origin; foreign preflight rejected; MCP mutation path remains token-only. 863 backend tests passed. Real runtime probes passed for empty-token and token modes (HTTP 401/403/415, SSE 200/401, WS auth_ok/auth_error as specified).
- [x] (2026-07-12) Milestone 2 — unknown/nested payload rejection; server-owned risk with approval floor; selected-repo/file/session confinement; profile name/ref discovery; foreign/MCP selected read boundary; all CLI permission bypass flags removed; pre-dispatch gate covers default adapter; UI payload carries canonical repoPath. Full gates: 879 backend passed (+1 skipped), 833 frontend passed, `tsc`/build green. Runtime: selected CLI submitted as `waiting_approval` despite client `risk=low`; unselected and file traversal returned 403; selected foreign read 200/unselected 403; approval cancelled before adapter execution.
- [x] (2026-07-12) Milestone 3 — canonical `execute_agent` lifecycle and Event Store v1 envelope; terminal events carry repo/unit/type/status/duration/result/error/artifact refs; restart reconstructs context from JSONL; reverse-reader corruption fixed; `GET /commands/{id}/artifacts` and MCP `command_evidence` join terminal lifecycle with run-state; context_pack consumes nested camelCase; DuckDB ledger receives repo/unit/type/outcome/duration. Full backend: 884 passed (+1 skipped). Runtime `e2e_probe`: queued→CommandCompleted, run-state completed, refs present, ledger row matched same commandId.
- [ ] Milestone 4 — transactional approval/scheduler, state/backup and API ownership consolidation.
- [ ] Milestone 5 — simplify duplicate UI contracts after replacement E2E passes.
- [ ] Milestone 6 — repair mobile/accessibility/runtime noise with reproducible fixtures.
- [ ] Milestone 7 — self-contained fresh-install verification, docs and final independent review.

## Surprises & Discoveries

- The WIP is materially healthier than HEAD: it removes 61 tests with the deleted subsystems but changes the full backend gate from one failure to green and fixes 109 Ruff errors.
- The largest security issue is in the Vite filesystem API, not the token-gated Python bridge.
- Runtime 2D, WebGL and local view all booted without page errors; most directed Playwright failures are harness/contract drift, so a renderer rewrite would destroy working value.
- `task_run` exists inside `command_executors.py` but is absent from the public command schema and harness contracts.
- The recurrent DOM exposes 79 visible controls. Feature bloat is visible as interaction count, not merely file count.
- New-user runtime correctly shows onboarding; earlier claims that onboarding was unreachable were false and are rejected.
- Vitest WIP floors are lines 40%, branches 35%, functions 50%, statements 39%, and pass. The audit must not report the older HEAD threshold as current WIP truth.

## Decision Log

### D1 — Preserve renderers; share state, not drawing code

2D Canvas, Three.js and local isometric views answer different spatial questions. Rewriting them into one renderer is rejected because runtime evidence shows all three modes work and the visual character is a protected asset. We will align selection/task/status contracts and tests only.

### D2 — Keep local-first; remove accidental network exposure

The default Vite host becomes loopback. Remote access is not part of this plan because no authenticated Vite filesystem boundary exists. This is compatible with single-user local-first scope and closes exposure without inventing SaaS auth.

### D3 — Make `execute_agent` the canonical task lifecycle

The complex workspace-issue orchestrator is not promoted as the primary path. The canonical task is a validated `execute_agent` command tied to a selected repo path, unit and mission. UI, HTTP and MCP already converge on `/commands`; evidence and ledger will converge on the same command ID. The inaccessible `task_run` branch and task panel will be merged into this lifecycle or removed if they have no remaining consumer.

### D4 — Approval is based on action and scope, not ornamental labels

A user-clicked local task may remain auto-safe only when repo/file/unit are strictly confined. Unknown command types, unscoped paths and high/destructive risk never auto-run.

### D5 — Keep the WIP deletion of fatigue/tensor/swarm

The current WIP removes all live consumers, routes, events and tests for these systems. They do not improve the essential flow and would expand the security/state surface. Data-table migration/orphaning is documented; no compatibility layer is retained “just in case”.

### D6 — Do not delete 183 Knip exports blindly

Knip reports module-boundary noise and test seams as well as dead code. Only exports proven consumer-free across code, tests, docs, API/MCP and runtime may be removed, grouped by subsystem.

### D7 — Defer nonessential feature work

No new multi-tenancy, SaaS, training, agent swarm, news features, wonders or self-improvement systems are added. Gaceta/wonders/era may remain secondary if removing them risks unrelated visual regressions; they are not allowed to block the core flow.

### D8 — Selected repository is explicit membership, not broad-root containment

The canonical resolver accepts only a realpath that is a member of RepoCiv's selected repository set. That set is the union of persisted `selectedRepoPaths` and repositories returned by the canonical scanner for a user-selected root; scanner output is persisted before task dispatch. A root itself, arbitrary descendant, sibling, symlink escape or merely-existing absolute path is not membership. HTTP, MCP, Vite and agent execution call the same resolver contract: `resolve_selected_repo(repo_id_or_path) -> realpath | SelectedRepoError(code='not_selected'|'missing'|'escape')`. Multi-root fixtures must cover one selected repo per root and one unselected repo under each root.

### D9 — Loopback is not authentication

Browser mutations require both JSON Content-Type and either a valid token or trusted same-origin Origin. Foreign Origin and no-cors `text/plain` are rejected. WebSocket validates Origin before auto-auth; SSE never emits wildcard CORS. Vite, Python HTTP, WS and MCP use one allowlist derived from configured frontend origin(s). Empty development token does not mean unauthenticated mutation.

### D10 — Risk is server-owned

Clients may raise risk but never lower it. The server infers effective risk from command type, selected harness capabilities and requested scope. Repo-less Hermes conversation and read-only inspect are low; sandboxed repo writes are medium and wait for approval unless an explicit per-command user approval is present; unsandboxed/native mutation, external messaging, commit and deletion are high/destructive and always wait. Default adapters receive no permission-bypass flags. Clicking Send proposes work; it is not blanket approval for later risky tool actions.

## Milestone 0 — Adversarial plan validation

Submit the three audit documents and this ExecPlan to an independent reviewer. The rubric must check:

- missed command/file/path escapes;
- false confidence from mocks;
- whether the task path is truly observable end-to-end;
- dangerous deletion of WIP or renderer assets;
- vague acceptance criteria;
- missing rollback;
- scope creep and aesthetic regression.

Repeat at most three cycles. Record `verified=true` before Milestone 1.

Acceptance: review result explicitly says `verified=true`, or every objection is resolved in `Decision Log` with concrete evidence.

## Milestone 0.5 — Preserve atomic rollback boundaries

Before any further implementation, temporarily separate the uncommitted 2A edits from the preserved WIP, then split the original WIP using the forensic WIP clone as the exact baseline. Commit in dependency order:

1. tooling/lint/dependency cleanup;
2. fatigue/tensor/swarm removal plus live updates to `docs/implementation_plan.md`, `docs/DATA_SOURCES.md` and any other consumer-facing references;
3. local simulation and terminal-panel simplification;
4. renderer/city/terrain visual changes;
5. E2E/debug-contract changes;
6. public documentation alignment.

For every commit, stage only `HEAD→forensic-WIP` hunks belonging to that concern, inspect `git diff --cached`, run directed gates and record the hash in `Progress`. If a file mixes concerns, use WIP-relative patches; do not stage the whole file. Milestone 1 commit `1073194` is the only historical exception: it was staged from `forensic-WIP→working-tree`, and a cached-diff guard proved no threshold/terminal/xterm WIP hunk entered the commit. No Milestone 2–4 commit may proceed until this split is complete.

## Milestone 1 — P0 local browser/filesystem boundary

### Changes

- `vite-plugins/repociv.ts`
  - replace shell-string git invocations with `execFileSync('git', argv, options)`;
  - add a pure `resolveRepoRelativeFile(repoPath, file)` containment helper;
  - reject absolute paths, traversal, NUL and resolved paths outside repo;
  - preserve existing response schemas;
  - resolve repo IDs only through canonical selected-repository membership, never arbitrary configured-root descendants;
  - reject arbitrary encoded absolute repos, unselected repos, sibling paths and symlink escapes;
  - reject foreign `Origin` on every API mutation and remove wildcard CORS;
  - require JSON Content-Type plus same-origin or valid token for mutation; no-cors `text/plain` is 415/403.
- `vite.config.ts`
  - bind `127.0.0.1` by default;
  - permit non-loopback only behind an explicit environment flag documented as unsupported without a trusted proxy.
- Existing plugin test file or new `vite-plugins/repociv.security.test.ts`
  - metacharacter payload remains one argv element;
  - traversal/absolute paths return 400;
  - valid file history still works.

### Commands

    npx vitest run vite-plugins/repociv.security.test.ts
    npm exec -- tsc --noEmit
    npm exec -- eslint vite-plugins/repociv.ts vite.config.ts

### Observable result

No request-controlled value reaches a shell parser; dev server listens only on 127.0.0.1 in default config.

### Commit

`refactor: confine local filesystem api` plus follow-up `refactor: authenticate local browser mutations`.

## Milestone 1.5 — P0 Python HTTP, SSE, WebSocket and MCP boundary

### Changes

- `server/bridge.py`: mutation POSTs require `application/json` and either trusted Origin or valid bearer/token header, even when the configured token is empty; no wildcard CORS; explicit 403/415.
- `server/websocket_handler.py`: validate Origin during handshake before auto-auth; an empty token is not sufficient for foreign or missing browser Origin.
- SSE/read endpoints emit only configured same-origin CORS or none.
- MCP mutation tools call the same command validator/policy and selected-repo resolver; MCP does not bypass the browser policy merely because it is local.
- Tests cover trusted same-origin, foreign Origin, missing Origin with/without token, `text/plain`, WS handshake, SSE headers and HTTP/WS/MCP mutation parity.

Observable result: a foreign webpage cannot submit or auto-authenticate a command against localhost; a configured local frontend and authenticated CLI/MCP client still work.

Commit: `refactor: secure local bridge transports`.

## Milestone 2 — P0 command and session confinement

### Changes

- `server/command_schema.py` and `server/policy.py`
  - reject unknown types;
  - validate payload strings and per-command required fields;
  - safe unit identifier pattern;
  - explicit `repoPath` and `filePath` contracts;
  - clients can raise but never lower risk;
  - infer `execute_agent` risk from adapter capabilities and mutation scope, with medium/high tasks entering `waiting_approval`.
- `server/agent_runner.py`
  - resolve through canonical selected-repository membership, not a broad allowed root;
  - require working directory to exist, be selected and be realpath-contained;
  - require file path containment;
  - fail closed before spawning any CLI.
- `src/ui/hudWiring/inputs.ts` and city/map types
  - land selected-city `repoPath` wiring in this milestone before fail-closed enforcement;
  - reject tasks with no selected repo using an actionable UI message;
  - keep repo-less MAIN conversation only through the non-CLI Hermes conversation path, with no filesystem working directory; it must never fall through to Claude/Cursor/OpenClaw/Codex using the bridge cwd.
- `server/sessions.py`
  - sanitize/reject traversal IDs before constructing paths.
- `server/config_store.py` and `server/profile_identity.py`
  - accept discovered profile identifiers rather than arbitrary paths;
  - enforce containment before every identity read/write.
- `server/mcp_server.py` and `server/repo_profile.py`
  - root-scope nominally read-only filesystem tools;
  - reject arbitrary absolute directories outside selected roots.
- `server/security_harness.py` / canonical dispatch
  - run the pre-dispatch gate for every canonical `execute_agent` adapter, including the default CLI path, not only for the disconnected step orchestrator or Docker container path;
  - preserve local single-user use while failing closed on critical findings.
- CLI adapters
  - remove unconditional permission-bypass/trust flags from network-triggered execution, or require a separately approved privileged mode that is off by default.
- MCP/HTTP tests
  - traversal, `/`, `../../unit`, sibling escape and symlink escape fail;
  - a selected temporary repo succeeds.

### Commands

    pytest -q server/test_e2e_probe.py server/test_agent_runner.py server/test_sessions.py server/test_config_store.py server/test_mcp_server.py
    ruff check server/command_schema.py server/agent_runner.py server/sessions.py server/config_store.py server/profile_identity.py server/mcp_server.py server/repo_profile.py

### Observable result

No network command or MCP read can select arbitrary cwd, file, profile or session directory. Existing selected-repo tasks still dispatch. Repo-less MAIN conversation is explicitly non-CLI/non-filesystem. No adapter receives an unconditional permission-bypass flag from the default route.

### Commit

`refactor: enforce agent execution boundaries`

## Milestone 3 — P0 essential lifecycle

### Architecture

Use `/commands` and `execute_agent` as the sole task start contract. A task payload contains:

- selected `repoPath` and stable repo ID;
- selected `unit`;
- nonempty `mission`;
- optional harness/provider/model;
- command ID used by events, status, evidence and ledger.

### Changes

- `src/ui/hudWiring/inputs.ts`: consume the selected city's real `repoPath` contract landed in Milestone 2; do not create a second target-resolution path.
- `src/map.ts` / types as needed: preserve repo identity/path on city.
- `server/command_schema.py`: require fields for `execute_agent`.
- `server/command_executors.py`, `server/event_store.py`, `server/context_pack.py` and `server/research_ledger.py`: define and emit one versioned lifecycle envelope under the same command ID with actor, repo ID/path, unit, harness/model, start/end, status and result/error; expose evidence artifact/query by command ID and ingest that exact envelope into the ledger.
- `server/approval_store.py` and `server/scheduler.py`: make approval→enqueue→dispatch transitions idempotent and failure-safe; a failed enqueue/dispatcher records terminal failure and never silently drops the command.
- `src/bridge.ts`: send rejection to `/reject`, never `/approve`; cover HTTP fallback and WS parity.
- `src/ui/taskPanel.ts` and `taskAssignPanel.ts`: merge into a thin view over actual commands or remove simulated task choices if no longer consumed.
- `server/task_orchestrator.py`: keep only if a live consumer remains; otherwise document as deferred and remove its inaccessible route/branch in the WIP cleanup commit.
- Add an isolated E2E probe that uses a harmless deterministic harness/command executor, not a fake UI-only state.

### Acceptance scenario

1. Select a temporary real git repo.
2. Select MAIN.
3. Submit a deterministic task.
4. Observe proposed/queued/running/terminal state.
5. For a high-risk variant, observe waiting_approval and reject/approve.
6. Inspect output artifact.
7. Query ledger by command ID and verify repo/unit/status/duration.
8. Inject enqueue and dispatcher failures and verify the command is recoverable or terminally failed, never dropped.

### Commit

`feat: connect selected repos to agent tasks`

## Milestone 4 — P1 transactional reliability, API ownership and persistence

### Changes

- Failure-injection hardening for `approval_store.py` and `scheduler.py`: durable state is not removed until enqueue/thread start succeeds; retries are idempotent; failures become recoverable or terminal events.
- Move filesystem/repo-selection ownership to authenticated Python routes. Vite endpoints remain thin same-origin adapters only until HTTP/MCP/UI replacement E2E passes, then are removed in a separate commit.
- `profile_identity.py` and `config_store.py` accept discovered profile IDs, enforce profile-root containment and reject `harness_ref` traversal in every read/write route.
- Define the versioned terminal event envelope in Milestone 3; Milestone 4 only migrates remaining legacy consumers and removes adapters after parity tests.
- Consume transport `ack` before domain validation in `src/bridge.ts` / `bridgeSchema.ts`.
- Add failure-injection, profile traversal, API parity and real serialized-event adapter tests.

### Commands

    pytest -q server/test_event_store.py server/test_context_pack.py server/test_research_ledger.py server/test_approval_store.py server/test_scheduler.py server/test_config_store.py server/test_profile_identity.py
    npx vitest run src/bridge.test.ts src/bridgeSchema.test.ts

### Commit

`refactor: harden local state transitions`

### Persistence sub-milestone

- Route missions, approvals, scheduler queue, events, sessions, run-state, workspace-state, profiles/config, selected roots and DuckDB through one explicit state root.
- Make mission/config writes atomic and quarantine corrupt state instead of silently replacing history.
- Update `scripts/repociv-backup.sh` to back up every canonical store without copying its own backup directory.
- Align Docker volumes and systemd `EnvironmentFile` with the same root.
- Add a backup→restore integration test using only temporary directories.

Commit: `refactor: unify local state and backups`.

## Milestone 5 — Integrate WIP pruning and simplify surface

### Duplicate-feature disposition before deletion

| Capability | Surviving owner | Temporary adapter | Removal condition |
|---|---|---|---|
| Task start | `src/ui/hudWiring/inputs.ts` → `/commands` `execute_agent` | `taskAssignPanel.ts` may translate legacy choices | Core selected-repo E2E passes through canonical command |
| Task status/approval | command status + `approvalPanel.ts`; `taskPanel.ts` becomes a read-only view | workspace issue phases | Real command queued/running/terminal/reject UI E2E passes |
| Cancellation | `POST /commands/:id/cancel` and MCP `command_cancel` | legacy task cancel route | HTTP/WS/MCP parity and scheduler recovery tests pass |
| Work evidence | `run_state` + versioned event artifact query by command ID | workspace issue artifacts | Ledger attribution E2E passes |
| MCP tasks | `command_submit`, status/query, approval/reject/cancel | `task_*` tools | Canonical MCP lifecycle test passes |
| Onboarding | `src/ui/onboardingPanel.ts` only | command palette links into same panel | New-user screenshot and keyboard E2E pass |
| Chronicle/log/timeline | versioned event store + `timelinePanel.ts` view; ledger is analytics | replay/legacy log adapters | Event envelope migration and query tests pass |
| Filesystem/repo selection | authenticated Python routes + canonical resolver | Vite same-origin adapters | UI and MCP replacement E2E pass |
| Pending/priority/construction | secondary manual planning views, never task execution | none | Keep only if consumer/reducer tests pass |

No route, panel, artifact store or MCP tool in the adapter column is deleted in the same commit that introduces its replacement.

Split existing WIP by concern; do not create one mega-commit.

1. `refactor: remove unused swarm and fatigue subsystems`
   - deleted fatigue/tensor/swarm files, routes, schemas, tests and dependent docs/config.
2. `refactor: simplify simulated local operations`
   - terminal panel deletion and local/config/task simulation cleanup proven consumer-free.
3. `feat: refine city composition and terrain contact`
   - 3D city/ground/props changes only, with visual tests and screenshots.
4. `test: stabilize renderer and chat e2e contracts`
   - E2E changes and narrowly scoped debug API used only under dev/test build, or replace with user-observable entry paths.
5. `docs: align public scope with implemented product`
   - README/SCOPE/ROADMAP/API/MCP/architecture.

Before each commit:

    git diff --check
    git diff --cached --stat
    git diff --cached

Acceptance: no deleted symbol is referenced by source/tests/docs live/API/MCP; each commit passes its directed gates.

## Milestone 6 — P2 UX, accessibility and runtime noise

### Changes

- Prevent automatic wonder launch requests when preconditions are false; no boot-time 412.
- Stop importing `public/assets/office-atlas.json` as a source module; move the generated manifest under `src` or fetch it by public URL when local view opens, with a tested procedural fallback.
- Reduce primary HUD to repo, agent, task, status, approvals and evidence; move secondary tools behind Advanced/System/Chronicle groupings without removing visual world detail.
- Label `chat-input`, `mission-input`, profile soul textarea and toggles.
- Convert clickable hero slots/header controls to semantic buttons or add complete keyboard roles.
- Mobile CSS: no horizontal document overflow at 390×844; one bottom sheet/drawer; target size ≥44 px.
- Respect reduced motion for decorative animation and idle loops.

### Reproducible visual fixture and tests

- Generate a fixed 12-repository fixture with stable names, file counts, git metadata and city coordinates under a temporary selected root.
- Capture flat at fixed camera/zoom, WebGL at fixed camera transform, local at fixed selected repo/tile and mobile at 390×844.
- Start the canonical capture with a healthy bridge and no degraded banner; fail if a runtime warning/invalid-event overlay remains.
- Compare with Playwright screenshot baselines: `maxDiffPixelRatio <= 0.02` for flat/local/mobile and `<= 0.05` for WebGL; masks are limited to timestamps/cursor only.
- Human reviewer rubric must answer yes/no for: every building/prop contacts terrain; doors/windows/chimneys/flags remain visible at baseline scale; labels are legible and non-overlapping; city walls do not intersect buildings; the 12-city count is visible in captured state.
- DOM accessibility tests cover labels/roles.
- Playwright asserts `scrollWidth <= innerWidth`.
- Runtime console asserts no automatic 412 and no invalid `ack` warning.

### Commit split

- `refactor: focus the operational hud`
- `feat: support accessible compact viewports`
- `test: cover runtime ui contracts`

## Milestone 7 — Full verification and documentation

### Fresh gates

    bash scripts/check.sh
    npx playwright test --project=chromium
    npm audit --package-lock-only
    git diff --check

Fresh clone/worktree is self-contained and does not reuse the working tree's virtualenv or state:

    git clone --no-hardlinks <local-repo> <temporary-dir>
    cd <temporary-dir>
    npm ci
    python3 -m venv .venv
    .venv/bin/python -m pip install -r requirements.txt
    npx playwright install chromium
    export PATH="$PWD/.venv/bin:$PATH"
    export REPOCIV_DATA_DIR="$(mktemp -d)" REPOCIV_CONFIG_DIR="$(mktemp -d)" XDG_STATE_HOME="$(mktemp -d)"
    export REPOCIV_TOKEN=<temporary-nonempty-token> REPOCIV_PORT=<free-port> BRIDGE_PORT=<free-port> BRIDGE_WS_PORT=<free-port>
    export REPOCIV_ALLOWED_ORIGINS="http://127.0.0.1:<frontend-port>"
    bash scripts/check.sh
    npx playwright test --project=chromium

Then start bridge/frontend on those temporary ports, create/select a temporary git repo through the user-visible/API path, submit a deterministic harmless command, exercise approval/rejection/cancel/evidence/ledger through UI, HTTP and MCP without `window.__repocivDebug`, capture the reproducible visual fixture, and tear down only those processes/state roots. Wait at least 15 seconds before judging map load.

Final checker is independent from implementer and verifies every accepted finding. Maximum three correction cycles per persistent finding.

Operational services must also be verified: loopback bind by default, explicit state/config roots, no inherited broken Conda activation, consistent bridge/WS ports, and no development server exposed network-wide. Docker may be archived rather than repaired if no live consumer is found, but the decision and evidence must be recorded.

Acceptance:

- no P0/P1 open;
- all canonical gates green, or a HEAD-only exception is freshly reproduced and isolated;
- essential lifecycle passes end-to-end;
- `src/main.ts` and every touched TS file pass Prettier; the known WIP failure is not accepted debt;
- coverage floors are explicit and must not be lowered during implementation: frontend lines 40%, branches 35%, functions 50%, statements 39%; backend 50%. Raising them requires meaningful tests, not exclusion tricks;
- no console/page/request error in the core path;
- no 390 px overflow;
- flat/WebGL/local visual comparison protects personality and terrain contact;
- feature matrix/docs/code/tests agree;
- `verified=true`;
- clean branch and atomic commits.

## Rollback and recovery

- Original WIP is recoverable from the forensic directory, including binary diff and checksums.
- Every milestone is an atomic commit; rollback uses `git revert <commit>` rather than reset.
- Runtime tests use temporary state roots and alternate ports; they do not mutate the user's canonical ledger.
- Before deleting any tracked subsystem, verify its patch is present in `wip.patch` and commit only its coherent file set.
- If a migration touches persisted state, copy the state root first and provide a read-only migration report; no destructive migration is allowed in this plan.

## Outcomes & Retrospective

To be completed after verification. It must state what shipped, rejected decisions, exact gate counts, bundle/resource/mobile metrics, screenshot paths, residual risks and rollback commits. It must not say “should work”.
