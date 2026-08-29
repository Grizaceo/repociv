# Hackathon Update Log (Nebius × NVIDIA window: 2026-08-26 → 2026-10-30)

Format: one line per meaningful commit. This file ships in the submission
explaining what was built inside the window.

## 2026-08-29 (window opened 2026-08-26 — this commit COUNTS as in-window work)
- PRAETORIAN base unit added (924d086): third dispatch family SCOUT/WORKER/PRAETORIAN, tier-visible roster
- Hackathon update log created (3e25fd5): in-window tracking starts
- First-class Nebius Token Factory client (server/nebius_client.py) + tests (5): Tier cascade Nemotron Nano/Super/Ultra, cost+latency accounting. Gate 982 passed/2 skipped. Deviation note: _post_with_retries returns the response object (consumer calls raise_for_status()+json()) to match the plan's own test seam; plan's verbatim snippet returned resp.json() contradicting its test.
- Provider-aware tier mapping in signal_extractor (+2 tests): get_inference_provider(), provider_tier_mapping(), tier_to_model/tier_to_cascade_chain switch to Nemotron IDs when REPOCIV_INFERENCE_PROVIDER=nebius. Gate 984 passed/2 skipped.
- route_model provider integration tests (+3, A4): SCOUT resolves Nano under nebius, PRAETORIAN override wins, PREMIUM cascade stays single-element. Commit 666b636.
- Direct Nebius runner (A3): run_nebius_agent in agent_runner (module-level chat_nebius_cascade seam per plan's test, minor deviation from lazy-import note) + nebius-direct dispatch branch for SCOUT/WORKER/PRAETORIAN before subprocess-Hermes default; step_executor logs harness-bypass warning when provider=nebius. Gates: 988 passed/2 skipped + npm run check green.
- Cost/latency visible (A5): step_meta["inference_telemetry"] + record_event("inference_telemetry") per nebius-direct step (fresh-telemetry invariant: last_nebius_run cleared before each dispatch so a stale result is never attributed to another provider); tier ring on local units (1px/2px/4px+glow by tier, ring color = unit color) via tier propagation unit_spawn bridge event -> LocalUnit.tier. NOT TESTED live: real Nano call with cost>0 needs NEBIUS_API_KEY (declared, mocked tests cover shape).
- Dev-chore commit 3ddd852 (pre-sucios): viewport clamp + WSL WS proxy for Windows->WSL bridge, dashboard proxy default neutralized to 127.0.0.1 (Tailscale IP moved to .env HERMES_DASHBOARD_URL — red-team scrub by @cobalt).
- B1 compose/env plumbing: NEBIUS_API_KEY + REPOCIV_INFERENCE_PROVIDER added to docker-compose environment block (+.env.example with Stage-1 comments); YAML validated (no docker binary in this host; `docker compose config` pending a Docker-enabled run).
