# RepoCiv vs AgentCraft: Honest Comparison

> This document compares RepoCiv (v0.1.0 alpha, May 2026) with AgentCraft
> (https://www.getagentcraft.com/), the most mature product in the spatial
> agent orchestration space.
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
| Your priority | User experience, onboarding, community | Policy control, routing intelligence, audit trail |
| Your budget | Free tier available, paid plans for teams | Free (MIT), self-hosted, zero cost |

---

## Feature-by-Feature Comparison

### Core Dashboard

| Feature | AgentCraft | RepoCiv | Notes |
|---------|------------|---------|-------|
| Map renderer | Three.js 3D | Canvas 2D | AgentCraft is visually richer. RepoCiv is deliberately 2D for readability. |
| Hex/tile grid | 3D hex map | 2D hex map (Civ V style) | Both use hex grids. Different visual depth. |
| City visualization | Buildings on 3D terrain | Flat hex tiles with labels | AgentCraft wins on visual impact. |
| Agent units | 3D hero models with skins | Colored circles with type icons | RepoCiv prioritizes readability over cosmetics. |
| Fog of war | Yes, with shader transitions | Yes, simple toggle (V key) | AgentCraft's version is more polished. |
| Minimap | Yes | Yes | Equivalent. |
| Camera controls | WASD + mouse | Mouse drag + scroll | AgentCraft's approach is more game-like. |

### Agent Integration

| Feature | AgentCraft | RepoCiv | Notes |
|---------|------------|---------|-------|
| Claude Code CLI | Native hooks (auto-detect) | Passive bridge + manual commands | AgentCraft wins hands down. |
| OpenCode CLI | Native hooks | Passive bridge | Same gap. |
| Cursor | Native hooks | Passive bridge | Same gap. |
| OpenClaw | Native hooks | Supported as a passive agent | Equivalent. |
| Custom agents | Via skill definitions | Agent Cards + Swarm Engine | RepoCiv has a more programmable model. |
| Multi-agent orchestration | Task delegation via missions | Swarm Engine + Consensus Engine | RepoCiv has dedicated orchestration primitives. |

### Backend Capabilities

| Feature | AgentCraft | RepoCiv | Notes |
|---------|------------|---------|-------|
| Policy engine | Not exposed | Granular capability model per agent | **RepoCiv unique.** |
| Priority scheduling | FIFO queues | Urgency-driven Priority Matrix | **RepoCiv unique.** Weighted scoring by age, tests, churn, extensions, size. |
| Fatigue system | Not present | XCOM-style linear fatigue with rest areas | **RepoCiv unique.** Agents tire from work. |
| Model router | Fixed model per session | FrugalGPT Router (cost-aware selection) | **RepoCiv unique.** Selects cheapest adequate model per task. |
| Auth model | Not documented | Token-based with rate limiting | RepoCiv is more transparent about its security model. |
| Audit trail | Not published | Append-only JSONL + DuckDB rebuildable ledger | **RepoCiv unique.** Immutable event store that survives crashes. |
| GPU monitoring | Not published | Real-time VRAM + temp via nvidia-smi | **RepoCiv unique.** Useful for ML workloads. |
| Tech debt scanner | Not published | Cross-repo debt detection with priority scoring | **RepoCiv unique.** |
| Reconciliation layer | Not present | Drift detection across event store, sessions, run state | **RepoCiv unique.** |

### Real-time Transport

| Feature | AgentCraft | RepoCiv | Notes |
|---------|------------|---------|-------|
| Transport | WebSocket (bidirectional) | SSE (server -> client only) | AgentCraft wins. WebSocket is better for approval flows and streaming. |
| Auto-reconnect | Yes | Yes (browser-native in SSE) | Both handle reconnection. |
| Fallback mechanism | Not documented | SSE maintained as primary, WebSocket on roadmap | RepoCiv is transparent about its migration path. |

### UX & UI

| Feature | AgentCraft | RepoCiv | Notes |
|---------|------------|---------|-------|
| Terminal integration | PTY multi-tab | xterm.js single tab | Both have terminal. AgentCraft's is more developed. |
| Plan review | Full-screen with diff highlights | Modal approval panel (Y/N) | AgentCraft is more polished. |
| Git diff viewer | Multi-session filtered diff | Not yet | AgentCraft wins. |
| Keyboard shortcuts | Not documented | 30+ hotkeys with ? overlay | RepoCiv is more keyboard-driven. |
| Dashboard panels | Agent-centric HUD | 21 panels (ledger, timeline, quest, priority, etc.) | RepoCiv has more raw panels but many are dogfooding experiments. |
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
| Installation | `npx @idosal/agentcraft` (one-liner) | Clone repo + npm install + venv + pip + 2 terminals | AgentCraft wins dramatically. One-liner vs ~10 steps. |
| Docker isolation | Per-agent containers | Per-agent containers (via Container Runtime) | Equivalent. |
| Systemd support | Not documented | Production systemd units included | RepoCiv is more ops-friendly for local servers. |
| Backup strategy | Not documented | Automated backup scripts included | RepoCiv has better disaster recovery tooling. |
| Remote access | Tunnels + PWA + push notifications | Via Tailscale (on roadmap) | AgentCraft wins for production teams. |
| Mobile | PWA installable | Not on roadmap | AgentCraft wins. |

---

## Where AgentCraft Wins (Unambiguously)

1. **Onboarding.** `npx @idosal/agentcraft` is the gold standard. RepoCiv
   requires 5+ manual steps. This is the single biggest gap.

2. **CLI integration.** AgentCraft hooks into Claude Code, OpenCode, and
   Cursor out of the box. RepoCiv requires manual bridge calls. If you
   want agents to appear on a map without configuration, AgentCraft is
   the choice.

3. **3D renderer.** Three.js 3D is more visually impressive than Canvas 2D.
   If the visual experience matters to you, AgentCraft looks better.

4. **Community features.** Achievements, skins, skill scrolls, and multiplayer
   are real features that make AgentCraft feel alive. RepoCiv deliberately
   avoids these.

5. **Remote production access.** AgentCraft has tunnels, PWA, and push
   notifications. RepoCiv only runs on localhost.

---

## Where RepoCiv Wins (Unambiguously)

1. **Programmable policy engine.** AgentCraft does not expose granular
   capability control. RepoCiv has a full capability model where each
   shipped agent type (and the user's MAIN slot, with its harness-driven
   capabilities) has defined permissions. You can define what each agent
   is allowed to do at a file-by-file level.

2. **Priority Matrix.** AgentCraft uses FIFO queues. RepoCiv scores every
   incoming task by age, test coverage, churn risk, file extension, and
   file size. This means the most urgent work always surfaces first.

3. **Fatigue System.** No other agent coordination tool models agent fatigue.
   RepoCiv's XCOM-style system prevents context saturation naturally:
   agents work, tire, walk to rest areas, recover, and resume. This is
   especially valuable for long-running agents that would otherwise
   accumulate context drift.

4. **Audit trail.** RepoCiv's append-only JSONL event store is an immutable
   audit log. If anything goes wrong, you can replay every event. The
   DuckDB ledger is rebuildable from the event store. AgentCraft does not
   publish comparable infrastructure.

5. **Cost optimization.** The FrugalGPT Router selects the cheapest model
   that can handle each task, not just the user's configured default.
   Over a week of daily use, this saves real money on API calls.

6. **Self-improvement.** SICA (Self-Improving Cognitive Architecture)
   observes usage patterns and generates proposals. Not automatic, not
   magic, but a genuine feedback loop that improves the system over time.

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
- You care about cost optimization across model providers
- You want to read and modify every line of the codebase
- You prefer honest alpha documentation over polished marketing

**Use both if:**
- You want AgentCraft for visual orchestration and RepoCiv for its policy
  engine and audit trail. The projects can complement each other: RepoCiv's
  bridge can feed events into AgentCraft's visualization if desired.

---

*This comparison was written in May 2026. Both projects evolve rapidly.
Check the latest documentation for current features.*
