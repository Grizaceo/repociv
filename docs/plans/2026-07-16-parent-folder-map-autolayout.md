# Parent-folder map auto-layout implementation plan

> **For Hermes:** Execute this plan task by task with RED-GREEN-REFACTOR and verify every commit.

**Goal:** Add an atomic “Use parent folder as map” flow to the construction panel while preserving manual placement.

**Architecture:** Extend inspection with a read-only parent preview. Add one authenticated mutation that derives the parent server-side, scans eligible children, and commits `RepoRootsState.setRootSelection()`. Reuse `generateWorld()` for placement and treat manual coordinates as overrides only for selected repositories.

**Tech stack:** TypeScript 5.9, Vite 6 plugin middleware, Vitest 4, Playwright 1.59, Three.js 0.175.

## Global constraints

- Do not add dependencies.
- Do not create a second city-layout algorithm.
- Do not delete or rewrite manual-layout storage.
- Derive and validate the parent server-side.
- Persist root activation and selection in one state write.
- Keep existing construction controls and keyboard navigation.

---

### Task 1: Specify parent-folder discovery

**Files:**
- Modify: `vite-plugins/repociv.test.ts`
- Modify: `vite-plugins/repociv.ts`

**Interfaces:**
- Produces: `inspectParentFolderMap(inputPath, inspectRepo, scanWorkspace)` returning `{ repo, parentMap: { rootPath, repos } }`.

1. Add failing tests for parent derivation, direct children, technical-directory exclusion, missing paths, and empty eligible parents.
2. Run `npx vitest run vite-plugins/repociv.test.ts`; confirm the new symbol or assertions fail.
3. Add a shared eligibility predicate and the minimal parent-preview helper.
4. Reuse the predicate inside workspace scanning.
5. Run the focused test; confirm green.

### Task 2: Add atomic apply operation

**Files:**
- Modify: `vite-plugins/repociv.test.ts`
- Modify: `vite-plugins/repociv.ts`
- Modify only if a missing invariant appears: `vite-plugins/repoRootsState.test.ts`

**Interfaces:**
- Produces: `applyParentFolderMap(inputPath, inspectRepo, scanWorkspace, rootsState)`.
- HTTP: `POST /api/map-from-parent` with `{ path: string }`.

1. Add a failing integration test with a temporary directory tree and state file.
2. Assert that success activates the derived parent and selects every eligible child.
3. Assert that an empty parent throws before state mutation.
4. Run the focused test and confirm red.
5. Implement the operation with one `setRootSelection()` call.
6. Register the authenticated route with 400, 404, 422, and 500 responses matching existing middleware conventions.
7. Run plugin and root-state tests; confirm green.

### Task 3: Add construction-panel preview and action

**Files:**
- Modify: `src/ui/constructionPanel.ts`
- Modify: `src/styles.css`
- Create: `e2e/parent-folder-map.spec.ts`

**Interfaces:**
- `inspectRepoPath(path)` returns `{ repo, parentMap }`.
- `applyParentFolderMap(path)` returns root and selected repository IDs/paths.

1. Add a failing Playwright flow with intercepted inspection, apply, selection-state, and repositories endpoints.
2. Open Construction, inspect a path, and expect parent path, child count, sample names, and action copy.
3. Click the action and assert the apply request contains only the inspected path.
4. Assert localStorage receives the server-returned IDs and the page reloads.
5. Implement typed API helpers and the preview block.
6. Add loading, empty, and error states without native dialogs.
7. Keep “New city”, tile selection, relocation, and removal controls unchanged.
8. Run the focused E2E; confirm green.

### Task 4: Scope manual coordinates to selected repositories

**Files:**
- Modify: `src/map.test.ts`
- Modify: `src/map.ts`

**Interfaces:**
- `generateWorld()` applies manual coordinates to selected repositories but does not inject unselected manual entries when an explicit selection exists.

1. Add a failing test with two selected repositories and one unrelated manual-layout entry.
2. Assert the matching selected repository uses its manual coordinate.
3. Assert the unrelated entry does not become a city.
4. Run `npx vitest run src/map.test.ts`; confirm red.
5. Restrict manual entry augmentation when local selection exists; preserve current fallback when no selection exists.
6. Run the focused test; confirm green.

### Task 5: Verify the complete flow

**Files:**
- Create: `docs/audits/2026-07-16-3d-parent-folder-map.md`
- Do not commit generated PNGs unless the repository already tracks audit images.

1. Run focused Vitest suites.
2. Run `npm run lint` and `npm run format:check`.
3. Run `npm run check`.
4. Run `scripts/check.sh` for the full frontend, backend, asset, security, and bundle gates.
5. Restart the dev stack from the feature branch if the reused processes point at stale code.
6. Run the focused Playwright spec.
7. Capture the parent-folder map at overview, medium, and close 3D zooms.
8. Record city count, tile count, props readiness, console errors, HTTP errors, and visual findings in the audit document.
9. Review `git diff --check`, `git diff --stat`, and the final branch log.
10. Commit production changes in functional slices; use `feat:` or `test:` prefixes, never `fix:`.

## Verification gate

The feature is complete only when:

- the focused RED tests became GREEN;
- `scripts/check.sh` exits 0;
- the focused E2E proves preview, apply, reload, and city count;
- the live 3D capture contains the expected cities;
- manual placement remains visible and callable;
- `git status --short` is clean after commits.
