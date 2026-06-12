# RepoCiv — Docker

RepoCiv ships a single image that runs the **full dashboard stack** in one container: the Python bridge (HTTP + WebSocket) and the Vite dev server. The image is built from the `Dockerfile` at the repo root and orchestrated by `docker-compose.yml`.

> The previous image, `Dockerfile.agent`, is unrelated to the dashboard — it sandboxes WORKER missions when `REPOCIV_AGENT_CONTAINER=1` is enabled in the bridge. Both can coexist.

## Quick start

```bash
git clone https://github.com/Grizaceo/repociv.git
cd repociv

# Point MAP_ROOT at the folder whose subdirectories you want as cities.
# Default: $HOME/.hermes/workspace/repos
export MAP_ROOT="$HOME/projects"

docker compose up --build
# Wait for the banner:
#   ┌──────────────────────────────────────────────────────────────┐
#   │  RepoCiv — Docker stack (bridge + Vite)                      │
#   └──────────────────────────────────────────────────────────────┘
#     Bridge HTTP:    http://localhost:5274
#     Bridge WS:      ws://localhost:5275
#     Vite (UI):      http://localhost:5273
```

Open `http://localhost:5273` in your browser. The hex map should render the subdirectories of `MAP_ROOT` as cities.

### Without docker compose

```bash
docker build -t repociv:latest .

docker run --rm \
  -p 5273:5273 -p 5274:5274 -p 5275:5275 \
  -v "$HOME/projects:/workspace/repos:ro" \
  -e REPOCIV_MAP_ROOT=/workspace/repos \
  -e WORKSPACE_ROOT=/workspace/repos \
  -e REPOCIV_REPOS_ROOT=/workspace/repos \
  repociv:latest
```

## Ports

Three ports are exposed. **All three are required** — the browser connects directly to the WebSocket on `5275` (the Vite proxy only covers `/bridge/*`, not the standalone WS port).

| Port | Service         | Why                          |
|------|-----------------|------------------------------|
| 5273 | Vite dev server | Hex map UI                   |
| 5274 | Bridge HTTP API | Used by Vite proxy `/bridge` |
| 5275 | Bridge WebSocket| Event stream from bridge     |

If any of these ports is taken on the host (e.g. a local RepoCiv already running), change them on the `docker run` line:

```bash
docker run --rm \
  -p 8273:5273 -p 8274:5274 -p 8275:5275 \
  -v "$HOME/projects:/workspace/repos:ro" \
  repociv:latest
```

…then open `http://localhost:8273`.

## Environment variables

The compose file sets sensible defaults. Override any of them in the `environment:` block of `docker-compose.yml` or with `-e` on `docker run`.

| Variable               | Default                  | Notes                                         |
|------------------------|--------------------------|-----------------------------------------------|
| `REPOCIV_MAP_ROOT`     | `/workspace/repos`       | Must match the bind mount target              |
| `WORKSPACE_ROOT`       | `/workspace/repos`       | Fallback alias                                |
| `REPOCIV_REPOS_ROOT`   | `/workspace/repos`       | Second fallback                               |
| `VITE_PORT`            | `5273`                   | Frontend dev server port                      |
| `BRIDGE_PORT`          | `5274`                   | Bridge HTTP API port                          |
| `BRIDGE_WS_PORT`       | `5275`                   | Bridge WebSocket port                         |
| `REPOCIV_TOKEN`        | *(empty)*                | Empty = localhost-only dev mode. See SECURITY. |
| `REPOCIV_REMOTE`       | *(empty)*                | Set `true` + a token to expose beyond loopback |
| `BRIDGE_HOST`          | `0.0.0.0`                | Always bound to all interfaces inside the container |

The `MAP_ROOT` shell variable in your `.env` (or exported in the shell) controls which host folder is bind-mounted. The `environment:` block in `docker-compose.yml` then forwards it inside as `/workspace/repos`.

## What the container runs

The entrypoint script (`docker/entrypoint.sh`) starts the Python bridge in the background, polls `/health` until it answers, then runs Vite in the foreground. Both processes share the same container network, so:

- The browser's `http://localhost:5273` reaches Vite (port-mapped)
- Vite's `/bridge` proxy reaches `localhost:5274` (the bridge, same container)
- The browser's `ws://localhost:5275` reaches the bridge's WebSocket server (port-mapped)

No `network_mode: host` hack, no multi-service networking — one container, one image, three published ports.

## What you should see

- The banner from the entrypoint in `docker compose logs -f`
- `VITE v6.x  ready in …` from Vite
- `bridge healthy after 2s` (typically) from the entrypoint

If the healthcheck fails, run `docker inspect --format '{{json .State.Health}}' repociv` to see why. The healthcheck hits `http://localhost:5273/` and expects a 200.

## Caveats

- **Dev mode**, not production. Vite runs with HMR; the image is sized for a workstation, not a server.
- **The Vite dev server is bound to all interfaces** inside the container (because the entrypoint forces `--host 0.0.0.0`). This is safe because the only path in is via the published ports.
- **The bridge binds to `0.0.0.0` inside the container** as well, so the port mapping works. The default `127.0.0.1` of the dev bridge is overridden by the entrypoint setting `BRIDGE_HOST=0.0.0.0` in the environment.
- **`.hermes`, `.gstack`, `.claude`, `.cursor`, `execplan/`, `data/`, `coverage/`, `*.log`** are excluded from the build context in `.dockerignore`. A fresh `docker build` ships a clean tree, even if your working copy is full of personal tooling.
- **The container is single-user by design.** Same scope as the local dev mode: it visualizes your repos folder; it does not serve multiple tenants.

## Troubleshooting

| Symptom                                              | Likely cause                                                      | Fix                                                                      |
|------------------------------------------------------|-------------------------------------------------------------------|--------------------------------------------------------------------------|
| `Address already in use` on host startup             | A local RepoCiv is bound to 5273/5274/5275                        | Stop the local services or remap the container ports (see above)         |
| `bridge failed health check` after 30s               | Bridge crashed — check `docker logs repociv`                      | Common cause: missing system deps. Open an issue with the full log       |
| Map shows 0 cities                                   | `MAP_ROOT` is empty or the bind mount points to the wrong folder  | `docker exec repociv ls /workspace/repos` to verify                      |
| `WebSocket connection failed` in browser console     | Port 5275 not exposed on the host                                 | Re-run with `-p 5275:5275` (compose already does this by default)        |
| `Bridge offline` status in the UI                    | Browser can't reach 5274 (Vite proxy target) or 5275 (events)     | Confirm both 5274 and 5275 are mapped; the UI needs both                 |
