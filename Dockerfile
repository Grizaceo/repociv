# ─── RepoCiv — Multi-stage container image ────────────────────────────────────
#
# Stages:
#   js-builder  — builds the Vite frontend (produces dist/)
#   bridge      — production Python backend (used by docker-compose)
#   static      — Nginx serving the built frontend (used by docker-compose)
#   dev         — legacy single-container dev image (kept for quick local runs)
#
# Quick dev run (both services in one container):
#   docker build --target dev -t repociv-dev .
#   docker run -p 5273:5273 -p 5274:5274 repociv-dev
#
# Production (recommended via docker-compose):
#   docker compose up --build

# ═══════════════════════════════════════════════════════════════════════════════
# Stage 1 — Build frontend
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:20-slim AS js-builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --prefer-offline

COPY . .
RUN npm run build   # outputs to dist/

# ═══════════════════════════════════════════════════════════════════════════════
# Stage 2 — Python bridge (production backend)
# ═══════════════════════════════════════════════════════════════════════════════
FROM python:3.11-slim AS bridge

WORKDIR /app

COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || true

COPY server/ ./server/
COPY shared/  ./shared/

EXPOSE 5274
ENV BRIDGE_PORT=5274

CMD ["python3", "-m", "server.bridge"]

# ═══════════════════════════════════════════════════════════════════════════════
# Stage 3 — Nginx static frontend (production)
# ═══════════════════════════════════════════════════════════════════════════════
FROM nginx:alpine AS static

COPY --from=js-builder /app/dist /usr/share/nginx/html

# Rewrite all routes to index.html (SPA routing)
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  location / {\n    try_files $uri $uri/ /index.html;\n  }\n}\n' \
    > /etc/nginx/conf.d/default.conf

EXPOSE 80

# ═══════════════════════════════════════════════════════════════════════════════
# Stage 4 — Dev (single-container, bridge + vite dev server)
# ═══════════════════════════════════════════════════════════════════════════════
FROM node:20-slim AS dev

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --prefer-offline

COPY requirements*.txt ./
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir \
       -r requirements.txt 2>/dev/null || true

COPY . .

EXPOSE 5273 5274
ENV PATH="/app/.venv/bin:$PATH"

CMD ["sh", "-c", "python3 -m server.bridge & npm run dev -- --host 0.0.0.0 --port 5273"]
