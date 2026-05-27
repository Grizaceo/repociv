# RepoCiv Bridge API

> Documentación de los endpoints HTTP expuestos por `server/bridge.py`.
> Base URL: `http://localhost:5274` (configurable vía `BRIDGE_PORT` en `.env`).

---

## Autenticación

Todos los endpoints `POST` requieren el header:

```
X-RepoCiv-Token: <token>
```

El token se define en `.env` como `REPOCIV_TOKEN`. En modo dev, dejar vacío = bypass de auth.

---

## Endpoints

### Health & Readiness

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/health` | Liveness check básico |
| GET | `/ready` | Readiness + estado del event store y token |

**`/health`**
```bash
curl http://localhost:5274/health
```
```json
{
  "ok": true,
  "openclaw": true,
  "claudeCode": true,
  "cursor": false,
  "defaultTransport": "hermes"
}
```

**`/ready`**
```bash
curl http://localhost:5274/ready
```
```json
{
  "ok": true,
  "eventStore": "/home/gris/.repociv/events.jsonl",
  "token": true
}
```

---

### Agentes

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/agents` | Estado de agentes + depth de cola |
| GET | `/agents/capabilities` | Modelo de capacidades (Fase 6) |

**`/agents`**
```json
{
  "agents": [...],
  "queueDepth": 3,
  "queue": [...]
}
```

---

### Misiones & Tareas

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/missions` | Lista de misiones persistidas |
| GET | `/pending` | Tareas desde `PENDING_TRACKER.md` + tareas locales (L-prefixed) |
| GET | `/tasks` | Tareas activas del orquestador |
| GET | `/approvals` | Comandos esperando aprobación |
| POST | `/commands` | Intake del Command Bus |
| POST | `/commands/<id>/cancel` | Cancelar comando en cola |
| POST | `/approvals/<id>/approve` | Aprobar comando pendiente |
| POST | `/approvals/<id>/reject` | Rechazar comando pendiente |
| POST | `/pending/add` | Agregar tarea (body: `{title, priority}`) |
| POST | `/pending/resolve` | Resolver tarea (body: `{id}`) |
| POST | `/pending/edit` | Editar tarea (body: `{id, title, priority}`) |
| POST | `/pending/delete` | Eliminar tarea (body: `{id}`) |
| POST | `/pending/state` | Cambiar estado (body: `{id, state}`) |

---

### Observabilidad

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/gpu` | VRAM + temperatura vía `nvidia-smi` |
| GET | `/metrics` | Métricas calculadas (eventos, agentes, GPU) |
| GET | `/events` | Event store replay (`?since=<unix_ts>`) |
| GET | `/log` | Logs recientes del bridge |

---

### Mejora Auto-dirigida (SICA)

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/improve/reflect` | Patrones de mejora observados |
| GET | `/improve/proposals` | Propuestas scopeadas y validadas |

---

### Configuración

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/api/providers` | Configuración de providers LLM |
| GET | `/providers` | Alias de `/api/providers` |
| GET | `/api/chat-config` | Back-compat alias |
| GET | `/providers/live` | Providers disponibles en tiempo real |
| GET | `/harnesses` | Harnesses registrados |
| GET | `/harnesses/<id>` | Detalle de un harness |

---

### Contexto & Directivas

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/context` | Estado XCOM (fatigue, rest areas) |
| GET | `/techdebt` | Scan de tech-debt across repos |
| GET | `/directives/stats` | Estadísticas de directivas |
| GET | `/directives/suggest` | Sugerencias de directivas (`?gesture=&agent=`) |
| POST | `/directives/record` | Registrar una directiva observada |

---

### WebSocket

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/ws` | Info de conexión WebSocket (URL, puerto, auth) |

**`/ws`**
```json
{
  "wsUrl": "ws://localhost:5275",
  "wsPort": 5275,
  "protocol": "websocket",
  "authRequired": true
}
```

---

### Wonders (Maravillas)

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/api/wonders` | Listar todos los Wonder manifests registrados |
| GET | `/api/wonders/<id>` | Obtener un Wonder manifest por ID |
| GET | `/api/wonders/<id>/health` | Health check de un Wonder específico |

> Legacy: `/wonders`, `/wonders/{id}`, `/wonders/{id}/health` siguen funcionando como aliases.

**`/api/wonders`**
```json
{
  "wonders": [
    {
      "id": "bibliotheca",
      "name": "Bibliotheca",
      "tier": 1,
      "status": "active"
    }
  ]
}
```

**`/api/wonders/<id>/health`**
```json
{
  "id": "bibliotheca",
  "status": "healthy",
  "lastCheck": "2026-05-27T00:00:00Z"
}
```

---

### Graph Relations (Grafo de Conocimiento)

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/api/graph-relations` | Relaciones candidatas para una ciudad |
| GET | `/api/graph-relations/evidence` | Evidencia entre dos ciudades |
| GET | `/api/graph-relations/stats` | Estadísticas del índice |
| POST | `/api/graph-relations/flags` | Sincronizar flags opt-in desde UI |
| POST | `/api/graph-relations/refresh` | Forzar rebuild del índice |

**`/api/graph-relations`** — Query params:
- `cityId` (str, required): ID de la ciudad.
- `limit` (int, optional): máximo de candidatos (default 10).
- `all` (str, optional): `"true"` para sin límite.
- `cities` (str, optional): JSON serializado de lista de ciudades.

```json
{
  "cityId": "repociv",
  "count": 5,
  "relations": [...]
}
```

**`/api/graph-relations/evidence`** — Query params:
- `fromId` (str, required): ciudad origen.
- `toId` (str, required): ciudad destino.

**`/api/graph-relations/flags`** — Body:
```json
{
  "graphSuggestions": true,
  "aiRelationDiscovery": false
}
```

**`/api/graph-relations/refresh`** — Body:
```json
{
  "cities": [...],
  "repoPaths": ["/home/gris/.hermes/workspace/repos/repociv"]
}
```

---

### Foreign Relations (Relaciones Exteriores)

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/api/foreign/repo-profile` | Construir perfil de un repo (query: `?repoPath=`) |
| GET | `/api/foreign/repo-profile/cache` | Listar perfiles cacheados |
| GET | `/api/foreign/reports` | Listar reportes (query: `?cityId=&articleId=`) |
| GET | `/api/foreign/reports/<id>` | Obtener un reporte por ID |
| DELETE | `/api/foreign/reports/<id>` | Eliminar un reporte |
| POST | `/api/foreign/score` | Score de artículo vs perfil de repo |
| POST | `/api/foreign/report` | Generar y guardar ForeignRelationsReport |

**`/api/foreign/repo-profile`** — Query params:
- `repoPath` (str, required): path absoluto al repo.

**`/api/foreign/score`** — Body:
```json
{
  "article": { "title": "...", "url": "...", "blogName": "..." },
  "repoPath": "/home/gris/.hermes/workspace/repos/repociv",
  "events": []
}
```

**`/api/foreign/report`** — Body:
```json
{
  "article": { "title": "...", "url": "...", "id": "..." },
  "repoPath": "/home/gris/.hermes/workspace/repos/repociv",
  "targetCityId": "repociv",
  "agentId": "diplomat",
  "events": [],
  "graphRelations": []
}
```

---

### LabHub (Institutum)

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/api/labhub/status` | Estado general de reachability del Institutum |
| GET | `/api/labhub/status/<city_id>` | Estado de laboratorio para una ciudad |
| GET | `/api/labhub/status/batch` | Estado batch de todos los laboratorios |

**`/api/labhub/status/<city_id>`** — Query params:
- `repoPath` (str, optional): path del repo para link de logs.

---

### CDaily (Noticias)

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/api/news/latest` | Últimos artículos no leídos (máx 15) |
| POST | `/api/news/read` | Marcar artículo como leído |
| POST | `/api/news/scan` | Escanear blogs ahora (via blogwatcher-cli) |

**`/api/news/latest`**
```json
[
  {
    "id": 42,
    "title": "...",
    "url": "https://...",
    "publishedDate": "2026-05-27T00:00:00Z",
    "blogName": "...",
    "category": "AI",
    "emoji": "🤖"
  }
]
```

**`/api/news/read`** — Body:
```json
{ "id": 42 }
```

**`/api/news/scan`** — Dispara `blogwatcher-cli scan` (timeout 120s).

---

## SSE (Server-Sent Events)

```bash
curl -H "Accept: text/event-stream" http://localhost:5274/events
```

Stream continuo de eventos del sistema. Reconecta automáticamente en el frontend.

---

## Legacy Endpoint

| Method | Path | Descripción |
|--------|------|-------------|
| POST | `/` | `unit_command` / `quest_add` (back-compat) |

---

## CORS

Restringido a:
- `http://localhost:5273`
- `http://127.0.0.1:5273`

---

## Rate Limit

60 requests/minuto por IP (in-memory, resetea al reiniciar).

---

## Body Limit

128 KB máximo por request.
