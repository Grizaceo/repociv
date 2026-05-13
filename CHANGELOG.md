# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Orchestrator stall detection** — warnings and empty output detection in the agent runner.
- **Workspace safety invariants** — Symphony §9.5 extraction for secure agent boundaries.
- **Agent auto-discovery implementation plan** — docs/plans for agent self-discovery roadmap.
- **Spatial awareness (Phase 6)** — gizmo menu, git status per file, and aesthetic polish in local view.
- **City drag-and-drop relocation** — move cities on the map with visual feedback and lifecycle completion.
- **Log panel collapsibility** — log panel no longer blocks the chat panel.

### Fixed

- Cap `max_tokens` at 4096 in Hermes payload to avoid oversized requests.
- Wire harness param through `run_agent` wrapper with cascade model pass-through.
- Complete city relocate lifecycle (panel state, cursor reset, success toast).
- Remove unused `updateManualRepoCoord` import from construction panel.

### Tests

- Cover `canRelocateCityTo` and `relocateCity` with unit tests.

## [0.1.0] — 2025-04-30

### Added

- Initial release: Imperial Agent Dashboard.
- Hexagonal map rendering (Canvas 2D, 60 FPS).
- Python HTTP bridge for agent orchestration.
- Priority Matrix for file/carpeta scoring.
- Fatigue system and A* pathfinding.
- 314 frontend unit tests (Vitest) + 544 backend tests (pytest).

[unreleased]: https://github.com/cristobal/repociv/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/cristobal/repociv/releases/tag/v0.1.0
