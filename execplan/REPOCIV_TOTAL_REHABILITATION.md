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
- [x] (2026-07-12) Milestone 0 — adversarial review cycle 1 `VERIFIED=false`; four plan gaps corrected; cycle 2 `VERIFIED=true` with no blockers.
- [ ] Milestone 1 — close Vite shell injection and loopback boundary.
- [ ] Milestone 2 — confine command payloads, repo/file paths, profiles, MCP reads and session IDs.
- [ ] Milestone 3 — make one essential task lifecycle reachable and truthful.
- [ ] Milestone 4 — align terminal events, context and ledger attribution.
- [ ] Milestone 5 — integrate deliberate WIP pruning and simplify duplicate UI contracts.
- [ ] Milestone 6 — repair mobile/accessibility/runtime noise without harming visual character.
- [ ] Milestone 7 — stabilize E2E, run full/fresh gates, align docs and final independent verification.

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

## Milestone 1 — P0 Vite filesystem boundary

### Changes

- `vite-plugins/repociv.ts`
  - replace shell-string git invocations with `execFileSync('git', argv, options)`;
  - add a pure `resolveRepoRelativeFile(repoPath, file)` containment helper;
  - reject absolute paths, traversal, NUL and resolved paths outside repo;
  - preserve existing response schemas;
  - confine every decoded repo ID itself to a configured selected root before any filesystem or git operation;
  - reject arbitrary encoded absolute repos, sibling paths and symlink escapes.
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

`refactor: confine local filesystem api`

## Milestone 2 — P0 command and session confinement

### Changes

- `server/command_schema.py`
  - reject unknown types;
  - validate payload strings and per-command required fields;
  - safe unit identifier pattern;
  - explicit `repoPath` and `filePath` contracts.
- `server/agent_runner.py`
  - resolve allowed roots from configured RepoCiv roots;
  - require working directory to exist and be contained;
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
- `server/command_executors.py`: emit terminal event and evidence under the same command ID.
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

## Milestone 4 — P1 event/context/ledger contract

### Changes

- Define one versioned terminal event envelope in `server/event_store.py`.
- Update `context_pack.py` to consume camelCase/nested data or centralize deserialization.
- Update `research_ledger.py` to join lifecycle events by command ID and preserve actor, repo, model, start/end and result/error.
- Make `ack` a valid transport-only message or consume it before domain schema validation in `src/bridge.ts` / `bridgeSchema.ts`.
- Contract tests use real serialized events, not hand-shaped legacy dicts.

### Commands

    pytest -q server/test_event_store.py server/test_context_pack.py server/test_research_ledger.py
    npx vitest run src/bridge.test.ts src/bridgeSchema.test.ts

### Commit

`refactor: align task events and ledger evidence`

### Persistence sub-milestone

- Route missions, approvals, scheduler queue, events, sessions, run-state, workspace-state, profiles/config, selected roots and DuckDB through one explicit state root.
- Make mission/config writes atomic and quarantine corrupt state instead of silently replacing history.
- Update `scripts/repociv-backup.sh` to back up every canonical store without copying its own backup directory.
- Align Docker volumes and systemd `EnvironmentFile` with the same root.
- Add a backup→restore integration test using only temporary directories.

Commit: `refactor: unify local state and backups`.

## Milestone 5 — Integrate WIP pruning and simplify surface

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

### Tests

- DOM accessibility tests for labels/roles.
- Playwright viewport assertion: `scrollWidth <= innerWidth`.
- Runtime console assertion: no automatic 412, no invalid `ack` warning.
- Baseline/post screenshots for flat, WebGL, local and mobile.

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

Fresh clone/worktree:

    git clone --no-hardlinks <local-repo> <temporary-dir>
    npm ci
    bash scripts/check.sh
    npx playwright test --project=chromium

Runtime verification uses isolated ports/state, real selected repos, deterministic harmless task executor and screenshots. Wait at least 15 seconds before judging map load.

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
