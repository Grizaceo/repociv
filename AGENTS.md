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

## MCP Server

RepoCiv expone su bridge como un **MCP server por stdio** (`server/mcp_server.py`).
Esto permite que otras ventanas de Claude Code, Cursor o Codex CLI operen el dashboard como agentes externos.

- 32 tools cubriendo todos los dominios del bridge (agents, commands, approvals, pending, context, GPU, SICA, providers, tasks, directives, events)
- Tools `[MUTATES]` requieren `REPOCIV_TOKEN`; read-only no requieren token
- Los approvals del bridge **no se bypasean** — `command_submit` con `risk=high` cae en cola igual que desde la UI

Para conectar desde otra sesión de Claude Code, añadir en `~/.claude.json`:
```json
{
  "mcpServers": {
    "repociv": {
      "command": "python",
      "args": ["/home/gris/.hermes/workspace/repos/repociv/server/mcp_server.py"]
    }
  }
}
```

Documentación completa: `docs/MCP.md`.
