# ─── RepoCiv — Minimal container image ────────────────────────────────────────
# Runs bridge.py (Python) + Vite dev server (Node) in a single container.
# For production, use separate services instead.
#
# Build:  docker build -t repociv .
# Run:    docker run -p 5273:5273 -p 5274:5274 repociv

FROM node:20-slim

# ── System deps ──────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── JS deps ─────────────────────────────────────────────────────────────────
COPY package.json package-lock.json ./
RUN npm ci --prefer-offline

# ── Python deps ──────────────────────────────────────────────────────────────
COPY requirements*.txt ./
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir \
       $([ -f requirements.txt ] && echo "-r requirements.txt" || echo "") 2>/dev/null || true

# ── App source ───────────────────────────────────────────────────────────────
COPY . .

# ── Ports ────────────────────────────────────────────────────────────────────
EXPOSE 5273 5274

# ── Entrypoint: start bridge + vite concurrently ─────────────────────────────
ENV PATH="/app/.venv/bin:$PATH"

CMD ["sh", "-c", \
  "python3 -m server.bridge & npm run dev -- --host 0.0.0.0 --port 5273"]
