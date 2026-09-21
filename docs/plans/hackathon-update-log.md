# Hackathon Update Log (Nebius × NVIDIA window: 2026-08-26 → 2026-10-30)

Format: one line per meaningful commit. This file ships in the submission
explaining what was built inside the window.

## 2026-08-29 (window opened 2026-08-26 — this commit COUNTS as in-window work)
- PRAETORIAN base unit added (924d086): third dispatch family SCOUT/WORKER/PRAETORIAN, tier-visible roster
- Hackathon update log created (3e25fd5): in-window tracking starts
- First-class Nebius Token Factory client (server/nebius_client.py) + tests (5): Tier cascade Nemotron Nano/Super/Ultra, cost+latency accounting. Gate 982 passed/2 skipped. Deviation note: _post_with_retries returns the response object (consumer calls raise_for_status()+json()) to match the plan's own test seam; plan's verbatim snippet returned resp.json() contradicting its test. (128067c)
- Provider-aware tier mapping in signal_extractor (+2 tests): get_inference_provider(), provider_tier_mapping(), tier_to_model/tier_to_cascade_chain switch to Nemotron IDs when REPOCIV_INFERENCE_PROVIDER=nebius. Gate 984 passed/2 skipped. (4ff538f)
- route_model provider integration tests (+3, A4): SCOUT resolves Nano under nebius, PRAETORIAN override wins, PREMIUM cascade stays single-element. Commit 666b636.
- Direct Nebius runner (A3): run_nebius_agent in agent_runner (module-level chat_nebius_cascade seam per plan's test, minor deviation from lazy-import note) + nebius-direct dispatch branch for SCOUT/WORKER/PRAETORIAN before subprocess-Hermes default; step_executor logs harness-bypass warning when provider=nebius. Gates: 988 passed/2 skipped + npm run check green. (9360970)
- Cost/latency visible (A5): step_meta["inference_telemetry"] + record_event("inference_telemetry") per nebius-direct step (fresh-telemetry invariant: last_nebius_run cleared before each dispatch so a stale result is never attributed to another provider); tier ring on local units (1px/2px/4px+glow by tier, ring color = unit color) via tier propagation unit_spawn bridge event -> LocalUnit.tier. NOT TESTED live: real Nano call with cost>0 needs NEBIUS_API_KEY (declared, mocked tests cover shape). (8e89ba9)
- Dev-chore commit 3ddd852 (pre-sucios): viewport clamp + WSL WS proxy for Windows->WSL bridge, dashboard proxy default neutralized to 127.0.0.1 (Tailscale IP moved to .env HERMES_DASHBOARD_URL — red-team scrub by @cobalt).
- B1 compose/env plumbing: NEBIUS_API_KEY + REPOCIV_INFERENCE_PROVIDER added to docker-compose environment block (+.env.example with Stage-1 comments); YAML validated (no docker binary in this host; `docker compose config` pending a Docker-enabled run). (3398e69)
- B3 synthetic demo-workspace committed (255f416): 3 fixture cities (sentinel-flask w/ pagination bug, taskforge w/ 1 failing casing test verified 1F2P, pipeline-utils w/ unwired flush TODO); zero copies of real workspace repos per red-team condition; README documents MAP_ROOT/provider=nebius demo run. NOT TESTED: `docker compose up` with live Nano calls (needs Docker host + NEBIUS_API_KEY).

## 2026-08-29 (late entries, for completeness)
- Nebius competition readiness plan committed (e2431af): Track 1, Stages A–E, falsification gate per stage.
- Update-log cross-reference line (09167de).

## 2026-09-07 — security hardening + wonders reset + local-3D revival (13 commits)
- WebSocket security sweep: reject foreign origins (37084f5), authenticate the direct WS transport (b0c2475); the vite plugin drops shell-string execution (750a7c7).
- Gates tightened: ruff clean on server/ + scripts/ (c59e6be); prettier applied to the gate-checked sources (a858fc7); coverage excludes reconciled with the gate's stated category (e6c3d2a).
- Wonders reset: retire Bibliotheca and LabHub (b58395f) — neither earned its keep; the generic manifest/iframe wonder stays. Connect path restored so any open wonder receives live context pushes (40e47d8).
- Map/local-view legibility: hex grid, palette, labels, minimap (4726f24); the local sector gets its own mount + art direction (a64455d); the 3D sector renderer was found dead three ways and revived behind a flag (36478d2).
- HUD: agent bar rebuilt as chips with honest numbering (be4d93c); the pet draws one frame instead of the whole spritesheet (3907bdf).

## 2026-09-12 — supply chain + providers + mypy (7)
- Dependencies/security: 4 high npm vulns cleared via overrides + valibot 1.5.0 (c297b14); mcp floor raised to >=1.28.1,<2 (PYSEC) with lock regen (3f0e0c7); shell=True removed from the last two subprocess call sites (f36ed85).
- Providers: expanduser on HERMES_ROOT so ~/.hermes/config.yaml actually resolves (4a809a9); dict-shaped models: handled + parity tests de-flaked (6f8f279).
- Gradual mypy enabled on server/ — it caught a real bug on day one (1005d1a).
- HUD: F7/F9/F10 wired; the keyboard help now tells the truth (e465f08).

## 2026-09-13 — pruning + onboarding (4)
- Breaking prune: retire SICA (self_improve) and the Swarm Engine (0118f7e) — speculative machinery out, core loop in.
- Onboarding: default-harness routed to the bridge; the Vite plugin stops 404-ing unmatched /api (d83b1c2); healthcheck degrades gracefully on a missing binary; review messaging clarified (b4cc1be).
- Dogfooding doc: QA pass over the 4 core affordances, all working (f217c78).

## 2026-09-16 (1)
- Agentic-OS: DORMANT event-bus plugin + integration plan (511a575) — dormant by design, no runtime surface yet.

## 2026-09-17 → 2026-09-18 — the city gets real art (5)
- Hygiene after the Omarchy migration: WSL-era /home/gris/ paths purged (a3f557c).
- KayKit CC0 city clusters: multi-building textured recipes (4657c53) + golden screenshots (78439f6).
- KayKit modular wall kit: straight/gate/towers replace the procedural ring (c26f497) + goldens (7ca3f6f).

## 2026-09-19 — external agents (Suvadu + Hermes), GhostDesk, desktop launcher (31)
- Suvadu bridge: external agent sessions become ext-* map units (1003df7), placed by city and rehydrated on connect (2367806); docs cover setup, mapping rules, privacy, limits (65a4164).
- Wonder proxy: same-origin /wonder-proxy/<id>/ for iframe wonders (725145e); GhostDesk documented as a wonder — install, proxy, security posture, MCP, models (47c0cc7); wonder launcher tests isolated from the user's real wonders dir (8caf4e0).
- Agents panel (F8): every agent, its chat, and where it works (c55e799) + docs incl. the chat privacy boundary (d9a1e26); recent external sessions + on-demand chat from the tracker (649eabf).
- Hermes as a second external-agents source: bridge (37ab808), F8 UI (786a977), docs (fb49e64).
- Talking to external sessions, honestly scoped: one-turn reply, not a live chat (9409b7a); ⏎ Retomar resumes the session in your own terminal (3561dde); "pensando…" = alive but quiet (e64ffab); the remaining gap — writing INTO an active session — is documented as open (9c721b8).
- Bot fixes: ➕ Bot units get avatar/chat through their profile (5d24656); explicit Claude session ids + tracker skips RepoCiv's own sessions (d75cc0f); the Assembly (Bot Mode room, F7) is removed (d893973); smoke test checks MAIN instead of the removed DAVI card (2c98839); the office-atlas manifest is bundled from src/ (2c86a13).
- Tests/HMR: roster contract tests made hermetic (8d0effe); the .hermes watch-ignore anchored to the repo restores HMR (ed0a39f).
- Desktop launcher script: boots the stack and opens the window (c95da0a); sprint plan prompt for redoing the agents bar (9829006) — became the 09-19→09-21 HUD/sessions sprint.
- 3D wrap-up: procedural city fallback retired once KayKit loads (3f04edf); synthetic golden world + regenerated goldens (155ddb1).
- Merges: #24 feat/suvadu-ghostdesk (f78129b), #25 feat/hermes-live-agents (2aec080), #26 feat/3d-kaykit-city-assets (71094fa, incl. 97e665f).

## 2026-09-20 — F8 becomes the session launcher (3)
- Intentional F8 session start (f852644) promoted to the canonical launcher (5f29c70); alta recovery when the bridge fails (2449ed9).

## 2026-09-21 — session-primary model + wonders dead-code audit + green gate (10)
- HUD windows become movable/resizable (fb485c7); F8 becomes the ONLY agents view — the bottom agent bar is gone (c2c7214); an accepted session opens its chat immediately (82664c6).
- Session-primary persistence: own sessions re-materialize after a page reload (9be47cd); removing your own session = closing it, as an explicit action (fcd8a91).
- Test hermeticity: city_for_cwd isolated from the host filesystem (852bfa7).
- Wonders dead-code audit (cddda28): grep-first, per the refactor plan — postMessageBridge proved ALIVE in both directions (it powers generic wonders), so instead of the documented "retire the module", only the 3 orphan inbound messages (ready/report/notification) were dropped and the type union narrowed. Deviation note: the todo's premise was stale; the code won.
- Gate hygiene: mechanical Prettier pass over src/ (206132f); check.sh resolves the project pytest (.venv first, PATH fallback for CI), fixing a false coverage failure on dev hosts (090dd5a) — full scripts/check.sh green end-to-end.
- Docs reconciled against code (b33d82c): of 6 "real debts" in the implementation plan, 4 verified already implemented (validation-contract gate, independent validator role, typed handoff v1.0, per-step model routing); the Imperial Workshop roadmap marked historic; removed-product phases annotated with their removal SHAs.

## Window status (2026-09-21)
- 86 commits inside the window to date: the 10 entries from 08-29 above, plus 76 covered here (74 from 09-07→09-21, 2 late 08-29 entries).
- Gates at HEAD: vitest 1004/1004 · pytest 1156 passed / 2 skipped (coverage 81% ≥ 50% gate) · eslint 0-warn · tsc clean · full scripts/check.sh green.
- Still open in this window: Stages C/D/E of the readiness plan (EN docs + scope honesty, external demo + evidence, Devpost assets); the two NOT TESTED live checks (real Nano call with NEBIUS_API_KEY, docker compose up).
