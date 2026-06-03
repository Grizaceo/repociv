# RepoCiv — Public Roadmap

> What exists today (May 2026), what is being built next, and what is
> explicitly not in scope. This roadmap is honest, not aspirational:
> no dates, no promises. Just direction.

---

## Current Status: v0.1.0 alpha — May 2026

RepoCiv is a **single-user alpha**, actively dogfooded for daily
multi-agent research work. The project follows a
simple rule: **no feature ships unless its creator needed it first.**

### What is stable

These components are used daily and have passing test suites:

- Hex map engine (axial coordinates, camera pan/zoom, 60 FPS Canvas 2D)
- City rendering from workspace directory structure
- Agent unit spawning and visualizing (DAVI, LEXO, WORKER, SCOUT, OPENCLAW)
- A* pathfinding with per-unit-type caching (<=300 hexes explored)
- Priority Matrix (urgency-driven file scoring)
- Fatigue System (XCOM-style linear model with rest areas)
- Macro/Local view switching (workspace -> per-repo interior)
- HTTP bridge with token auth and rate limiting
- 4-store persistence (JSONL event store, DuckDB ledger, sessions, issues)
- GPU monitoring (VRAM + temperature via nvidia-smi)
- Tech debt scanner
- SSE real-time event streaming
- 21 UI panels (terminal, priority, approval, ledger, quest, timeline, etc.)
- Systemd integration for persistent operation
- Security Harness (3-layer: gate, audit, runtime)
- FrugalGPT Router (cost-aware model selection)
- Swarm Engine (parallel multi-agent execution)
- SICA self-improvement (read-only proposal generation)

### Test coverage

The test suite is split across frontend Vitest tests and backend pytest tests.
Run `npm test -- --run` and `python3 -m pytest server/ -q` for current counts.

---

## What Comes Next

### Short-term (current dogfooding cycle)

These are the pain points identified during daily use:

**1. WebSocket bidirectional transport**
SSE is one-way (server -> client). For approval flows, streaming agent
output, and real-time terminal, bidirectional WebSocket is needed.
The SSE fallback will be maintained for backward compatibility.

**2. Remote access via Tailscale**
The dashboard currently runs only on localhost. Serving it over Tailscale
with proper auth allows mobile and laptop access without exposing the
bridge to the public internet. Required for true daily use.

**3. Gran Biblioteca — The Agent Component Catalog**
A catalog of pre-built, domain-specific agent components (legal agent,
cybersecurity scanner, protein design assistant, financial analyst) with
standardized interfaces for plug-and-play reuse. Each component is a
self-contained skill that can be dropped into any agent stack.

**4. One-liner installer**
The current setup (clone + npm install + venv + pip + two terminals) is too
many steps. Target: `npx @repociv/cli` or `brew install repociv`.

### Medium-term (post-alpha stabilization)

**5. CLI integration hooks**
Native integration with Claude Code, OpenCode, and Cursor CLIs. RepoCiv
will detect installed CLIs and automatically visualize their activity
(no manual bridge calls).

**6. Local map polish**
The RimWorld-style interior view (files as workbenches, agents walking
between them) is functional but rough. Smoother animations, better
workbench labels, and drag-to-assign will make it more usable.

**7. Performance optimization for large workspaces**
Current cap: ~50 repos. For workspaces with 200+ repos, the hex map
engine needs quadtree spatial indexing and level-of-detail rendering.

**8. Cross-session memory**
Replaying past missions, seeing what agents did yesterday, and learning
from patterns across sessions. Currently the Event Store has this data
but the UI does not surface it well.

---

## What Is NOT in Scope

These are features that RepoCiv will not pursue in the foreseeable future.
Each has a reasoned explanation.

### Multiplayer / Alliance Hall

RepoCiv is a **single-user tool**. Adding shared maps, real-time
multiplayer, or team coordination would fundamentally change the
architecture from a personal dashboard to a team platform. That is what
AgentCraft and DevOps tools are for. RepoCiv stays focused on the
individual researcher or developer.

### 3D Renderer (Three.js / WebGL)

Canvas 2D is deliberately chosen over Three.js 3D. 3D adds complexity
(lighting, camera controls, asset pipeline) without adding information
density for an operational dashboard. The spatial metaphor works because
it is readable at a glance, not because it is immersive. A 3D renderer
branch exists (`feat/3d-renderer`) for experimentation, but it will
not replace the 2D renderer until it proves functional parity, not just
visual appeal.

### Achievements / Skins / Gamification

No race skins, no achievement trophies, no unlockable content. The game
metaphor is operational, not cosmetic. Adding gamification would dilute
the purpose of the dashboard: showing real system state.

### Soundtrack / Ambient Music

AgentCraft has an ambient soundtrack. RepoCiv does not. A soundtrack
would be nice to have but adds no functional value. If a user wants
music, they can play their own.

### Marketplace / Plugin Store

No centralized marketplace for selling or sharing plugins. If RepoCiv
gains a community, plugin sharing will happen through GitHub repos and
skill definitions, not through a store.

### Mobile PWA

Multi-device access is important (remote access via Tailscale is on the
short-term roadmap), but a full mobile PWA with touch controls is not.
RepoCiv is a desktop tool for a desktop workflow. Mobile access means
monitoring and quick approvals, not building the map on a phone.

---

## Philosophy

### Dogfooding-Driven Development

RepoCiv has a single user who is also its primary developer. Every
feature, every refactor, every new panel must pass this test:

> "Did the dogfooding workflow need this in the last 7 days of real work?"

If not, it does not go into trunk. This is not gatekeeping -- it is
survival. Without this rule, alpha projects accumulate shelfware
features that no one uses but everyone maintains.

### The Scope Freeze

The current feature set is **frozen** until the dogfooding cycle
produces enough evidence to justify unfreezing. Evidence means:

- Real usage data (which panels are actually opened)
- Measured friction (what interrupts the workflow)
- Genuine gaps (what RepoCiv cannot do that would improve daily work)

No evidence, no new features. Fix what exists, prune what is unused.

### Pruning is a Feature

The project maintains a pruning roadmap for post-dogfooding:
- Any panel with 0 invocations in 4 weeks -> candidate for deletion
- Any bridge endpoint never called -> remove
- Any backend module without measurable impact -> archive to `experimental/`

The goal is not to shrink the codebase. The goal is to maintain only
what provides value, and to have the courage to delete what does not.

---

## Versioning

| Version | Status | Meaning |
|---------|--------|---------|
| v0.1.0 alpha | Current | Single-user dogfooding. No API stability. Breaking changes daily. |
| v0.2.0 alpha | Next | After dogfooding cycle yields enough fixes. Still single-user. |
| v1.0 | Future | Multi-device access working. Installation is one command. |
| v2.0 | Future | Not planned. |

There are no release dates. The project advances when it is ready,
not when a calendar says so.

---

## How to Influence the Roadmap

RepoCiv is open source (MIT). The roadmap is driven by real usage:

- **Open an issue** describing a pain point in your workflow
- **Submit a PR** with a fix or improvement
- **Use it daily** and report what breaks or what is missing

The most convincing argument for a new feature is not a design document
-- it is a logged session where the user hit a wall and RepoCiv could
not help.
