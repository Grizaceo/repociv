# PLAN_IMPLEMENTACION_ABSORCION_GLOBAL

Fecha: 2026-04-30
Contexto: síntesis final tras auditar repos importados del lote orchestrator-audit con foco exclusivo en qué absorbe RepoCiv.

Repos sintetizados en este plan:
- paperclip
- openfang
- opengoat
- sortie
- Dorothy
- parallel-code
- bernstein
- symphony
- subtask
- ralph-orchestrator
- agent-kanban
- clideck

Principio:
- No copiar productos.
- Sí copiar primitives operativas.
- RepoCiv debe pasar de “UI con bridge” a “control-plane con UI spatial”.

---

## 1. Resumen repo por repo: qué tomar

| Repo | Tomar | No tomar |
|---|---|---|
| paperclip | adapter registry, runtime/task/run split, MCP fino, plugin scopes | heartbeat god-service, plugin system demasiado amplio |
| openfang | canonical session, locking por agente, kernel/runtime boundary, config unificada | kernel demasiado ancho, exceso de superficie |
| opengoat | provider abstraction, sidecar boundary, orquestación delgada | megafachada central, persistencia file-only como solución final |
| sortie | retries persistidos, continuation real, workspace por issue, sentinel protocol simple | demasiado shell-hook para branching/core git |
| Dorothy | control-plane desktop/API local autenticada, PTY-per-agent, provider strategy | file sprawl, múltiples transportes mezclados |
| parallel-code | worktree isolation, UI/runtime separation, runtime descriptors, diff/review desacoplado | IPC monolítico, snapshots demasiado amplios |
| bernstein | deterministic orchestrator, FSM explícita, WAL/replay, ownership checks | demasiadas capas file-state sin jerarquía clara |
| symphony | scheduler central con reconcile, workers efímeros, workspaces persistentes | demasiada lógica de policy en prompt/WORKFLOW |
| subtask | task folder portable, event log durable + index derivado, worktree pool | complejidad git-centric para todo |
| ralph-orchestrator | estado en disco con locking, merge queue event-sourced, registry de loops | symlinks/shared state demasiado permisivos |
| agent-kanban | control-plane/data-plane split, identity/capability model, session persistence | mezcla SSE/poll/relay, secretos sensibles en DB |
| clideck | thin control plane sobre PTYs, presets declarativos por runtime, transcript normalizado | heurísticas frágiles por agente/UI |

---

## 2. Conclusiones globales: primitives que RepoCiv sí necesita

Después de los 12 repos, las primitives realmente repetidas y valiosas son estas:

1. Runtime registry
2. Provider/runtime adapter abstraction
3. Canonical session por unidad/agente
4. Append-only transcript / event log
5. Run state resumido, separado del event log
6. Issue/task workspace state con artifacts
7. Worktree/workspace isolation first-class
8. Locking por unidad/sesión/run
9. Scheduler central con reconcile loop
10. Retry/continuation persistidos
11. Recovery declarativo con resume real
12. MCP/API como façade fina sobre el core
13. Review/diff como capa separada del runtime
14. Identity/capability model por actor/runtime
15. Single-writer discipline para estado sensible

RepoCiv hoy ya tiene semillas de:
- event_store
- scheduler
- harness_registry
- policy
- recovery

Lo que falta es cerrar la arquitectura y separar estados.

---

## 3. Modelo objetivo final para RepoCiv

### 3.1 Capas

1. Spatial UI
- render, input, observabilidad, approvals, replay
- jamás debe conocer detalles internos de Hermes/OpenClaw/etc.

2. Control-plane API
- auth, validation, orchestration wiring, SSE, commands
- `server/bridge.py` debe quedar como composición/HTTP shell

3. Runtime orchestration core
- scheduler
- policy
- runtime adapters
- locks
- reconcile loop

4. State layer
- canonical sessions
- transcripts
- run-state
- workspace issue state
- event log

5. Isolation layer
- workspaces
- worktrees
- recovery
- resume

6. External surface layer
- MCP fino
- future sidecar / local API
- remote/mobile/dashboard clients si aparecen después

---

## 4. Diseño detallado de estado

### 4.1 Event log
Mantener:
- `~/.repociv/events.jsonl`

Rol:
- auditoría append-only
- replay
- observabilidad histórica

No debe ser:
- la única fuente de verdad operativa viva

### 4.2 Canonical session
Nuevo:
- `~/.repociv/sessions/<unit_id>/canonical.json`
- `~/.repociv/sessions/<unit_id>/transcript.jsonl`

Rol:
- continuidad conversacional por unidad
- summary, workingDirectory, runtimeId, lastMissionId, counters
- transcript append-only legible

Inspiración:
- openfang
- opengoat
- clideck

### 4.3 Run state
Nuevo:
- `~/.repociv/run-state/<mission_id>.json`

Rol:
- estado resumido de ejecución
- phase, retries, activeRuntime, filesTouched, checkpointApproved

Inspiración:
- paperclip
- sortie
- symphony

### 4.4 Workspace issue state
Nuevo:
- `~/.repociv/workspaces/<repo>/<issue_id>/state.json`
- `spec.md`
- `plan.md`
- `output/`

Rol:
- task folder portable
- artifacts del flujo
- resume por issue/trabajo

Inspiración:
- subtask
- full-stack-orchestration
- conductor
- sortie

---

## 5. Contratos / módulos a introducir

### 5.1 `server/runtime_adapters.py`

Contrato mínimo:

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

Inspiración:
- opengoat
- Dorothy
- clideck
- paperclip

### 5.2 `server/sessions.py`

Responsabilidades:
- get_or_create canonical session
- append_message
- summarize
- get_recent
- rotate/compact transcript si crece demasiado

Inspiración:
- openfang
- opengoat
- clideck

### 5.3 `server/run_state.py`

Responsabilidades:
- create/load/save/patch run state
- separate source of truth for “what is happening now”
- survive retries/resume

Inspiración:
- paperclip
- symphony
- sortie

### 5.4 `server/workspace_state.py`

Responsabilidades:
- init issue folder
- write plan/spec/artifacts
- load/save issue state
- maybe later branch/worktree metadata

Inspiración:
- subtask
- sortie
- full-stack-orchestration

### 5.5 `server/locks.py`

Responsabilidades:
- unit/session/run locks
- prevent concurrent mutation of canonical session and run state

Inspiración:
- openfang
- subtask
- ralph-orchestrator

### 5.6 `server/reconcile.py`

Nuevo módulo opcional pero recomendable.
Responsabilidades:
- check queued/waiting/running runs
- detect stale sessions
- re-arm retries
- rebuild operational snapshot after restart

Inspiración:
- symphony
- sortie
- agent-kanban

### 5.7 `server/mcp_surface.py`

Responsabilidades:
- expose current API/capabilities as MCP only if/when needed
- never own domain logic

Inspiración:
- paperclip
- Dorothy

---

## 6. Refactors precisos en código actual

### 6.1 `server/bridge.py`

Problema actual:
- hace demasiado: auth, dotenv, rate-limit, mission persistence, fatigue state, runtime wiring, endpoints, streaming, scheduler glue.

Objetivo:
- convertirlo en HTTP composition root
- mover lógica operativa a módulos especializados

Partición objetivo:
- `bridge.py`
  - request parsing
  - auth/cors/body limit
  - endpoint routing
  - service composition
- `runtime_adapters.py`
  - Hermes/OpenClaw/local CLI specifics
- `sessions.py`
  - canonical session/transcript
- `run_state.py`
  - run summary state
- `reconcile.py`
  - restart recovery/live maintenance

### 6.2 `server/policy.py`

Mantener idea actual, ampliar:
- policy estática por trustLevel/allowedActions
- más health-aware gating opcional
- más actor-aware gating después (leader/worker/operator)

Inspiración:
- agent-kanban
- paperclip

### 6.3 `server/recovery.py`

Extender:
- incluir reference a session/run state
- devolver last_run_id, repo, working_directory, latest artifacts
- agregar “resume recommendation” y no solo copy-command/tmux attach

Inspiración:
- sortie
- symphony
- subtask

### 6.4 `shared/harness-registry.json`

Evolución recomendada:
- seguir siendo registry declarativo
- pero añadir campos opcionales:
  - `session_strategy`
  - `supports_resume`
  - `supports_worktree`
  - `capabilities`
  - `identity_scope`

Ejemplo:

```json
{
  "id": "hermes-local",
  "supports_resume": true,
  "session_strategy": "canonical_per_unit",
  "supports_worktree": true,
  "capabilities": ["chat", "edit", "run_tests", "git"],
  "identity_scope": "unit"
}
```

### 6.5 UI (`src/`)

Agregar luego:
- runtime badge
- session health badge
- run phase badge
- retries/resume badge
- issue artifact viewer
- worktree/workspace provenance

Inspiración:
- Dorothy
- clideck
- parallel-code

---

## 7. Orden de implementación detallado

## Fase 0 — higiene previa
Objetivo: preparar terreno sin romper flujos actuales.

Tareas:
1. Crear docs formales ya hechos:
   - `docs/PLAN_ABSORCION_ORCHESTRATORS.md`
   - `docs/PLAN_IMPLEMENTACION_ABSORCION_GLOBAL.md`
2. Confirmar estado actual:
   - branch
   - tests
   - health/smoke
3. No tocar aún UI grande

Criterio de salida:
- baseline clara

## Fase 1 — session/run split
Objetivo: separar lo vivo de lo histórico.

Tareas:
1. Crear `server/sessions.py`
2. Crear `server/run_state.py`
3. Hacer que `bridge.py`:
   - abra/actualice canonical session por unit
   - escriba transcript.jsonl
   - cree/actualice run-state por mission
4. Tests nuevos:
   - canonical session create/update
   - transcript append-only
   - run-state patch/update
   - crash-safe rewrite

Criterio de salida:
- RepoCiv ya no depende solo de events.jsonl para saber qué está pasando

## Fase 2 — runtime adapter abstraction
Objetivo: sacar conocimiento de runtime fuera de bridge.

Tareas:
1. Crear `server/runtime_adapters.py`
2. Implementar adapters iniciales
3. Refactor de `bridge.py` para usar adapter seleccionado
4. Conectar `policy.py` con capability/adapters
5. Tests:
   - adapter selection
   - adapter capability block
   - recovery by adapter
   - unknown runtime failure path

Criterio de salida:
- Hermes/OpenClaw/local-cli dejan de estar “pegados” al bridge

## Fase 3 — locks + reconcile
Objetivo: robustez tras concurrencia y reinicios.

Tareas:
1. Crear `server/locks.py`
2. Lock por sessionId/unitId/runId
3. Crear `server/reconcile.py`
4. Al boot:
   - reconstruir snapshot de runs activos
   - rearmar retries/recovery hints
   - detectar state stale
5. Tests:
   - concurrent write guard
   - stale session recovery
   - retry rearm
   - safe boot reconcile

Criterio de salida:
- RepoCiv se reinicia y no queda amnésico ni corrupto

## Fase 4 — workspace issue state
Objetivo: convertir arreglos/ejecuciones en artifacts retomables por issue.

Tareas:
1. Crear `server/workspace_state.py`
2. Estructura:
   - spec.md
   - plan.md
   - state.json
   - output/
3. Integrar con `execute_agent` / `unit_command` / future issue flow
4. Opcional: branch/worktree metadata en state.json
5. Tests:
   - init issue folder
   - write/read state
   - artifact lifecycle
   - resume from issue state

Criterio de salida:
- RepoCiv ya tiene “task folder portable” serio

## Fase 5 — worktree isolation first-class
Objetivo: hacer del aislamiento git una primitive real, no adorno.

Tareas:
1. Diseñar worktree manager pequeño
2. Asignar worktree por issue/repo cuando aplique
3. Guardar metadata en workspace issue state
4. Cleanup/recovery policy
5. Tests:
   - create/assign worktree
   - stale worktree handling
   - safe cleanup

Inspiración:
- subtask
- parallel-code
- sortie
- ralph-orchestrator

Criterio de salida:
- ejecución concurrente segura sobre repos reales

## Fase 6 — review/diff layer
Objetivo: desacoplar revisión del runtime.

Tareas:
1. introducir capa de review artifacts
2. parsear/store diff summaries por run/issue
3. UI pequeña de review/replay
4. tests

Inspiración:
- parallel-code

Criterio de salida:
- review deja de ser solo texto perdido en chat/logs

## Fase 7 — MCP / sidecar / external surfaces
Objetivo: exponer RepoCiv a otros clientes sin duplicar dominio.

Tareas:
1. `server/mcp_surface.py` o sidecar local
2. exponer operaciones actuales, no rehacer core
3. auth + local bind + capability filtering
4. tests

Inspiración:
- paperclip
- Dorothy
- opengoat

Criterio de salida:
- RepoCiv puede ser consumido externamente sin romper su arquitectura interna

---

## 8. Arreglos concretos derivados del audit

### P0 — hacer ya
- adelgazar `bridge.py`
- introducir `sessions.py`
- introducir `run_state.py`
- introducir `runtime_adapters.py`
- introducir `locks.py`

### P1 — siguiente ola
- `workspace_state.py`
- reconcile loop
- resume/recovery enriquecido
- adapter capability model ampliado

### P2 — después
- worktree manager
- review/diff layer
- MCP/sidecar surface
- richer actor identity model

---

## 9. SOBRA / MERGE / FALTA final

### SOBRA
- más lógica de runtime incrustada en `bridge.py`
- confiar solo en events.jsonl para estado vivo
- recovery decorativo sin resume state
- heurísticas de provider esparcidas

### MERGE
- runtime knowledge en `runtime_adapters.py`
- estado operativo en 4 capas claras:
  - events
  - sessions
  - run-state
  - workspace-state
- identidad/capabilities de runtime en el registry
- lectura consistente en un pequeño state service, no por módulos sueltos

### FALTA
- canonical sessions
- append-only transcripts por unidad
- run-state resumido
- reconcile loop
- locking serio
- issue/workspace artifacts
- worktree isolation first-class
- review/diff layer
- MCP façade fina

---

## 10. Veredicto final

Después de 12 repos, la dirección correcta de RepoCiv quedó bastante clara:

RepoCiv no debe crecer como “más UI + más bridge hacks”.
Debe crecer como:
- control-plane local
- adapters de runtime
- estado explícito y retomable
- aislamiento por issue
- UI spatial como superficie operativa

En una frase:
- primero sistema operativo del trabajo,
- después más fantasía visual.
