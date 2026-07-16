# RepoCiv 3D visual audit and parent-folder map verification

Date: 2026-07-16
Branch: `feat/parent-folder-map-autolayout`
Implementation capture HEAD: `7ac3a7392560b24917fccc1dfff490b270603ab4`
Base: `c09187ba5406275f957074a7d417464f2db13cef`

## Verdict

The parent-folder map flow is functionally implemented and visually usable. Inspecting a real folder now previews its parent and eligible direct children; applying the action persists an exclusive canonical selection, makes the parent active, reloads, reconciles browser storage from the server, and delegates placement to the existing deterministic hex-spiral layout. Manual placement remains visible and matching manual coordinates remain authoritative.

No feature-specific visual blocker was found at 1440×900. The 3D view still has material P1/P2 presentation debt: dense-map camera framing clips peripheral cities at medium zoom, HUD panels conceal substantial territory, and city assets lack enough scale/detail contrast at close range.

## Evidence provenance

### Pre-change 3D audit

Directory:

`/home/gris/.hermes/workspace/reports/repociv/2026-07-16_3d_live_audit/`

Captures:

- `00-current-inherited-overview-hud.png`
- `00-current-inherited-overview.png`
- `01-active24-general-overview-hud.png`
- `01-active24-general-overview.png`
- `02-active24-strategic-mid.png`
- `03-active24-city-mid.png`
- `04-active24-city-close.png`

The inherited active root produced 2 actual cities from 55 stale selections. The controlled dense scenario rendered 24 real `ACTIVE` repositories, 650 tiles, atlas and prop families settled, and zero page errors. The initial stale process produced repeated `/api/files` 401 responses, so those captures prove macro rendering, not district loading.

### Post-change UI and 3D audit

Directory:

`/home/gris/.hermes/workspace/reports/repociv/2026-07-16_parent-folder-map-post/`

Captures:

- `post-01-parent-map-preview.png`
- `post-02-parent-map-12-cities-hud.png`
- `post-03-parent-map-12-cities-clean.png`
- `runtime-report.json`

Live preview against `/home/gris/.hermes/workspace/ACTIVE/repociv` returned:

- parent: `/home/gris/.hermes/workspace/ACTIVE`
- eligible direct children: 52
- technical children present: none

The post-change browser applied 12 real `ACTIVE` repositories in an isolated route so the user's selection state was not modified. Runtime evidence:

- renderer: WebGL
- macro cities: 12
- tiles: 440 total, 120 revealed
- terrain atlas ready: true
- city props settled: true
- forest props settled: true
- WebGL frame time average under SwiftShader: 15.15 ms across 67 sampled frames
- page errors: 0
- failed requests: 0
- HTTP errors: two 403 responses from `/api/files`

The two 403 responses are an isolation artifact: the browser intercepted the state mutation while the real bridge continued authorizing the unchanged user selection. Production resolves every file request through `resolve_selected_repo()`, which reloads the shared `REPOCIV_STATE_FILE` on each request. Backend integration tests exercise the real state mutation.

## Feature behavior

1. `POST /api/repo/inspect` returns the inspected repository plus a parent-map preview.
2. The preview scans only direct child directories and excludes hidden/technical directories plus symlink targets whose real path escapes the parent root.
3. The construction panel shows the parent path, eligible count, a five-name sample, explicit replacement semantics, and the automatic reload button.
4. `POST /api/map-from-parent` resolves the inspected path, derives the real parent, scans eligible children, creates an exclusive state draft, persists it, and only then swaps live state.
5. The frontend sends mutation auth and reloads; startup reconciles localStorage from server state.
6. `generateWorld()` performs the automatic placement; no competing layout algorithm was introduced.
7. Existing manual coordinates apply only to repositories inside the explicit selection. Unselected manual entries remain stored but no longer resurrect unrelated cities.
8. Existing manual controls remain visible after the reload.
9. When a token is configured, the mutation requires it even for same-origin requests; the client sends it through `bridgeHeaders()`.
10. Empty parents are non-actionable, malformed payloads return 400, and stale inspection responses cannot overwrite the latest path.

## Acceptance evidence

| Criterion | Result | Evidence |
|---|---|---|
| AC-1 Preview after inspection | Pass | Live preview returned parent + 52 children; UI screenshot shows card |
| AC-2 All eligible siblings | Pass | Handler tests; live scan excludes technical dirs and realpath escapes; 52-repo regression fixture |
| AC-3 One persistent mutation | Pass | Exclusive draft, one `saveState()`, then live-state swap |
| AC-4 Existing auto-layout reused | Pass | No new layout function; 52 selected repos create 52 unique coordinates |
| AC-5 Manual placement preserved | Pass | Manual button visible post-reload; matching coordinate test passes |
| AC-6 Replace rather than union | Pass | Previous-root selections are cleared and unselected manual repositories no longer enter world |
| AC-7 Honest failure | Pass | Empty eligible parent returns 422 without state change; UI shows no action; malformed payloads return 400 |
| AC-8 Browser path | Pass | Two focused Playwright paths pass on fresh Vite port 5283, including token header and stale-response protection |

## Visual findings

### P1

1. **Dense-map camera fit is not bounds-aware.** At zoom 0.72, left and right peripheral cities are clipped. The auto-layout is collision-free, but the camera does not guarantee every label and wall ring fits the initial viewport.
2. **HUD occlusion remains excessive.** Profile controls, activity panel, minimap, gaceta, and command strip conceal a large fraction of the playable map.
3. **City silhouette hierarchy is weak at medium/close range.** Wall towers and flagpoles dominate small internal buildings, making settlements read as empty fortifications.

### P2

1. Territory ribbons are too thick at close zoom and compete with city geometry.
2. Terrain texture exposes a rectangular/grid-like pattern stronger than the intended hex structure.
3. City labels overlap central landmarks and each other in dense views.
4. Biome greens lack enough value/hue separation.
5. Bibliotheca/LabHub labels can feel detached from their assets.
6. Doors, windows, chimneys, and other city-specific details are not legible enough at close zoom.

### P3

1. Repetition of wall/tower kits reduces city identity.
2. Trees and small scatter props are sparse around some settlements.
3. Coast/river transitions remain visually abrupt in places.

## Verification matrix

| Check | Result |
|---|---|
| `npm run lint` | Pass |
| `npm run format:check` | Pass |
| `npx tsc --noEmit` | Pass |
| `npm test` | 80 files, 836 tests passed |
| Full Python suite in `scripts/check.sh` | 837 passed, 1 skipped; 77.72% coverage |
| Build + eager bundle budget | Pass; 142 KB gzip, limit 185 KB |
| Terrain atlas budget | Pass; 5,288 KB, limit 6 MB |
| Prop GLB budget | Pass; 224 KB, limit 1.5 MB |
| Focused Playwright feature E2E | 2 passed on fresh Vite 5283 |
| Secret scan | Pass; no high-confidence credentials |
| Frontend security tests | 53 passed |
| Backend security tests | 123 passed, 1 skipped |
| `npm audit --audit-level=high` | Pass; 0 vulnerabilities |
| Live `scripts/healthcheck.sh` after restart | Pass; 6/6 |
| Live `scripts/smoke-test.sh` | 8/9; pre-existing DAVI capability registry mismatch |

### Canonical gate caveat

`scripts/check.sh` exits 1 only at `python -m pip_audit`. The command audits DAVI's global Conda environment rather than a RepoCiv dependency lock and reports 96 known vulnerabilities in 34 globally installed packages. This branch changes no Python or Node dependency manifest. Every security subgate after the global dependency audit was rerun manually and passed. The gate is therefore not green, but the red result is environmental/pre-existing rather than introduced by this feature.

## Limitations

- The actual user selection state was not replaced during screenshot generation. Mutation behavior is covered by handler integration tests and the isolated browser flow.
- A complete 52-city WebGL screenshot was not attempted against the user's real state. The renderer was exercised with 24 real cities; the 52-city selection/layout path is covered deterministically in unit tests.
- The visual P1/P2 findings are documented, not repaired in this feature branch. Mixing camera/HUD/asset redesign with folder selection would obscure review and rollback.
