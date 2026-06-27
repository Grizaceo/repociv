# Getting Started with RepoCiv

> A step-by-step tutorial for setting up RepoCiv for the first time,
> navigating the hex map, and running your first agent mission.

> ⚠️ **Single-operator model — DO NOT share your instance.**
>
> RepoCiv is designed for **one operator on one machine**. The bridge
> trusts any request that presents a valid `REPOCIV_TOKEN`, and the
> agent runner launches harnesses with `--dangerously-skip-permissions`.
> Whoever holds the token can execute arbitrary commands on the host.
> Exposing RepoCiv on a shared or public network is out of scope and
> unsafe. See [SECURITY.md](../SECURITY.md#security-policy) for the
> full model and remote-mode requirements.

---

## Prerequisites

| Dependency | Minimum Version | Check Command |
|------------|----------------|---------------|
| Node.js | 20.x | `node --version` |
| npm | 10.x | `npm --version` |
| Python | 3.11 | `python3 --version` |
| pip | 24.x | `pip --version` |
| Git | 2.x | `git --version` |
| DuckDB | (via pip) | `python3 -c "import duckdb"` |

Optional but recommended:
- **tmux** (for the dev-start script with split panes)
- **systemd** (for persistent bridge operation — Linux/WSL2 only)
- **Docker** (for containerized agent execution)
- **NVIDIA GPU with CUDA** (for GPU monitoring features)

---

## Step 1: Clone the Repository

```bash
git clone <repo-url> repociv
cd repociv
```

---

## Step 2: Install Frontend Dependencies

```bash
npm install
```

This installs TypeScript, Vite, Vitest, Valibot (schema validation),
xterm.js (terminal panel), and Lucide (icons).

### Generate assets (mandatory before first run)

PNG/WebP atlases and 3D textures are **not** tracked in git. Generate them once after clone:

```bash
npm run assets
npm run assets:3d
```

Without this step the map may render without terrain, props, or the isometric office view.

---

## Step 3: Install Backend Dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Packages installed: pytest, httpx, aiohttp, requests, pydantic,
duckdb (required for the event ledger), PyYAML.

The `.venv` directory is gitignored. You need to activate it in every
terminal where you run the bridge (`source .venv/bin/activate`).

---

## Step 4: Configure Environment

```bash
cp .env.example .env
```

The defaults work out of the box for local single-user development:

| Variable | Default | Purpose |
|----------|---------|---------|
| VITE_PORT | 5273 | Frontend dev server port |
| BRIDGE_PORT | 5274 | Python bridge API port |
| REPOCIV_TOKEN | (empty) | Auth token. Empty = localhost-only dev mode |
| WORKSPACE_ROOT | ~/.hermes/workspace/repos | Where repo-cities are scanned from |
| HERMES_URL | http://localhost:8642/v1/chat/completions | Hermes agent API endpoint |
| HERMES_MODEL | minimax-m2.6 | Default model for Hermes bridge calls |
| REPOCIV_CONFIG_DIR | ~/.repociv | Persistent data directory |

If you are not using the Hermes agent ecosystem, set WORKSPACE_ROOT to
any directory containing subdirectories you want to see as cities on the map.
RepoCiv will scan each subdirectory and render it as a city.

To generate a production token:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

---

## Step 5: Start the System

### Option A: Two Terminals (recommended for first time)

Terminal 1 — Backend bridge:

```bash
cd repociv
source .venv/bin/activate
python3 -m server.bridge
```

You should see:
```
INFO:bridge:Started on port 5274
INFO:bridge:Event store at ~/.repociv/events.jsonl
```

Terminal 2 — Frontend:

```bash
cd repociv
npm run dev
```

You should see:
```
VITE v6.x  ready in 500ms
  -> Local: http://localhost:5273/
```

### Option B: Dev Start Script

```bash
./scripts/dev-start.sh --tmux
```

This opens a tmux session with two panes: bridge (left) and frontend (right).

---

## Step 6: Open the Dashboard

Open `http://localhost:5273` in your browser.

If everything is working:
- You will see a dark-themed hexagonal map with cities
- Each city represents a subdirectory in your workspace
- Cities are labeled with directory names
- The top bar shows agent roster (empty initially)
- The bottom bar shows bridge status (should be green/connected)

If the map is blank or shows "Bridge offline", go to Troubleshooting below.

---

## First Steps: Navigating the Map

### Mouse Controls

| Action | Result |
|--------|--------|
| Left-click on empty hex | Select tile (shows info in side panel) |
| Left-click on city | Select city (opens city info) |
| Left-click on agent unit | Select unit (shows agent details) |
| Left-drag | Pan the map |
| Scroll wheel | Zoom in/out |

### Keyboard Controls

| Key | Action |
|-----|--------|
| Q/W/E/O/C/X/R | Spawn MAIN / WORKER / SCOUT / OPENCLAW / CLAUDE / CODEX / CURSOR |
| 1-9 | Select agent by roster slot |
| Space | Cycle to next idle agent |
| Tab | Cycle through all agents |
| G | Toggle hex grid overlay |
| F | Toggle debug overlay |
| V | Toggle fog of war |
| P | Open Priority Matrix panel |
| Enter | Open side panel |
| M | Enter Move mode (click target hex) |
| S | Send selected unit to rest |
| ? | Show keyboard help overlay |

### Spawning Your First Agent

1. Press **Q** to spawn MAIN (your first unit — the harness-aware orchestrator slot)
2. A blue unit will appear on a random city on the map
3. Click the unit to see its status panel on the right
4. The unit will start walking toward the nearest city

### Switching to Local View

1. **Double-click** a city on the macro map
2. The view zooms into the city interior
3. Files and directories are shown as workbenches on a grid
4. Agents walk between workbenches based on priority scores
5. Press **Esc** to return to the macro map

> **Note:** key `3` toggles 2D (`flat`) ↔ WebGL (`webgl`) on the macro map — it does not enter local view.

---

## Running Your First Mission

RepoCiv is a **passive dashboard**: it visualizes agents but does not
automatically run them unless connected to an agent backend (Hermes).
Here is how to start a mission manually:

### Through the Bridge API

```bash
curl -X POST http://localhost:5274/commands \
  -H "Content-Type: application/json" \
  -d '{
    "type": "inspect_repo",
    "target": "my-repo",
    "payload": {
      "task": "review this repo for outdated documentation"
    }
  }'
```

If a token is configured:

```bash
curl -X POST http://localhost:5274/commands \
  -H "X-RepoCiv-Token: your-token-here" \
  -H "Content-Type: application/json" \
  -d '{...}'
```

### Through the UI

1. Select a city on the hex map
2. Open the Priority Panel (P key)
3. Priority Matrix will show scored files
4. Click "Assign to Agent" on a CRIT or HIGH priority item
5. Select which agent should handle it

### What Happens Next

1. A unit on the map will start walking toward the target city
2. The agent's fatigue bar will decrease as it travels
3. Once at the city, the agent enters "Working" state
4. SSE events stream progress back to the UI
5. When complete, the mission is logged in the Event Store
6. You can see mission history in the Timeline panel (F10)

---

## Managing Agent Fatigue

Agents have a fatigue system (XCOM-style). The more they work, the slower
they become:

- **Green bar**: agent is rested (fatigue > 60%)
- **Yellow bar**: agent is tired (fatigue between 30-60%)
- **Red bar**: agent is exhausted (fatigue < 30%)

To recover fatigue:
1. Select the tired agent
2. Press S to send it to a Rest Area
3. The agent will walk to a rest tile and recover over time
4. Press S again to wake it up when rested

Rest Areas are visible in local view (double-click a city to enter).
Each Rest Area has a capacity and recovery rate, configurable in the
Settings panel (F11).

---

## Troubleshooting

### Bridge won't start

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Address already in use` | Port 5274 occupied | Kill existing process: `kill $(lsof -t -i:5274)` or change `BRIDGE_PORT` in `.env` |
| `ModuleNotFoundError` | Missing dependency | `source .venv/bin/activate && pip install -r requirements.txt` |
| `duckdb not found` | Missing DuckDB | `pip install duckdb` — DuckDB is **required** for the event ledger |

### Frontend shows "Bridge offline"

1. Check the bridge is running: `curl http://localhost:5274/health`
2. Expected response: `{"ok": true, ...}`
3. If no response: start the bridge first (`python3 -m server.bridge`)
4. If response but still shows offline: check CORS settings in `.env`
5. The frontend proxies `/bridge` to `localhost:5274` via Vite proxy

### Map is empty / no cities showing

1. Check your WORKSPACE_ROOT in `.env` — it should point to a directory
   containing subdirectories (each will become a city)
2. Default: `~/.hermes/workspace/repos` — create it if it doesn't exist
3. Each subdirectory should have at least a `README.md` or `package.json`
   to be recognized as a repo

### SSE events not streaming

1. Check the bridge logs for errors
2. Test with curl: `curl -N http://localhost:5274/events`
3. If curl works but the browser doesn't, check for browser SSE limits
   (most browsers support 6 concurrent SSE connections)

### Tests fail due to DuckDB lock

If the bridge is running while you run tests:

```bash
# Option 1: Stop the bridge first
systemctl --user stop repociv-bridge
python3 -m pytest server/ -q

# Option 2: Use isolated data directory
REPOCIV_DATA_DIR=/tmp/repociv-test python3 -m pytest server/ -q
```

---

## Running Tests

```bash
# Full check (typecheck + lint + tests + build + budgets)
./scripts/check.sh

# Or individually:
# Frontend tests (Vitest)
npm test -- --run

# Backend tests (pytest)
source .venv/bin/activate
python3 -m pytest server/ -q
```

---

## Maravillas (conectar servicios iframe)

**Nada viene pre-instalado.** El mapa arranca solo con La Gaceta (nativa).
Cualquier servicio web local apto para iframe — un dashboard, una app, un
panel — se conecta como **Maravilla** y RepoCiv puede levantarlo y embeberlo
sin que abras terminales.

**Conectar:** abrí el **Palacio** (doble clic en la capital) → pestaña
**Maravillas**. Verás la guía y dos **ejemplos** apuntando a sus repos públicos:

- **La Gran Biblioteca** — grafo de conocimiento sobre tus repos.
  Repo: https://github.com/Grizaceo/la-gran-biblioteca
- **LabHub / Institutum** — laboratorio de experimentos.
  Repo: https://github.com/Grizaceo/labhub

Si ya tenés el repo del ejemplo en disco, pulsá **Conectar** y RepoCiv escribe
su manifiesto en `~/.repociv/wonders/<id>.json`, lo muestra como pestaña + tile
en el mapa, y levanta su servidor al abrirlo. Para conectar un servicio propio,
ver [`CUSTOM_WONDERS.md`](./CUSTOM_WONDERS.md).

### Bibliotheca (La Gran Biblioteca) — ejemplo

Una vez conectada, RepoCiv la enlaza como iframe (la UI no se modifica) y
comprueba su backend con variables `VITE_*` (ver `.env.example`).

### Arranque automático (recomendado, F1–F5, 2026-06-16 → 2026-06-17)

A partir del merge de la Fase 1, **RepoCiv levanta las Maravillas por sí mismo**:

1. Abrí RepoCiv con `./scripts/dev-start.sh` (igual que antes).
2. Al boot, el bridge hace `POST /api/wonders/{bibliotheca,institutum}/launch`
   en background, y la viñeta muestra "⚙️ Levantando la maravilla…" mientras
   sondea `launch-status` hasta que `ready.api` **y** `ready.ui` respondan.
3. Cuando `ready === true`, el iframe monta la URL UI resuelta
   (Bibliotheca `:5173`, Institutum `:5280`).
4. Si timeout (60s) o error, cae al empty state con botón "Levantar de nuevo".

No necesitás abrir las terminales manuales de abajo. **Las terminales siguen
siendo necesarias solo si querés desarrollar las Maravillas en aislamiento**
(por ejemplo, ver sus logs de HMR en directo). En uso normal, dejá que
RepoCiv las levante.

### Arranque local (dos terminales, modo desarrollo)

**Terminal 1 — La Gran Biblioteca** (repo `la-gran-biblioteca`):

```bash
python -m backend.library_bridge
cd frontend && npm run dev
```

Bridge/API en `:3001`, UI Vite en `http://127.0.0.1:5173`.

**Terminal 2 — RepoCiv:**

```bash
./scripts/dev-start.sh
```

Abre RepoCiv en el puerto de tu `.env` (p. ej. `VITE_PORT=5273` →
`http://127.0.0.1:5273`).

### Usar la maravilla en el mapa

1. En el mapa imperial, localiza la capital y el icono **B** (Bibliotheca).
2. Doble clic en **B**, o abre el **Palacio** (doble clic en la capital) → pestaña
   **Bibliotheca** → **Entrar a la Bibliotheca**.
3. La viñeta carga el iframe apuntando a `VITE_WONDER_BIBLIOTHECA_URL` (por defecto
   `:5173`). RepoCiv solo hace health-check a `VITE_LGB_BACKEND_URL/api/health`
   (`:3001`); si el backend no responde, verás un aviso para arrancar LGB.

LGB sigue usable en paralelo en `http://127.0.0.1:5173` sin RepoCiv.

### Tailscale / remoto

Si abres LGB en `http://<tailscale-ip>:5173`, en `.env` de RepoCiv:

```bash
VITE_WONDER_BIBLIOTHECA_URL=http://<tailscale-ip>:5173
VITE_LGB_BACKEND_URL=http://127.0.0.1:3001
```

El iframe usa la IP Tailscale; el health-check usa `127.0.0.1:3001` porque el bridge
suele escuchar solo en loopback y Vite en `:5173` ya hace proxy de `/api` → `:3001`.

Reinicia Vite de RepoCiv tras cambiar `.env`.

Solo si RepoCiv y LGB están en **máquinas distintas** necesitas `LGB_HOST=0.0.0.0` en
la-gran-biblioteca y `VITE_LGB_BACKEND_URL=http://<ip>:3001`.

Con Docker LGB en el host: `VITE_WONDER_BIBLIOTHECA_URL=http://127.0.0.1:3000`.

---

## Docker: agentes aislados (opcional)

RepoCiv **no** empaqueta el dashboard (Vite + bridge) en Docker hoy. La imagen
`repociv-agent` es solo para ejecutar misiones WORKER en contenedor cuando el bridge
tiene `REPOCIV_AGENT_CONTAINER=1` (ver `server/container_runtime.py`).

```bash
./scripts/build-agent-image.sh
# En .env del bridge:
# REPOCIV_AGENT_CONTAINER=1
# REPOCIV_AGENT_IMAGE=repociv-agent:latest
```

La imagen por defecto es un contenedor base **sin LLM**. Para un agente real,
extiende `Dockerfile.agent` con tu CLI (Claude Code, Codex, etc.) y define
`REPOCIV_AGENT_CMD` como comando confiable (se parsea como argv, sin `sh -c`).
Si solo quieres un smoke test del contenedor, usa `REPOCIV_CONTAINER_STUB=1`.

Política aplicada por el bridge: `--network none`, bind read-only del repo objetivo,
tmpfs en `/tmp/workspace`, sin montar `.env` ni `~/.ssh` del host.

---

## Next Steps

- Read [PUBLIC_ARCHITECTURE.md](PUBLIC_ARCHITECTURE.md) for a deep dive into
  how RepoCiv works internally
- Read [ROADMAP.md](ROADMAP.md) for current status and upcoming features
- Read [API.md](API.md) for the full HTTP endpoint reference
- Check the hotkeys list with `?` in the dashboard
