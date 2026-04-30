# PLAN_ABSORCION_ORCHESTRATORS

Fecha: 2026-04-30
Objetivo: absorber patrones útiles de Paperclip, OpenFang y OpenGoat en RepoCiv sin convertirlo en un monstruo genérico.

Principio rector:
- RepoCiv no necesita copiar productos completos.
- RepoCiv sí necesita formalizar su núcleo operativo: adapters, sesiones, runs, recovery y control-plane.

---

## 1. Qué absorbemos exactamente

Fuentes y patrón principal:

| Fuente | Patrón a absorber | Motivo |
|---|---|---|
| Paperclip | adapter registry + runtime/task/run state separados + MCP fino | convierte el sistema en control-plane real |
| OpenFang | canonical session + locking por agente + kernel/runtime boundary | evita corrupción de sesión y mezcla de responsabilidades |
| OpenGoat | provider abstraction + sidecar boundary + orquestación delgada | soporta múltiples runtimes sin pegar la UI al proveedor |

No absorber:
- plugins zero-trust complejos
- kernel total tipo agent-OS
- megaservicios god-object
- catálogos enormes de capacidades antes de estabilizar el core

---

## 2. Diseño objetivo de RepoCiv

RepoCiv debe converger a 5 capas explícitas:

1. UI spatial layer
- `src/`
- Solo render, gesture capture, approvals, observabilidad, replay.
- Nunca decide detalles de runtime real.

2. Control plane / bridge API
- `server/bridge.py`
- Endpoints HTTP/SSE, auth, rate-limit, request validation, orchestration wiring.
- Debe delegar a servicios pequeños, no contener toda la lógica.

3. Runtime registry + policy
- `shared/` + `server/harness_registry.py` + `src/harnessRegistry.ts` + `server/policy.py`
- Define qué runtimes existen, qué pueden hacer y bajo qué trust model.

4. Session + run state
- Nuevo bloque persistente en `~/.repociv/`
- Separar sesión activa, estado resumido de unidad y log de runs/eventos.

5. Recovery / workspace execution
- `server/recovery.py` + futura capa workspace/issue-state
- Recuperación declarativa, resume, copy-command, tmux, y luego worktrees.

---

## 3. Directorios nuevos propuestos

Dentro del repo:

```text
shared/
  harness-registry.json              # ya existe
  provider-registry.schema.json      # nuevo, opcional si queremos formalizar schema externo

server/
  bridge.py                          # mantener como entrypoint HTTP
  policy.py                          # mantener
  harness_registry.py                # mantener
  recovery.py                        # mantener
  sessions.py                        # NUEVO: canonical sessions + append-only transcript logic
  run_state.py                       # NUEVO: estado resumido por unidad/mission/issue
  runtime_adapters.py                # NUEVO: contrato uniforme para Hermes/OpenClaw/etc.
  workspace_state.py                 # NUEVO: issue/workspace artifact state
  locks.py                           # NUEVO: locking por unit_id/session_id
  mcp_surface.py                     # NUEVO: wrapper fino si exponemos MCP

src/
  harnessRegistry.ts                 # mantener
  runtimeCatalog.ts                  # NUEVO: catálogo UI de runtimes/capabilities/recovery badges
  issueStateClient.ts                # NUEVO: cliente UI para artifacts/state resumido
```

En persistencia local `~/.repociv/`:

```text
~/.repociv/
  events.jsonl                       # ya existe
  missions.json                      # ya existe
  sessions/
    <unit_id>/
      canonical.json                 # resumen vivo de la sesión/unidad
      transcript.jsonl               # append-only
  run-state/
    <mission_id>.json                # estado resumido de ejecución
  workspaces/
    <repo>/<issue_id>/
      spec.md
      plan.md
      state.json
      output/
        fix-summary.md
        tests.md
        review.md
```

Motivo:
- `events.jsonl` no debe cargar toda la semántica operativa.
- Necesitamos separar audit log de estado retomable.

---

## 4. Interfaces concretas a introducir

### 4.1 RuntimeAdapter

Contrato backend uniforme para runtimes:

```python
class RuntimeAdapter(Protocol):
    id: str
    trust_level: str

    def healthcheck(self) -> dict: ...
    def supports(self, command_type: str) -> bool: ...
    def start_run(self, command: dict, context: dict) -> dict: ...
    def stream_run(self, run_id: str): ...
    def cancel_run(self, run_id: str) -> dict: ...
    def build_recovery(self, failure_context: dict) -> dict: ...
```

Implementaciones iniciales:
- HermesLocalAdapter
- OpenClawLocalAdapter
- LocalCliAdapter
- NemoClawSandboxAdapter

Esto evita seguir repartiendo conocimiento de cada runtime entre `bridge.py`, scripts y UI.

### 4.2 SessionStore

```python
class SessionStore(Protocol):
    def get_or_create(self, unit_id: str) -> dict: ...
    def append_message(self, unit_id: str, role: str, content: str, meta: dict | None = None) -> None: ...
    def summarize(self, unit_id: str) -> dict: ...
    def get_recent(self, unit_id: str, limit: int = 20) -> list[dict]: ...
```

Objetivo:
- canonical session por unidad
- transcript append-only
- base para compaction futura

### 4.3 RunStateStore

```python
class RunStateStore(Protocol):
    def load(self, run_id: str) -> dict | None: ...
    def save(self, run_id: str, state: dict) -> None: ...
    def patch(self, run_id: str, **fields) -> dict: ...
```

Uso:
- run status resumido
- current phase
- active adapter
- retries
- files touched
- started_at / updated_at / ended_at

### 4.4 WorkspaceIssueState

```python
class WorkspaceIssueState(Protocol):
    def init_issue(self, repo: str, issue_id: str, spec: str) -> Path: ...
    def write_plan(self, repo: str, issue_id: str, plan_md: str) -> None: ...
    def write_artifact(self, repo: str, issue_id: str, name: str, content: str) -> None: ...
    def load_state(self, repo: str, issue_id: str) -> dict: ...
    def save_state(self, repo: str, issue_id: str, state: dict) -> None: ...
```

Inspiración:
- Paperclip runtime/task/runs
- OpenFang sessions
- OpenGoat append-only local state

---

## 5. Schemas concretos propuestos

### 5.1 canonical session

Ruta:
`~/.repociv/sessions/<unit_id>/canonical.json`

```json
{
  "unitId": "DAVI",
  "runtimeId": "hermes-local",
  "sessionKey": "davi-main",
  "summary": "RepoCiv fix session on repociv bug #13",
  "repo": "repociv",
  "workingDirectory": "/home/gris/.hermes/workspace/repos/repociv",
  "lastMissionId": "m_123",
  "messageCount": 48,
  "inputChars": 12340,
  "outputChars": 9870,
  "updatedAt": "2026-04-30T18:20:00Z"
}
```

### 5.2 transcript append-only

Ruta:
`~/.repociv/sessions/<unit_id>/transcript.jsonl`

```json
{"ts":"2026-04-30T18:20:00Z","role":"user","content":"fix bug #13","missionId":"m_123"}
{"ts":"2026-04-30T18:20:03Z","role":"assistant","content":"Running tests","missionId":"m_123"}
```

### 5.3 run-state

Ruta:
`~/.repociv/run-state/<mission_id>.json`

```json
{
  "missionId": "m_123",
  "unitId": "DAVI",
  "runtimeId": "hermes-local",
  "repo": "repociv",
  "commandType": "execute_agent",
  "phase": "testing",
  "status": "in_progress",
  "retries": 0,
  "checkpointApproved": ["diagnose", "plan"],
  "filesTouched": ["server/bridge.py", "server/test_bridge_streaming.py"],
  "startedAt": "2026-04-30T18:19:10Z",
  "updatedAt": "2026-04-30T18:20:10Z"
}
```

### 5.4 workspace issue state

Ruta:
`~/.repociv/workspaces/<repo>/<issue_id>/state.json`

```json
{
  "repo": "repociv",
  "issueId": "bug-13",
  "branch": "fix/bug-13-working-directory",
  "phase": "fixing",
  "artifacts": [
    "spec.md",
    "plan.md",
    "output/fix-summary.md",
    "output/tests.md"
  ],
  "activeRuntime": "hermes-local",
  "lastUpdated": "2026-04-30T18:20:10Z"
}
```

---

## 6. Mapeo exacto sobre el código actual

### Mantener
- `shared/harness-registry.json`
- `server/harness_registry.py`
- `src/harnessRegistry.ts`
- `server/recovery.py`
- `server/policy.py`
- `server/event_store.py`
- `server/scheduler.py`

### Refactor mínimo recomendado

1. `server/bridge.py`
Problema:
- concentra auth, HTTP, missions, fatigue, chat transport, policy wiring, scheduler wiring, recovery wiring.

Acción:
- dejarlo como composition root + HTTP handlers
- mover estado de sesión a `server/sessions.py`
- mover estado de run a `server/run_state.py`
- mover lógica runtime específica a `server/runtime_adapters.py`

2. `server/policy.py`
Problema:
- hoy decide sobre `harness_id`, `trustLevel`, `allowedActions`, pero no conoce estado runtime vivo.

Acción:
- añadir chequeo opcional de health/capability viva del adapter
- no solo policy estática, también readiness operacional

3. `server/recovery.py`
Problema:
- hoy planifica recovery declarativo, bien, pero todavía no conversa con state resumido ni session state.

Acción:
- extender para incluir:
  - last_run_id
  - repo
  - working_directory
  - latest_artifacts
  - suggested_resume_path

4. `src/` UI
Acción:
- agregar badges por runtime:
  - trust
  - health
  - recovery available
  - session locked / in-progress

---

## 7. Orden de implementación recomendado

### Fase A — session/run split
1. Crear `server/sessions.py`
2. Crear `server/run_state.py`
3. Hacer que `bridge.py` escriba canonical session + transcript + run-state
4. No tocar todavía UI compleja

### Fase B — runtime adapters
1. Crear `server/runtime_adapters.py`
2. Mover conocimiento Hermes/OpenClaw/LocalCLI fuera de `bridge.py`
3. Hacer que policy/recovery trabajen sobre adapter id + adapter instance

### Fase C — workspace issue artifacts
1. Crear `server/workspace_state.py`
2. Inicializar `spec.md`, `plan.md`, `state.json`, `output/`
3. Conectar esto a `execute_agent` / `unit_command` / future issue workflows

### Fase D — UI control-plane
1. `src/runtimeCatalog.ts`
2. panel con session health + run state + recovery entrypoints
3. mostrar phase, retries, active runtime, resume available

### Fase E — MCP surface fina
1. Exponer solo operaciones existentes
2. no replicar dominio ni persistencia en el MCP server

---

## 8. Qué NO hacer

- No meter SQLite todavía si JSON/JSONL basta para una primera capa limpia.
- No mezclar plugin system con runtime registry en la misma fase.
- No convertir `bridge.py` en un kernel total.
- No añadir 20 runtimes antes de estabilizar 3.
- No exponer MCP que reimplemente la lógica de RepoCiv.

---

## 9. Veredicto

RepoCiv ya tiene la semilla correcta: registry, policy, recovery, scheduler, event store.
Lo que falta no es “más features”; falta cerrar el triángulo:

- runtime adapter formal
- session/run split
- workspace artifact state

Si hacemos eso, RepoCiv deja de ser una UI con bridge y pasa a ser un control-plane serio.
