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
# 1. Point the map at this workspace (absolute path) and bring it up:
MAP_ROOT="$PWD/demo-workspace" \
docker compose up
# 2. Open the printed Vite URL, spawn a SCOUT on a city and watch the
#    tier ring + step log show real local agent calls.
```

`.env.demo` documents the full variable set. Nothing in this folder contains
credentials, PII, or generated secrets.