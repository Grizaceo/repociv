# RepoCiv — Public Architecture

> A deep dive into how RepoCiv works: the hex map engine, bridge protocol,
> model router, agent cards, priority matrix, fatigue system, and how a
> mission travels from the hexagonal map to a real agent.

---

## Design Philosophy

RepoCiv is not AgentCraft. It is not a game. It is an **operational dashboard**
that uses spatial representation to make multi-agent coordination visible and
intuitive. The game metaphor is deliberate and functional:

- **Spatial reasoning over list-based UIs**: seeing agents as units walking
  between repo-cities is faster than scanning log files.
- **Game mechanics as system mechanics**: fatigue, priority, and resource
  constraints are mapped to game loops that the user already understands
  intuitively from playing Civilization V, XCOM, or RimWorld.
- **Dogfooding-driven**: every feature exists because its creator needed it.
  No features are designed for hypothetical users.

---

## Layer 1: Hex Map Engine (Frontend)

### Core Components

**src/hex.ts** — Axial coordinate system for a hexagonal grid. All positions
use cube coordinates (q, r) internally. Provides:
- Pixel-to-hex conversion for click detection
- Hex-to-pixel conversion for rendering
- Neighbor calculation (6 directions)
- Distance calculation (hex distance)

**src/map.ts** — World generation from workspace state. The workspace's
directory structure (`~/.hermes/workspace/repos/`) is mapped to tiles:
- Each repo in the root workspace becomes a **city** tile
- City tiles are positioned with a force-directed layout based on
  repo size and dependency graph
- Empty tiles get terrain types (plains, forest, mountain, water)
  determined by a seeded RNG for reproducible maps

**src/pathfinding.ts** — A* pathfinding with a per-unit-type cache. When a
unit is ordered to move, the path is computed once and cached. Cached paths
expire when the map topology changes (city added/removed). Maximum explored
nodes per path: 300 hexes.

**src/renderer.ts** — Canvas 2D rendering at 60 FPS target. Draws:
- Hex terrain tiles with color-coded terrain types
- City sprites (repo names + status badges)
- Unit sprites (colored circles with agent icons)
- Fog of war (configurable per agent type)
- Minimap in corner (compressed view of entire map)

### Macro / Local View (Space key)

RepoCiv has two spatial levels:

```
[MACRO VIEW]                           [LOCAL VIEW - RimWorld style]
~/.hermes/workspace/repos/          -> Grid hexagonal interior of a city
  +-- repo-1 (city)                    Workbenches = files/directories
  |    +-- src/                        Units = agents walking between them
  |    +-- tests/                      Mission = go from workbench A to B
  |    +-- ...
```

- **Macro**: the workspace-level hex map. Each tile is a repo.
- **Local**: press Space (or 3) on a selected city to zoom into its interior.
  Files become workbenches. Agents walk between them based on priority score.
  A* pathfinding works on the local grid too (src/localPathfinding.ts).

---

## Layer 2: Game State & Simulation (Frontend)

### Priority Matrix

The Priority Matrix decides which file or folder an agent should work on next.
It is urgency-driven, not FIFO:

```
score = (ageWeight * ageScore)
      + (testWeight * hasTests ? 1 : 0)
      + (debtWeight * churnRisk)
      + (extWeight * extensionScore)
      + (sizeWeight * sizeScore)
```

Default weights can be reconfigured at runtime through the Settings panel (P key).

| Label | Condition |
|-------|-----------|
| CRIT | score >= 70 |
| HIGH | score >= 50 |
| NORM | score >= 30 |
| LOW | score < 30 |

The urgency labels are exposed in the Priority Panel (P key toggle) and
influence which cities glow on the hex map.

### Fatigue System

Inspired by XCOM's stamina mechanic. Each agent has linear fatigue:

```
fatiguePercent = currentFatigue / maxFatigue   (0.0 -> 1.0)
effectiveSpeed = fatiguePercent                 (speed = energy ratio)
```

- Fatigue increases when the agent works (mission execution)
- Fatigue decreases when the agent rests in a Rest Area
- Rest Areas are tiles in the local view where agents recover
- Visual feedback: yellow bar at 60%, red bar at 30%
- Configurable thresholds via Settings panel

The model is deliberately simple: no magic thresholds, no hidden curves.
Fatigue does what it says.

### HUD & Panels

RepoCiv ships with 21 panels. The most actively used:

- **Hero Bar**: agent roster with status indicators (idle, working, resting)
- **Side Panel**: detailed agent info, mission history, logs
- **Priority Panel**: urgency scores per file with CRIT/HIGH/NORM/LOW labels
- **Approval Panel**: Y/N approval for commands requiring human sign-off
- **Terminal Panel**: xterm.js-based terminal inside the browser
- **Settings Panel**: runtime toggles for thresholds, display options
- **Ledger Panel**: read-only query view of the DuckDB analytics store
- **Quest Board**: active missions and their status
- **Timeline Panel**: chronological view of all events

Key shortcuts: Q/W/E/L/O to spawn agents, Space to cycle idle, P for
priority, F6-F11 for various panels, ? for full keyboard help.

---

## Layer 3: Bridge Protocol (Frontend <-> Backend)

### Transport

The bridge uses **HTTP + SSE (Server-Sent Events)**:

- Frontend sends commands and data via HTTP POST/PUT to the Python bridge
- The bridge pushes real-time events (agent status, mission progress, GPU
  stats) back to the frontend via a persistent SSE connection

Why SSE over WebSocket? SSE is simpler, works through HTTP proxies natively,
and has automatic reconnection built into every browser. WebSocket
bidirectional communication is on the roadmap.

### Protocol

All POST requests require an `X-RepoCiv-Token` header. In development mode
with no token configured, localhost requests bypass auth.

```json
// POST /commands
{
  "type": "mission_start",
  "target": "davi",
  "payload": {
    "repo": "protein-lab",
    "file": "src/model.py",
    "priority": "HIGH",
    "task": "review and optimize the attention mechanism"
  }
}
```

The bridge validates every event with valibot schema validation before
processing. Invalid events are rejected with a 400 status.

### Endpoints Summary

| Method | Path | Purpose |
|--------|------|---------|
| GET | /health | Liveness check |
| GET | /ready | Readiness + event store status |
| GET | /agents | Agent roster and queue depth |
| GET | /missions | Persisted mission history |
| GET | /pending | Pending items from tracker |
| GET | /tasks | Active orchestration tasks |
| GET | /approvals | Commands awaiting approval |
| POST | /commands | Submit new command |
| POST | /commands/:id/cancel | Cancel queued command |
| POST | /approvals/:id/approve | Approve pending command |
| POST | /approvals/:id/reject | Reject pending command |
| GET | /events | SSE event stream |
| GET | /gpu | GPU stats (VRAM, temp) |
| GET | /metrics | Computed metrics |
| GET | /context | Fatigue + rest area state |

---

## Layer 4: Agent OS Backend

### Tensor Context

A structured context packaging system that assembles the right information
for each agent before execution. It composes:
- Current workspace state (what repos exist, what changed)
- Agent-specific memory and skill definitions
- Mission scope and constraints
- Token budget awareness

### FrugalGPT Router

Model selection based on task complexity and remaining token budget:

1. A mission arrives with a complexity estimate
2. The router checks the token ledger for remaining budget
3. It selects the most cost-effective model that can handle the complexity
4. Falls back to cheaper models when budget is constrained

This prevents using expensive frontier models for trivial tasks and
guarantees the system stays within token budget.

### Swarm Engine

For missions that require multiple perspectives, the Swarm Engine:
1. Decomposes the task into subtasks
2. Assigns each subtask to the best-suited agent
3. Runs them in parallel where possible
4. Aggregates results back into a unified output

Supports consensus mode (multiple agents vote on the same question) and
parallel mode (each agent works on a different slice).

### Agent Cards

Every agent in RepoCiv has a typed definition:

```typescript
interface AgentCard {
  id: string;
  name: string;
  type: 'davi' | 'lexo' | 'worker' | 'scout' | 'openclaw';
  capabilities: string[];
  defaultModel: string;
  maxConcurrent: number;
  roles: string[];
}
```

Agent Cards define what each agent can do, which model it uses by default,
how many parallel tasks it handles, and what roles it fills in the swarm.

### SICA (Self-Improving Cognitive Architecture)

SICA observes usage patterns and generates proposals for improvement. It is
**read-only by design**: proposals are suggestions for the human operator to
review and apply manually. No automatic code modification.

- `GET /improve/reflect` — patterns observed in usage
- `GET /improve/proposals` — concrete, scoped improvement suggestions

### Persistence Layer

RepoCiv uses **4 stores**, each with a distinct purpose:

```
+-------------------------------------------------------------------+
| Event Store (events.jsonl)   | Append-only audit trail. Immutable. |
|                              | Source of truth for everything.     |
+-------------------------------------------------------------------+
| DuckDB Ledger (ledger.duckdb)| Analytical queries. Rebuildable     |
|                              | from Event Store. NOT source of     |
|                              | truth.                              |
+-------------------------------------------------------------------+
| Workspace Issues             | Per-issue state: spec, plan,        |
| (~/.repociv/issues/)         | artifacts, outputs. User-owned.     |
+-------------------------------------------------------------------+
| Sessions + RunState          | Active sessions + agent snapshots.  |
| (~/.repociv/sessions/)       | Volatile: purged on restart.        |
+-------------------------------------------------------------------+
```

**Key invariant:** The DuckDB Ledger can always be rebuilt from the Event
Store (`python -m server.rebuild_ledger`). Never the reverse.

---

## How a Mission Travels from Hex Map to Real Agent

```
FRONTEND                          BACKEND (Python)                  AGENT (Hermes/Docker)
--------                          ----------------                  --------------------

1. User clicks city
   on hex map
     |
2. Game engine creates
   mission object with
   target repo + scope
     |
3. Priority Matrix
   scores mission against
   current queue
     |
4. Bridge sends
   POST /commands
   ---------------->    5. Validate token + rate limit
                              |
                        6. Log to Event Store (events.jsonl)
                              |
                        7. FrugalGPT Router selects model
                              |
                        8. Tensor Context packages context
                              |
                        9. Security Harness gates operation
                              |
                        10. Swarm Engine dispatches
                              |
                         11. Executor calls agent
                              ------------------------>    12. Agent receives
                                                              mission context
                                                              |
                                                           13. Agent works
                                                              |
                        14. SSE streams progress <-----------  (streaming events)
                              |
15. Unit walks toward     <---  SSE event: unit_moved
    city on hex map
                              |
16. SSE: mission_done    <---  17. Result written to
                                 Event Store + DuckDB
                                 |
18. Unit arrives at city.
    Fatigue decreases.
    Priority Matrix re-ranks.
```

---

## RepoCiv vs AgentCraft: The Honest Take

RepoCiv is not a clone of AgentCraft. It started as a different project
(a personal workspace visualizer) and evolved into something that overlaps
with AgentCraft's space. Here is what makes RepoCiv different:

**RepoCiv is stronger at:**
- **Policy engine**: granular capability control per agent (DAVI > LEXO >
  WORKER > SCOUT permission hierarchy). AgentCraft does not expose this.
- **Priority Matrix**: urgency-driven scheduling vs FIFO queues.
- **Fatigue System**: agents that tire from work and need to rest.
  Prevents context saturation naturally.
- **Reconciliation layer**: detects drift between event store, sessions,
  and run state. No other tool publishes this.
- **Multi-model routing**: selects the cheapest adequate model per task,
  not just the user's configured default.
- **Offline-first audit**: append-only JSONL that survives crashes.
- **GPU monitoring**: VRAM and temperature dashboard for ML workloads.

**AgentCraft is stronger at:**
- **Onboarding**: `npx @idosal/agentcraft` vs cloning a repo + npm install +
  venv + pip install + two terminals.
- **3D renderer**: Three.js 3D map vs Canvas 2D.
- **WebSocket transport**: bidirectional real-time vs SSE one-way.
- **Remote access**: tunnels + PWA + push notifications.
- **CLI integration**: hooks into Claude Code, OpenCode, Cursor out of the box.
- **Multiplayer**: Alliance Hall for team coordination.
- **Community**: achievements, skins, skill scrolls, soundtracks.

**Bottom line:** RepoCiv's backend is more sophisticated in several
dimensions (policy, scheduling, routing, fatigue, audit). AgentCraft's
frontend, onboarding, and community features are more polished. Both
projects are actively evolving.

---

## Security Model (Public View)

- All POST endpoints require a bearer token (`X-RepoCiv-Token`)
- Rate limiting: 60 requests/minute per IP (in-memory, resets on restart)
- Body size limit: 128 KB per request
- CORS restricted to localhost origins
- SSE stream is read-only: exposes event data but does not accept commands
- Dev mode: leaving the token empty is allowed for localhost-only operation
- Production mode: 32+ character random token required
- Agent execution is sandboxed through Docker containers when available
- The Security Harness enforces 3-layer gating: gate (can it run?) -> audit
  (should it run?) -> runtime (is it behaving as expected?)
