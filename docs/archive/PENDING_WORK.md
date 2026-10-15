# Pending Git work — first feedback iteration

## Problem and accepted scope

Find uncommitted work before watching agents move. Show the selected repositories of the active map and their linked Git worktrees, with branch, files, conflicts and persistent observed age. Show related sessions as context, never as authors. This iteration does not instrument agent writes or classify work as abandoned.

## Contract

`GET /api/pending-work` is a local read-only Git inventory. It accepts no filesystem path from the request. The bridge discovers worktrees from the canonical selection and samples Git without running hooks, changing branches, fetching, committing or discarding files. Sampling explicitly disables `core.fsmonitor` so a configured filesystem-monitor hook cannot execute, and removes inherited `GIT_CONFIG_*` overrides.

The response has `available`, `sampledAtMs`, `entries`, `errors` and optional `persistenceError`. Entries include repo/worktree paths, branch or detached HEAD, HEAD, `state` (`dirty`, `clean`, `unavailable`), staged/unstaged/untracked/conflict/changed file counts, file status pairs, observed timestamps and related-session metadata. All counts refer to paths, not diff lines; staged and unstaged counts may overlap. Rename records count as one path. Untracked directories are expanded so counts are individual files. Ignored files are excluded by Git. Bare repositories and inaccessible worktrees must not become false clean results.

Each dirty episode is scoped to a worktree and branch/HEAD evidence. Its first observed timestamp survives bridge restarts. A successfully observed clean state or branch/HEAD transition resets the episode; returning to an earlier branch does not resurrect its old timestamp. A failed observation retains the last known episode, including linked worktrees outside the selected root, and does not advance its last successful observation. Retention uses recorded Git-repo ownership, not directory containment; independent nested repositories are not part of their parent Git family. Fresh confirmed states always take precedence over retained fallbacks, regardless of selection order. This is a lower-bound observation, not the time of the original edit. Changes made and resolved between samples are not observable. Monitoring is on demand while the Activity panel is open; there is no background observer or complete historical timeline.

Persistence uses a separate XDG state file with an explicit test override, atomic replacement and serialized updates. State failure is visible. No diff content, prompts, credentials or process arguments are stored or returned.

## UI

Use the existing Activity panel fetch cycle, not another polling timer. Place pending work ahead of process groups and orchestrator tasks. Sort conflicts first, then oldest observed dirty work. Keep dirty/unavailable worktrees visible within the explicitly announced scan/display limits; summarize clean entries in an expandable section. Display full paths and files in expandable details. Maintain opened details, scroll and focused control across updates.

Always explain: observed age is not actual edit age; related sessions do not prove authorship; no related session does not prove abandonment. Network failure retains the previous snapshot with a stale warning. Partial Git failures and persistence errors remain visible. A missing bridge endpoint is unavailable, not zero pending work.

## Acceptance and verification

- Real temporary Git repos test staged, unstaged, untracked, conflict and rename parsing, linked/detached worktrees, clean reset, branch/HEAD changes, errors and persistence reload.
- Unit tests cover response validation, ordering, escaping and honest labels.
- Browser checks exercise the actual panel module, prioritization, complete list, open/focus retention, stale fallback and a narrow viewport without launching agents or mutating user repos.
- Exercise a fresh isolated bridge against scratch repos; do not restart a live bridge blindly.
- Run the repository gate and inspect an independent adversarial review before a local commit. No push.

## Verification evidence

- 78 backend tests pass, including real scratch repositories and the actual bridge HTTP handler in two fresh isolated processes. The restart check preserves first-observed timestamps and verifies unchanged Git index mtimes.
- 7 presentation/validation unit tests pass. The pending-work browser harness passes 5 tests across desktop/narrow viewports and dark/light themes; 4 existing Activity regression tests also passed. These are harness checks, not a claim that the entire live dashboard was exercised.
- The repository gate (`taskset -c 0,1 bash scripts/check.sh`) passed with 1,138 frontend tests and 1,496 backend tests, 2 backend skips. It included build, lint, formatting, coverage and asset/bundle budgets. `knip` was report-only; `mypy` was unavailable.
- Independent adversarial review found a nested-repo retention bug. Parent reproduced it before the fix, added both selection orders and deselection regressions, and corrected repo ownership, seen-worktree filtering and snapshot precedence. A further real fsmonitor-hook regression failed before the sampling override and passes after it.
- No live bridge restart, agent launch or user-map selection change was needed for these checks.

## Limits

Git does not identify who left uncommitted changes. First observed age is not file mtime or last-commit age. This view covers checked-out worktrees of selected repos, not every dormant branch. Linked worktrees can live outside the selected root. Selection is strictly the active map root; an empty selection does not fall back to another root. The Git subprocess sampling budget is 6 seconds (each command receives only the remaining time, at most 5 seconds); exhausted scans are visibly partial. At most 400 prioritized entries are returned, with an explicit warning when limited. At most 200 file paths per entry are returned with an explicit warning and complete file counts. Observation history retains up to 500 episodes and expires deselected episodes after 30 days; unavailable sampled worktrees keep their known age. Limits are not evidence of an exhaustive inventory. Related sessions use the existing registries: associated repo paths for external/own sessions and cwd for live Claude sessions. A repo association need not establish the exact linked worktree used. Labels contain only unit/display names, never mission or prompt text; each registry is snapshotted once per scan. Related context is not edit evidence. The single-user bridge is the supported deployment; broader cross-process persistence guarantees must not be claimed without tests.
