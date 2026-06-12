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
  -p 127.0.0.1:5273:5273 \
  -p 127.0.0.1:5274:5274 \
  -p 127.0.0.1:5275:5275 \
  -v "$HOME/projects:/workspace/repos:ro" \
  -e REPOCIV_MAP_ROOT=/workspace/repos \
  -e WORKSPACE_ROOT=/workspace/repos \
  -e REPOCIV_REPOS_ROOT=/workspace/repos \
  repociv:latest
```

## Ports

Three ports are exposed on loopback by default. **All three are required** — the browser connects directly to the WebSocket on `5275` (the Vite proxy only covers `/bridge/*`, not the standalone WS port).

| Port | Service         | Why                          |
|------|-----------------|------------------------------|
| 5273 | Vite dev server | Hex map UI                   |
| 5274 | Bridge HTTP API | Used by Vite proxy `/bridge` |
| 5275 | Bridge WebSocket| Event stream from bridge     |

If any of these ports is taken on the host (e.g. a local RepoCiv already running), the safest path is to stop the local service first. Do **not** blindly remap only the host ports yet: the current frontend discovers WebSocket metadata as `ws://localhost:5275`, so a mapping like `8275:5275` would make the UI load while the event stream still dials the wrong host port.

If you need a remote or non-default-port setup today, use `REPOCIV_TOKEN` + `REPOCIV_REMOTE=true` and treat it as an advanced deployment; see `docs/REMOTE_ACCESS.md`.

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
| `REPOCIV_TOKEN`        | *(empty)*                | Empty = loopback-only dev mode in Docker. Set for remote access. |
| `REPOCIV_REMOTE`       | *(empty)*                | Set `true` + a token to expose beyond loopback |
| `BRIDGE_HOST`          | `0.0.0.0`                | Always bound to all interfaces inside the container |

The `MAP_ROOT` shell variable in your `.env` (or exported in the shell) controls which host folder is bind-mounted. The `environment:` block in `docker-compose.yml` then forwards it inside as `/workspace/repos`.

## What the container runs

The entrypoint script (`docker/entrypoint.sh`) starts the Python bridge in the background, polls `/health` until it answers, then runs Vite in the foreground. Both processes share the same container network, so:

- The browser's `http://localhost:5273` reaches Vite (loopback port-mapped)
- Vite's `/bridge` proxy reaches `localhost:5274` (the bridge, same container)
- The browser's `ws://localhost:5275` reaches the bridge's WebSocket server (loopback port-mapped)

No `network_mode: host` hack, no multi-service networking — one container, one image, three published ports.

## What you should see

- The banner from the entrypoint in `docker compose logs -f`
- `VITE v6.x  ready in …` from Vite
- `bridge healthy after 2s` (typically) from the entrypoint

If the healthcheck fails, run `docker inspect --format '{{json .State.Health}}' repociv` to see why. The healthcheck hits `http://localhost:5273/` and expects a 200.

## Caveats

- **Dev mode**, not production. Vite runs with HMR; the image is sized for a workstation, not a server.
- **The Vite dev server is bound to all interfaces** inside the container (because the entrypoint forces `--host 0.0.0.0`). This is safe in the default compose file because published ports bind to host loopback (`127.0.0.1`).
- **The bridge binds to `0.0.0.0` inside the container** as well, so the port mapping works. The default `127.0.0.1` of the dev bridge is overridden by the entrypoint setting `BRIDGE_HOST=0.0.0.0` in the environment; host exposure is still constrained by the loopback port bindings.
- **`.hermes`, `.gstack`, `.claude`, `.cursor`, `execplan/`, `data/`, `coverage/`, `*.log`** are excluded from the build context in `.dockerignore`. A fresh `docker build` ships a clean tree, even if your working copy is full of personal tooling.
- **The container is single-user by design.** Same scope as the local dev mode: it visualizes your repos folder; it does not serve multiple tenants.

## Troubleshooting

| Symptom                                              | Likely cause                                                      | Fix                                                                      |
|------------------------------------------------------|-------------------------------------------------------------------|--------------------------------------------------------------------------|
| `Address already in use` on host startup             | A local RepoCiv is bound to 5273/5274/5275                        | Stop the local services first; arbitrary WS port remaps are not yet supported |
| `bridge failed health check` after 30s               | Bridge crashed — check `docker logs repociv`                      | Common cause: missing system deps. Open an issue with the full log       |
| Map shows 0 cities                                   | `MAP_ROOT` is empty or the bind mount points to the wrong folder  | `docker exec repociv ls /workspace/repos` to verify                      |
| `WebSocket connection failed` in browser console     | Port 5275 not exposed on host loopback or remapped incorrectly    | Use the default `127.0.0.1:5275:5275` binding; non-default WS ports need code/config changes |
| `Bridge offline` status in the UI                    | Browser can't reach 5274 (Vite proxy target) or 5275 (events)     | Confirm both 5274 and 5275 are mapped; the UI needs both                 |
