# DEVPOST_SUBMISSION — RepoCiv × Nebius Token Factory

> Submission assets for the Nebius × NVIDIA hackathon (deadline 2026-10-30).
> Lane: **Most Valuable Feedback** (primary). Repo + demo: local run.

---

## One-liner

RepoCiv is a Civilization-style local dashboard where your agent ecosystem
becomes a working city — and with Nebius Token Factory it becomes a real
**inference economy**: every agent step resolves to Nano/Super/Ultra by tier,
with cost and latency visible per unit, live.

## What it does (judge's 60 seconds)

1. **Your repos are a living map.** Each repo is a hex city; your agents walk
   it as units (WORKER, SCOUT, HEROES).
2. **Missions run through the command pipeline** (validation contract →
   orchestrator → step executor) with approvals, fatigue from a real token
   ledger, and a 3-layer security harness.
3. **Nebius Token Factory is the inference brain (opt-in).** Set
   `REPOCIV_INFERENCE_PROVIDER=nebius` + `NEBIUS_API_KEY` and the router
   picks the model per tier: Nano for cheap steps (ECONOMICO), Super for the
   balanced tier (EQUILIBRIO), Ultra when quality matters (PREMIUM) — with
   an automatic cascade when a tier fails. Per-step cost/latency lands in
   `inference_telemetry` and shows as a tier ring on the unit.
4. **Everything stays honest:** without the env vars, the exact same loop
   runs on local harnesses (Hermes/Claude/Codex/OpenClaw). No cloud is ever
   required.

## Why Nebius Token Factory matters here

- **Cost visibility as a game mechanic.** A dashboard where you SEE what each
  agent step costs (credits + latency) turns inference spend into a playable
  economy — the tier ring is not decoration, it is the ledger.
- **Cascade resilience.** The runner falls back Nano→Super→Ultra within a
  tier's failure, so a mission never dies because one model hiccupped.
- **Local-first philosophy preserved.** Token Factory is a pluggable
  provider, not a migration: the alpha's daily loop keeps running local.

## What we learned using Token Factory (lane feedback)

> To be filled after the first real API calls (planned this week, with
> NEBIUS_API_KEY). Honest, specific, and dated — no invented metrics.

Planned observations to capture here:

- Latency profile of Nano vs Super on short structured steps (the kind the
  orchestrator issues most).
- Cascade behavior in practice: how often the fallback fired, and why.
- Anything surprising about the API shape (request/response ergonomics,
  error messages, rate limits) written from real use.

## How to run (3 commands)

```bash
git clone <repo-url> && cd repociv
docker compose up          # Option A (recommended)
# — or local: see README.en.md Quick Start Option B
# then open http://localhost:5273
```

To enable the Nebius integration (the hackathon core):

```bash
echo 'REPOCIV_INFERENCE_PROVIDER=nebius' >> .env
echo 'NEBIUS_API_KEY=<your key>' >> .env
```

## What is NOT in this submission (scope honesty)

- No public hosted demo — RepoCiv runs locally by design (your repos, your
  machine). Judges run it with the 3 commands above; `docs/SCOPE.en.md`
  documents the scope boundary and why.
- Multi-user/multi-tenant is explicitly out of scope (see SCOPE.en.md).
- The Nebius integration is code-complete and unit-tested (988 backend
  tests passing) but **not yet exercised against the live API** — first
  real call pending this week. This line will be updated when it happens.

## Submission checklist

- [x] Update log with the full window (86/86 commits traceable)
- [x] English judge-facing docs (README.en.md + docs/SCOPE.en.md)
- [x] Measured UI pruning (C2: surface-only, telemetry-driven)
- [ ] First real Nano call recorded (needs NEBIUS_API_KEY)
- [ ] Video ≤ 3 min (terminal-to-video pipeline, screen-recording of the
      dashboard running a Nebius-backed mission)
- [ ] Final review pass against the official submission checklist

## Assets

- Video: `MEDIA/submission-video.mp4` (≤3 min, 1080p) — pending
- Screenshots: map view with tier rings + F8 agents panel + telemetry panel
- Update log: `docs/plans/hackathon-update-log.md`
- Scope: `docs/SCOPE.en.md`