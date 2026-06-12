# RepoCiv — Docker image for the full dashboard stack
#
# One image, one process supervisor. Runs:
#   - Python bridge on BRIDGE_PORT (default 5274) — HTTP API
#   - Python bridge on BRIDGE_WS_PORT (default 5275) — WebSocket events
#   - Vite dev server on VITE_PORT (default 5273) — frontend UI
#
# Browser connects to:
#   http://localhost:5273           (UI)
#   ws://localhost:5275             (events, direct, NOT via Vite proxy)
#
# The browser's "localhost" is the host. This container's "localhost" is itself.
# Both layers agree because all three servers live in the same container.
#
# Build:   docker build -t repociv:latest .
# Run:     docker run --rm -p 127.0.0.1:5273:5273 -p 127.0.0.1:5274:5274 -p 127.0.0.1:5275:5275 \
#              -v /path/to/your/repos:/workspace/repos:ro \
#              -e REPOCIV_MAP_ROOT=/workspace/repos \
#              repociv:latest
# Or:      docker compose up

FROM python:3.12-slim-bookworm

# Node 20 from Nodesource (Debian 12 ships Node 18 which is too old for Vite 6).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs git \
    && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version

WORKDIR /app

# ─── Python deps first (better layer cache) ──────────────────────────────────
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# ─── Node deps (separate layer) ──────────────────────────────────────────────
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

# ─── Application code ────────────────────────────────────────────────────────
COPY . .

# Expose: Vite UI, Bridge HTTP, Bridge WebSocket. Override via env in compose.
EXPOSE 5273 5274 5275

# Entrypoint script starts the bridge, waits for it, then runs Vite in foreground.
# Stop signal SIGTERM → both processes exit (entrypoint.sh traps and forwards).
RUN chmod +x docker/entrypoint.sh
ENTRYPOINT ["docker/entrypoint.sh"]

# Healthcheck: Vite serves index.html with 200 once it's up. The bridge usually
# is up before Vite, so a hit on Vite implies the whole stack is ready.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
    CMD curl -fsS http://localhost:${VITE_PORT:-5273}/ >/dev/null || exit 1
