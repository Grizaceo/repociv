# Parent-folder map reload

Date: 2026-07-16
Status: approved for implementation

## Goal

After a user inspects a folder in the construction panel, RepoCiv offers to replace the current map with every eligible direct child of that folder's parent. RepoCiv places new cities with its existing deterministic layout and preserves manual coordinates for matching cities.

## Current behavior

`openConstructionPanel()` can inspect one path and place that folder manually. It cannot promote the inspected folder's parent to the active map root.

`generateWorld()` already places repositories with a deterministic hex spiral and a minimum city distance of three. A second auto-layout algorithm would duplicate behavior and drift.

`RepoRootsState.setRootSelection()` already performs the in-memory root transition. The parent-map operation builds an exclusive draft, persists it with a temporary file plus atomic rename, and only then replaces the live state reference.

## User flow

1. The user opens Construction and enters a folder path.
2. “Inspect route” returns the inspected repository plus a parent-map preview.
3. The panel shows the parent path, eligible child count, and up to five child names.
4. The user chooses “Use parent folder as map”.
5. The server validates the inspected path again, scans the parent, clears selections under previous roots in a draft, marks the parent as active, selects every eligible direct child, and persists once.
6. The client reloads. Startup rehydrates browser selection from the canonical server state.
7. `generateWorld()` lays out selected repositories. Existing manual coordinates override automatic coordinates only for matching repositories.

The existing manual placement controls remain available.

## API contract

### `POST /api/repo/inspect`

Request:

```json
{ "path": "/absolute/path/to/child" }
```

Response:

```json
{
  "repo": { "id": "encoded-id", "repoPath": "/absolute/path/to/child" },
  "parentMap": {
    "rootPath": "/absolute/path/to",
    "repos": [{ "id": "encoded-id", "repoPath": "/absolute/path/to/child" }]
  }
}
```

The endpoint remains read-only.

### `POST /api/map-from-parent`

When a RepoCiv mutation token is configured, this endpoint requires a valid `X-RepoCiv-Token` header and returns HTTP 401 for a missing or invalid token. Same-origin fallback is allowed only when no token is configured.

Request:

```json
{ "path": "/absolute/path/to/child" }
```

Response:

```json
{
  "rootPath": "/absolute/path/to",
  "repos": [{ "id": "encoded-id", "repoPath": "/absolute/path/to/child" }],
  "selectedRepoIds": ["encoded-id"],
  "selectedRepoPaths": ["/absolute/path/to/child"]
}
```

The server derives the parent. It does not trust a client-supplied parent path.

## Folder eligibility

The parent scan includes direct child directories only. It excludes:

- hidden names;
- RepoCiv itself;
- dependency, build, cache, and virtual-environment directories: `node_modules`, `dist`, `build`, `coverage`, `__pycache__`, `.venv`, and `venv`.

The scan keeps non-Git directories because RepoCiv models folders, not only Git repositories.

## State and manual coordinates

The operation replaces the canonical map selection with the parent's eligible children. Registered roots remain available, but their previous selections are cleared so server fallback cannot reconstruct a union.

The operation never deletes `repociv:manual-layout:v1`. A selected repository with a saved manual coordinate keeps that coordinate. A selected repository without one receives the existing automatic coordinate. Manual entries outside the selected map remain stored but do not become cities solely because they exist in manual-layout storage.

## Error handling

- Missing or non-string `path`: HTTP 400.
- Missing directory: HTTP 404.
- Parent with no eligible child directories: HTTP 422; state remains unchanged.
- Invalid mutation token: HTTP 401.
- UI errors stay inside the construction panel and keep the current map loaded.

## Acceptance criteria

- AC-1: Inspecting a folder shows its parent and eligible direct children.
- AC-2: The parent-map action atomically activates the parent and selects every eligible child.
- AC-3: A successful action reloads the map with the returned selection.
- AC-4: Automatic placement uses `generateWorld()`; no second layout algorithm exists.
- AC-5: Matching manual coordinates survive the reload and manual construction remains available.
- AC-6: Unselected manual-layout entries do not leak into the parent-scoped map.
- AC-7: Invalid paths and empty parents do not alter root state.
- AC-8: Typecheck, lint, format, unit/integration tests, build, focused E2E, and post-change 3D capture pass.

## Test strategy

```yaml
test_strategy:
  artifact: "parent-folder map preview, apply endpoint, and construction-panel flow"
  rationale: "The feature combines path validation, filesystem discovery, atomic persisted state, browser storage, reload behavior, and a user-facing map transition."
  criticality: "MEDIUM-HIGH"

  selected_types:
    - rationale: "Eligibility and parent derivation contain deterministic branching and path transformations."
      type: "unit"
      size: "small"
      framework: "vitest"
      dependencies: ["temporary directories for filesystem cases"]
      gate: "Gate 1"
    - rationale: "The apply operation crosses filesystem and persisted RepoRootsState boundaries; real temporary files prevent mocks from hiding state bugs."
      type: "integration"
      size: "medium"
      framework: "vitest"
      dependencies: ["temporary root-state file", "temporary directory tree"]
      gate: "Gate 2"
    - rationale: "The construction-panel action is a user-facing primary navigation path and must prove request, canonical server reconciliation, and reload in a browser."
      type: "e2e"
      size: "large"
      framework: "Playwright"
      dependencies: ["local Vite server", "network interception for an isolated folder fixture"]
      gate: "Gate 3"
    - rationale: "RepoCiv is deployable and the final live capture verifies that the selected parent renders as a 3D map."
      type: "smoke"
      size: "large"
      framework: "Playwright capture plus runtime probes"
      dependencies: ["local Vite server", "local bridge"]
      gate: "Gate 5"

  rejected_types:
    - reason: "The API and client deploy together and have no independent consumers; Gate 4 is off."
      type: "contract"
    - reason: "Path classes are finite and covered with equivalence partitions; property-based setup adds little value."
      type: "property-based"
    - reason: "The project has no component-test DOM harness; the focused Playwright flow covers the rendered panel without adding another framework."
      type: "component"

  deliberately_skipped:
    - why: "The task does not change city meshes, shaders, or asset generation."
      what: "Pixel-golden thresholds for Blender assets"
    - why: "SwiftShader capture time is not representative of the user's RTX 4060."
      what: "A hard performance budget for maps larger than 24 cities"
```

## Test cases

### AC-1 and AC-7

- [unit] A valid inspected child returns its real parent and eligible siblings.
- [unit] Hidden and technical directories are excluded.
- [unit] A missing child returns not found.
- [integration] An empty eligible parent rejects without changing persisted state.

### AC-2

- [integration] Applying a parent map makes the parent active and replaces its selection with all eligible children.
- [integration] A write persists one coherent root-selection state.

### AC-3 and AC-4

- [e2e] The construction panel displays the preview, posts the inspected path with mutation auth, reloads, and rehydrates selection from the server.
- [e2e] The reloaded world exposes one macro city per returned repository.

### AC-5 and AC-6

- [unit] A matching manual layout entry overrides an automatic coordinate.
- [unit] An unselected manual layout entry remains absent from a scoped map.

### AC-8

- [smoke] The post-change 3D page reports WebGL mode, ready props, non-zero macro cities, and no page error.
