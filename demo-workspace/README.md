# demo-workspace — seeded demo map (synthetic repos only)

This directory is the `MAP_ROOT` for judge demos. Every subdirectory becomes
a city on the RepoCiv hex map. **All seed repos here are synthetic** — small,
self-contained fixtures written for the demo; nothing is copied from any
private or production workspace.

| City | Contents | Demo story |
|---|---|---|
| `sentinel-flask/` | Tiny Flask API with a pagination bug | SCOUT spots it, PRAETORIAN root-causes it |
| `taskforge/` | Python module + a failing test (casing mismatch) | WORKER fixes the unit test |
| `pipeline-utils/` | Half-wired ingestion plumbing with TODOs | WORKER finishes the wiring |

## Running the demo

```bash
# 1. Put your key in .env (gitignored): NEBIUS_API_KEY=nk-...
# 2. Point the map at this workspace (absolute path) and flip the provider:
MAP_ROOT="$PWD/demo-workspace" \
REPOCIV_INFERENCE_PROVIDER=nebius \
docker compose up
# 3. Open the printed Vite URL, spawn a SCOUT on a city and watch the
#    tier ring + step log show real Nemotron calls (cost_usd > 0).
```

`.env.demo` documents the full variable set. Nothing in this folder contains
credentials, PII, or generated secrets.