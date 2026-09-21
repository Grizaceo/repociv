# RepoCiv — Scope (alpha)

> **One page. This is the rule.**
> If a new proposal does not fit what this document says, it does not enter
> the trunk. If it enters the trunk anyway, this document is stale and stops
> being the source of truth. Keeping it honest matters more than keeping it
> aspirational.

---

## What RepoCiv is today

A Civilization-V-style hexagonal dashboard that **a single-seat alpha user**
runs locally to coordinate their own agents over the repos in
`~/.hermes/workspace/repos/`. Shipped (built-in) agents are WORKER and
SCOUT; everything else is routed by harness (OPENCLAW, CLAUDE, CODEX,
CURSOR) or registered as the user's personal profile.

Under the game there is a real Agent OS (Tensor Context, 3-layer Security
Harness, task orchestrator with validation contracts and an independent
validator role, container runtime). FrugalGPT Router, World Model, SICA and
the Swarm Engine were retired by the pruning rounds (2026-08-10 and
2026-09-13, see §Pruning roadmap). Keeping this much "industrial"
infrastructure as a single user is **deliberate**: the alpha test exists
precisely to discover which of those layers earn their keep and which get
distilled or deleted afterwards.

Cloud inference is **opt-in and explicit**: with
`REPOCIV_INFERENCE_PROVIDER=nebius` the router resolves
Nano/Super/Ultra per tier (ECONOMICO/EQUILIBRIO/PREMIUM), the runner
dispatches directly to the Nebius Token Factory with a cascade, and
per-step cost/latency shows up in telemetry (`inference_telemetry`) and as
a tier ring on the unit. Without the variable, everything runs local as
always.

Version: **v2.2 — 2026-09-21: reconciled with the code (audited pruning) +
authorized Nebius integration. Frozen in scope except what is authorized
below.**

---

## Definition of "done" for this stage

> **Done = it works for the alpha user's daily workflow and feels better
> than not using it. NOT = feature-by-feature parity with AgentCraft or
> any other product.**

Concrete metrics to consider the alpha "successful":

- The alpha user opens RepoCiv ≥ 5 days per week spontaneously (no reminder).
- At least 3 of the 11 UI panels (after the 2026-08-10 pruning) get used
  regularly. The ones that do not are candidates for the next pruning round
  (see §"Pruning roadmap" below).
- The bridge keeps running as a systemd unit for ≥ 7 days without manual
  intervention.
- The inference telemetry (`inference_telemetry`) shows real per-step
  cost/latency when `REPOCIV_INFERENCE_PROVIDER=nebius` is active
  (verifiable once `NEBIUS_API_KEY` is available; see §In scope now).

---

## What is **in scope** now

- Improving what is **already** used (renderer, hex grid, fatigue, priority
  matrix, task orchestrator, security harness, container runtime).
- **XCOM fatigue (2026-08-10):** fatigue is now derived from **tokens
  consumed per agent** (`token_ledger.get_agent_fatigue`, 1h window, 200k
  token max) instead of a manually-fed state. The scheduler prioritizes
  fresh agents (multiplier 0.3–1.0, weight 15). An explicit manual
  `unit_fatigue_delta` still takes precedence.
- Closing bugs and technical debt that appear during dogfooding.
- Minor visual improvements (assets, animations, tooltips) that make the
  alpha test more pleasant — but without rewriting large layers.
- **F1 — active sessions and guided start (owner-authorized):** consolidate
  the already-duplicated entry points into a single HUD session dock and
  F8. Introduces no second scheduler and no new execution route.
  - The dock lists persistent own units and active external sessions;
    selecting an own unit keeps the unit panel and an external one opens
    F8 in read-only mode. External data has a single store/poll shared
    between the dock and F8.
  - F8 adds **New session**. The wizard requires: a registered profile, a
    city already on the map, and a non-empty mission. The city contributes
    only its `cityId`: the browser neither sends nor persists local paths.
  - **Canonical backend contract:** the submit is `POST /commands` with
    `type: "execute_agent"`, `target` and `payload.city` equal to the
    `cityId`, and `payload`
    `{unit, mission, agentType, harness, provider, model, profile}`.
    The bridge validates/policy-checks/enqueues the command and answers
    the `commandId`; the frontend creates the visual unit only after an
    `ok` response, and the final state arrives through the existing
    `mission_*` and `unit_*` events.
  - The unit id is client-generated and derives from the profile name; the
    bridge resolves the registered configuration by its base. The wizard
    cannot be used to run an external session or to invent a city.
- **Both renderers are official trunk.** Canvas 2D (`flat`) is the default
  and canonical mode; WebGL/Three.js (`webgl`) is opt-in via
  `?renderer=webgl` or hotkey `3`. Owner decision (2026-06): the official
  thing is not "2D or 3D" but **switching between both without friction**.
  The switching invariant is covered by a non-GPU test
  (`src/three/renderMode.test.ts`, persistence/migration state machine) and
  the informative e2e `e2e/render-mode-parity.spec.ts` (real boot, needs
  GPU). Three.js loads lazy: it never enters the eager bundle of the 2D
  mode (`vendor-three` chunk).
- **Provider-aware inference (Nebius Token Factory, authorized by the
  2026-08-29 hackathon plan):** with `REPOCIV_INFERENCE_PROVIDER=nebius`
  the router resolves Nano/Super/Ultra per tier (ECONOMICO/EQUILIBRIO/
  PREMIUM), the runner dispatches directly to the Token Factory with a
  cascade, and per-step cost/latency is visible in telemetry
  (`inference_telemetry`) and as a tier ring on the unit. Without the
  variable, everything works local as always. The real Nano call is still
  pending `NEBIUS_API_KEY` (NOT TESTED).
- Documenting what real usage teaches in `docs/implementation_plan.md` or
  a future `docs/DOGFOODING_NOTES.md`.

## What is **in scope, but on a parallel branch** (does not touch trunk)

> Parallel branch = does not affect the daily alpha test. It merges only
> when stable AND demonstrably valuable.

> **Note (2026-06):** `feat/3d-renderer` is **no longer** a parallel branch
> — the 3D render was merged to `main` and is official (see above). Canvas
> 2D stopped being the only canonical mode; the rule is now switching
> parity, not "2D-only until functional parity".

- **`feat/multi-device-mobile`** — the phone as a second client via PWA or
  a lightweight app. Useful because the alpha user will test from the
  phone, so it makes sense to start testing cross-device contact. Starts
  with: serve-over-Tailscale + a minimal (read-only) mobile client that
  connects to the local bridge.
- **`feat/eventos-binarios`** or any non-blocking transport optimization
  that does not affect the daily flow.

## What is **out of scope** (move to v3.0 or don't do it)

Inherited from `implementation_plan.md` §10 + adjustments for this stage:

- ❌ Multi-tenant / multi-user (more than one user operating the same dashboard)
- ❌ Alliance Hall / real-time multiplayer
- ❌ Race skins / achievements system
- ❌ Voice input / TTS
- ❌ P2P mesh networking (`AUDIT_DELTA_ADDENDUM.md` §B)
- ❌ eBPF / Linux Landlock / LD_PRELOAD (`AUDIT_DELTA_ADDENDUM.md` §A) —
  excellent for multi-tenant production, oversized for single-user
- ❌ Economic Survival Model with per-agent credits (`AUDIT_DELTA_ADDENDUM.md` §C)
- ❌ SICA with automatic apply (it stayed dormant, GET-only, then retired)
- ❌ Any new feature that does not answer to a pain observed during dogfooding

---

## Pruning roadmap (post-dogfooding)

After 4-8 weeks of real use, run this audit:

1. **Panel telemetry** — register which hotkeys get used and which panels
   get opened. Any panel with 0 invocations in 4 weeks → candidate for
   removal. *Implemented (plan A2/D3):* `src/ui/analytics.ts` logs
   `trackPanelOpen` / `trackHotkey`; `getPanelUsageReport()` (over the
   canonical `KNOWN_PANELS` list) sorts from least to most used and is
   shown in the **Capital Panel → "pruning candidates (0 = never opened)"**.

   **Pruning executed (2026-08-10):** removed **Replay, Observability,
   Timeline, Quest Board and Gran Libro (Ledger)** — panels with zero
   endpoint traffic in real telemetry (`~/.repociv/endpoint_usage.json`)
   and in the original suspect list. **Recovery was kept**: it is not a
   toggle panel but contextual (opens from Harness and from command
   failures to generate recovery plans). `KNOWN_PANELS` ended with 11
   entries. Panel telemetry stays active for the next pruning round.

2. **Bridge endpoint telemetry** — which routes the frontend calls.
   Dead endpoints → remove.

3. **Backend module audit** — evaluated 2026-09-13:
   - `self_improve.py` (SICA) and `swarm_engine.py` → **retired** (zero
     traffic: `/improve/proposals` had 1 historical call; the swarm debate
     was almost never activated).
   - `tensor_context.py` → **kept**: it is load-bearing (builds the agent
     mission context in `step_executor`), despite being on this list.
   - `world_model.py`, `frugal_router.py` → no longer existed.
   Methodology: if telemetry shows no measurable impact, the module moves
   to `experimental/` or gets deleted.

The goal of pruning is **not** shrinking for its own sake — it is lowering
the maintenance surface to what is actually used.

---

## Release policy

- **While alpha:** no tags, no release notes, everything goes to `main`.
- **When the alpha user uses it daily and prefers RepoCiv to not using
  it:** we cut `v0.2.0 alpha` and publish the repo. Not before.
- **Decent multi-device:** a necessary condition to consider `v1.0`.
- **Multi-user:** explicitly outside any roadmap for now.

---

## To come back to this document

- About to start a big feature? → re-read this SCOPE.
- Just accepted a PR/change that breaks the SCOPE? → update this SCOPE
  immediately. Do not live in the lie.
- Does the SCOPE start to feel aspirational and out of sync with the code?
  → the problem is not the code, the SCOPE needs an honest review.
- Just used RepoCiv and found friction or value? → log it in
  `docs/DOGFOODING_NOTES.md`. Real-usage learning feeds this SCOPE.

---

_ES mirror of `docs/SCOPE.md` (v2.2, 2026-09-21). If the two diverge, fix
both or the mirror lies._