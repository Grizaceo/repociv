# RepoCiv — Imperial Agent Dashboard

You are inside the **RepoCiv** repository, a Civilization V-style hexagonal dashboard.

**Where you are:** `/home/gris/.hermes/workspace/repos/repociv`
**What this is:** A single-user alpha dashboard for Cristóbal. It visualizes `~/.hermes/workspace/repos/` as cities, agents as units, and processes as buildings on a hex grid.
**Stack:** TypeScript + Vite (Canvas 2D frontend) · Python HTTP bridge (backend) · DuckDB ledger
**Owner:** Cristóbal & DAVI
**Version:** v0.1.0 alpha — scope frozen until dogfooding says otherwise.

Key files to know about:
- `README.md` — full overview, architecture, hotkeys
- `docs/SCOPE.md` — what is and isn't in scope (single-user alpha, no multi-tenant)
- `src/game.ts` — main GameState, agent spawning, mission loop
- `server/bridge.py` — HTTP bridge to Hermes/DAVI agents
- `CLAUDE.md` — gstack skill routing rules

When working here, do NOT assume you are in the Hermes upstream repo. You are in RepoCiv.
