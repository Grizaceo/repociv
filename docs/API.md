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
| GET | `/pending` | Tareas desde `PENDING_TRACKER.md` |
| GET | `/tasks` | Tareas activas del orquestador |
| GET | `/approvals` | Comandos esperando aprobación |
| POST | `/commands` | Intake del Command Bus |
| POST | `/commands/<id>/cancel` | Cancelar comando en cola |
| POST | `/approvals/<id>/approve` | Aprobar comando pendiente |
| POST | `/approvals/<id>/reject` | Rechazar comando pendiente |

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

---

### Contexto & Directivas

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/context` | Estado XCOM (fatigue, rest areas) |
| GET | `/techdebt` | Scan de tech-debt across repos |
| GET | `/directives/stats` | Estadísticas de directivas |
| GET | `/directives/suggest` | Sugerencias de directivas (`?gesture=&agent=`) |

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

