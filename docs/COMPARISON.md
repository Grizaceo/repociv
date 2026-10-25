# RepoCiv vs AgentCraft: Honest Comparison

> This document compares RepoCiv (v0.1.0 alpha; RepoCiv column revised
> 2026-10-24) with AgentCraft
> (https://www.getagentcraft.com/), the most mature product in the spatial
> agent orchestration space.
>
> **Revision note.** The RepoCiv column is reconciled with the current code
> and [`SCOPE.md`](SCOPE.md). The AgentCraft column reflects what was public
> in May 2026 and was **not** re-verified in this pass; treat it as a dated
> baseline. Where RepoCiv retired a feature, it is marked as retired rather
> than quietly dropped from the table.
>
> **Purpose:** Help you decide which tool fits your needs. No FUD, no hype.
> Where AgentCraft wins, we say so. Where RepoCiv is unique, we explain why.

---

## TL;DR

| POV | Pick AgentCraft if... | Pick RepoCiv if... |
|-----|-----------------------|---------------------|
| You want | Production-ready, polished, team-ready | A deep, programmable backend you can hack on |
| Your stack | Multi-developer team, remote access needed | Single researcher/developer, local-first |
| Your style | Install and go, no configuration required | Read the code, modify the engine, build on top |
| Your priority | User experience, onboarding, community | Policy control, scheduling, audit trail |
| Your budget | Free tier available, paid plans for teams | Free (MIT), self-hosted, zero cost |

---

## Feature-by-Feature Comparison

### Core Dashboard

| Feature | AgentCraft | RepoCiv | Notes |
|---------|------------|---------|-------|
| Map renderer | Three.js 3D | Canvas 2D (default) + official WebGL/Three.js (`?renderer=webgl` or `3`) | Both RepoCiv renderers are official and hot-swappable; 3D loads lazily so the 2D bundle stays lean. AgentCraft is visually richer out of the box. |
| Hex/tile grid | 3D hex map | 2D and 3D hex maps | Both use hex grids. RepoCiv keeps the 2D map readable at low zoom and the 3D pass optional. |
| City visualization | Buildings on 3D terrain | City sprites (2D) / modular 3D settlements (WebGL) | AgentCraft wins on visual impact; RepoCiv now has a custom 3D identity family (Meshy GLBs) instead of generic primitives. |
| Agent units | 3D hero models with skins | 2D unit tokens / 3D role figurines (WebGL) | RepoCiv prioritizes readability in 2D and shows role-specific figurines in 3D. |
| Fog of war | Yes, with shader transitions | Yes, simple toggle (`V`) | AgentCraft's version is more polished. |
| Minimap | Yes | Yes | Equivalent. |
| Camera controls | WASD + mouse | Mouse drag + scroll (2D); `Q`/`E` orbit + middle-drag (3D) | AgentCraft's approach is more game-like. |

### Agent Integration

| Feature | AgentCraft | RepoCiv | Notes |
|---------|------------|---------|-------|
| Claude Code CLI | Native hooks (auto-detect) | Position hooks + process-owned live chat for sessions RepoCiv spawns; terminal sessions are observable only | Narrower than AgentCraft, but live chat exists where RepoCiv owns the process. |
| OpenCode CLI | Native hooks | Passive bridge + global position plugin + live-chat adapter (since 2026-10-15) | Closer to parity than before; still requires the bridge running. |
| Cursor | Native hooks | Passive bridge | Same gap. |
| OpenClaw | Native hooks | Supported as a passive agent | Equivalent. |
| Custom agents | Via skill definitions | Agent profiles + typed Agent Cards + per-agent capabilities | RepoCiv has a more programmable model. |
| Multi-agent orchestration | Task delegation via missions | Task orchestrator + priority matrix + mission queue (the Swarm Engine was retired 2026-09-13) | RepoCiv has orchestration primitives, but no debate/consensus layer anymore. |

### Backend Capabilities

| Feature | AgentCraft | RepoCiv | Notes |
|---------|------------|---------|-------|
| Policy engine | Not exposed | Granular capability model per agent | **RepoCiv unique.** |
| Priority scheduling | FIFO queues | Urgency-driven Priority Matrix | **RepoCiv unique.** Weighted scoring by age, tests, churn, extensions, size. |
| Fatigue system | Not present | Token-based fatigue (1 h window, 200 k-token cap) | **RepoCiv unique.** Derived from the token ledger; the scheduler prefers fresh agents instead of a manual status. |
| Model router | Fixed model per session | Per-step routing metadata in the task orchestrator (FrugalGPT-style tier + fallback chain + budget pressure) | **Advisory today, not enforced.** The router computes and records a tier and fallback chain per step, and retries escalate the chain; the selected model is not yet passed to the agent runner. It is not a standalone service. |
| Auth model | Not documented | Token-based with rate limiting | RepoCiv is more transparent about its security model. |
| Audit trail | Not published | Append-only JSONL + DuckDB rebuildable ledger | **RepoCiv unique.** Immutable event store that survives crashes. |
| Crash recovery | Not published | Durable dispatch intents, recoverable approvals, startup reconciliation of interrupted tasks | **RepoCiv unique.** A command is delivered once or left visibly unresolved for the operator. |
| GPU monitoring | Not published | Real-time VRAM + temp via nvidia-smi | **RepoCiv unique.** Useful for ML workloads. |
| Tech debt scanner | Not published | Debt flags in the priority matrix (TODO/FIXME/HACK comments or a `/debt/` path raise the score) | **RepoCiv unique.** Debt is visible where it affects scheduling. |
| Failure recovery | Not published | Structured recovery plan from harness/command failures (Recovery panel) | **RepoCiv unique.** Failures produce an actionable plan instead of a dead end. |

### Real-time Transport

| Feature | AgentCraft | RepoCiv | Notes |
|---------|------------|---------|-------|
| Transport | WebSocket (bidirectional) | WebSocket (bidirectional) + SSE event replay | RepoCiv's `/ws` carries live UI traffic; `/events` also supports `text/event-stream` replay/polling. |
| Auto-reconnect | Yes | Yes (WebSocket retry + browser-native SSE reconnect) | Both handle reconnection. |
| Fallback mechanism | Not documented | REST polling remains available for every live surface | RepoCiv keeps a non-streaming path for flaky clients. |

### UX & UI

| Feature | AgentCraft | RepoCiv | Notes |
|---------|------------|---------|-------|
| Terminal integration | PTY multi-tab | xterm.js single tab | Both have terminal. AgentCraft's is more developed. |
| Plan review | Full-screen with diff highlights | Modal approval panel (Y/N) | AgentCraft is more polished. |
| Git diff viewer | Multi-session filtered diff | Not yet | AgentCraft wins. |
| Keyboard shortcuts | Not documented | Keyboard-first HUD with documented hotkeys and a `?` help overlay | RepoCiv is more keyboard-driven. |
| Dashboard panels | Agent-centric HUD | 11 panels after the 2026-08-10 prune (approvals, harness, recovery, tasks, pending, log, priority, settings, construction, kanban, task-assign) | RepoCiv tracks panel usage and prunes what nobody opens; the panel count is deliberately shrinking, not growing. |
| Settings | Not documented | Runtime configurable from Settings panel | RepoCiv is more configurable. |

### Community & Social

| Feature | AgentCraft | RepoCiv | Notes |
|---------|------------|---------|-------|
| Multiplayer | Alliance Hall (team rooms) | Not in scope | AgentCraft wins. RepoCiv is single-user by design. |
| Achievements | Trophy system with tiers | Not in scope | AgentCraft has gamification; RepoCiv does not. |
| Skill scrolls | Collectibles that install skills | Not in scope | AgentCraft's collectible system is unique. |
| Race skins | 4 factions with art | Not in scope | AgentCraft is more game-like. |
| Soundtrack | Ambient togglable music | Not in scope | AgentCraft has it; RepoCiv considers it non-functional. |

### Deployment & Operations

| Feature | AgentCraft | RepoCiv | Notes |
|---------|------------|---------|-------|
| Installation | `npx @idosal/agentcraft` (one-liner) | Clone repo + npm install + venv + pip; one-command dev start (`scripts/dev-start.sh`) or a shipped systemd unit | AgentCraft wins dramatically. One-liner vs ~10 steps. |
| Docker isolation | Per-agent containers | Per-agent containers (via Container Runtime) | Equivalent. |
| Systemd support | Not documented | Production systemd unit included (`deploy/systemd/`) | RepoCiv is more ops-friendly for local servers. |
| Backup strategy | Not documented | Automated backup scripts included | RepoCiv has better disaster recovery tooling. |
| Remote access | Tunnels + PWA + push notifications | Tailscale guide included (`docs/REMOTE_ACCESS.md`); token-gated bridge | AgentCraft is more turnkey for teams; RepoCiv's path is documented for a single operator. |
| Mobile | PWA installable | Read-only mobile client in a parallel branch; not in the alpha | AgentCraft wins today. |

---

## Where AgentCraft Wins (Unambiguously)

1. **Onboarding.** `npx @idosal/agentcraft` is the gold standard. RepoCiv
   requires 5+ manual steps. This is the single biggest gap.

2. **CLI integration.** AgentCraft hooks into Claude Code, OpenCode, and
   Cursor out of the box. RepoCiv now ships position hooks and process-owned
   live chat, but only for sessions it can see or spawn, and the bridge must
   be running. If you want agents to appear on a map with zero configuration,
   AgentCraft is the choice.

3. **3D renderer.** Three.js 3D is more visually impressive than RepoCiv's
   default Canvas 2D view. RepoCiv ships an optional WebGL pass (`3`), but
   AgentCraft's 3D is still more polished out of the box.

4. **Community features.** Achievements, skins, skill scrolls, and multiplayer
   are real features that make AgentCraft feel alive. RepoCiv deliberately
   avoids these.

5. **Remote production access.** AgentCraft has tunnels, PWA, and push
   notifications. RepoCiv runs on localhost by default and documents a
   Tailscale path for one operator, but it has no PWA or push.

---

## Where RepoCiv Wins (Unambiguously)

1. **Programmable policy engine.** AgentCraft does not expose granular
   capability control. RepoCiv has a full capability model where each
   shipped agent type (and the user's MAIN slot, with its harness-driven
   capabilities) has defined permissions per command type, with a risk floor
   that sends high-risk or destructive commands to the approval queue.

2. **Priority Matrix.** AgentCraft uses FIFO queues. RepoCiv scores every
   incoming task by age, test coverage, churn risk, file extension, and
   file size. This means the most urgent work always surfaces first.

3. **Fatigue System.** No other agent coordination tool models agent fatigue.
   RepoCiv derives it from tokens consumed in the last hour (200 k cap) and
   the scheduler prefers fresh agents (0.3–1.0 multiplier). It is a real
   scheduling signal, not a hand-maintained status.

4. **Audit trail.** RepoCiv's append-only JSONL event store is an immutable
   audit log. If anything goes wrong, you can replay every event. The
   DuckDB ledger is rebuildable from the event store. AgentCraft does not
   publish comparable infrastructure.

5. **Durable execution and recovery.** Commands get durable dispatch intents,
   approvals are recovered across restarts without re-authorizing, and tasks
   left in flight are reconciled as `interrupted` instead of being silently
   replayed. On a step timeout, RepoCiv terminates the agent process it owns
   and records whether the stop was confirmed.

6. **MCP control plane.** RepoCiv exposes its bridge as a stdio MCP server
   (42 tools across 15 domains), so Claude Code, Cursor, Codex CLI or any
   MCP client can operate the dashboard. Mutating tools still require the
   bridge token and approvals are not bypassed.

7. **Transparency.** RepoCiv is MIT open source. Every line of code is
   readable and modifiable. The comparison you are reading now is an
   example: RepoCiv documents where it falls short because that is how
   open source should work.

---

## Summary: Which One Should You Use?

**Use AgentCraft if:**
- You want a polished, production-ready product
- You work in a team or need remote access
- You want one-command setup and instant gratification
- You value visual polish and community features
- You need native Claude Code / Cursor integration

**Use RepoCiv if:**
- You are a solo developer or researcher
- You want deep programmatic control over agent behavior
- You need an immutable audit trail for compliance or debugging
- You are building custom agent workflows with specific routing needs
- You want commands and approvals to survive crashes and restarts
- You want an MCP-operable control plane for external agents
- You want to read and modify every line of the codebase
- You prefer honest alpha documentation over polished marketing

**Use both if:**
- You want AgentCraft for visual orchestration and RepoCiv for its policy
  engine and audit trail. The projects can complement each other: RepoCiv's
  bridge can feed events into AgentCraft's visualization if desired.

---

*This comparison was written in May 2026. The RepoCiv column was reconciled
with the code and `SCOPE.md` on 2026-10-24; the AgentCraft column was not
re-verified on that date. Both projects evolve rapidly — check the latest
documentation for current features.*
