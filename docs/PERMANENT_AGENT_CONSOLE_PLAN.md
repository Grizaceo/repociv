# RepoCiv — Plan end-to-end para consola permanente de agentes reales

Fecha: 2026-04-29
Autor: DAVI
Objetivo: llevar RepoCiv desde beta visual local a consola permanente, segura, observable y accionable para coordinar agentes reales.

---

## 0. Tesis de diseño

RepoCiv no debe ser solo un dashboard bonito. Debe ser una consola operacional espacial:

- El mapa muestra estado real del workspace.
- Las unidades representan agentes con capacidades, permisos, fatiga/contexto y cola de trabajo.
- Las ciudades/repos son dominios de responsabilidad.
- Las rutas/misiones son directivas ejecutables, auditables y reversibles.
- Toda acción real pasa por un gateway seguro con permisos, cola, logs y replay.

La representación espacial no transfiere capacidades latentes al modelo en el sentido técnico de activation steering. Pero sí puede transferir directivas operacionales al sistema agente: convierte instrucciones difusas en coordenadas, affordances, rutas, prioridades y constraints. Es decir: no mueve un vector interno del LLM; mueve el estado externo que condiciona sus decisiones.

---

## 1. Principios no negociables

1. Seguridad local primero: bridge sin token/auth no puede ser consola permanente.
2. Toda acción agente debe ser un Command con estado, permisos y audit log.
3. UI nunca ejecuta directamente: UI propone, policy decide, executor actúa.
4. Event sourcing: si no se puede replayear, no ocurrió.
5. Human-in-the-loop graduable: dry-run, approve, auto-safe, auto-full por agente/tarea.
6. Espacio como interfaz de intención: arrastrar unidad a ciudad = crear directiva estructurada, no magia.
7. Skills/capabilities explícitas: cada agente declara herramientas, límites y dominios.
8. Observabilidad desde día 1: logs, métricas, heartbeat, cola, errores, costo, duración.

---

## 2. Arquitectura objetivo

Capas:

1. Frontend RepoCiv
   - Canvas/3D map
   - Command composer
   - Agent inspector
   - Mission queue
   - Event timeline
   - Approval panel

2. API Gateway local
   - Reemplaza o encapsula bridge.py actual
   - Auth local por token
   - CORS restringido
   - Rate limits
   - Request schemas
   - Command intake

3. Policy Engine
   - Decide si una acción requiere aprobación
   - Evalúa permisos por agente, repo, herramienta, riesgo
   - Mantiene modos: dry-run / approve / auto-safe / blocked

4. Orchestrator / Scheduler
   - Cola de misiones
   - Prioridad real
   - Leasing de tareas a agentes
   - Cancelación y retry
   - Control de concurrencia

5. Executors
   - Hermes agent executor
   - OpenClaw executor
   - LexO executor
   - Terminal/file/git executor wrappers
   - Future: browser executor, cloud executor

6. Event Store
   - JSONL o SQLite inicial
   - Cada Command/Event con id, timestamp, actor, target, payload, result
   - Replay al frontend

7. State Store
   - Agents
   - Capabilities
   - Repos/cities
   - Missions
   - Approvals
   - Locks
   - Metrics

---

## 3. Modelo de datos mínimo

Command:
- id
- type: inspect_repo | run_tests | edit_file | create_branch | execute_agent | send_message | etc.
- createdBy: user | system | agentId
- target: repo/city/file/coordinate
- payload
- risk: low | medium | high | destructive
- requiresApproval: boolean
- status: proposed | queued | running | waiting_approval | completed | failed | cancelled
- createdAt, startedAt, finishedAt

Agent:
- id
- label
- type: davi | lexo | worker | scout | openclaw | custom
- transport: hermes | openclaw | local-cli
- capabilities[]
- permissions[]
- autonomyMode
- contextBudget
- fatigue/context state
- heartbeat

Capability:
- id
- tool
- scope
- risk
- inputSchema
- outputSchema

Event:
- id
- commandId
- type
- timestamp
- actor
- data

SpatialDirective:
- gesture: drag | click | route | area_select
- sourceCoord
- targetCoord
- selectedAgentIds
- interpretedCommand
- confidence
- userConfirmed

---

## 4. Roadmap por fases

### Fase 1 — Hardening P0: que no sea una puerta trasera local

Objetivo: poder dejar 5274 corriendo sin miedo básico.

Tareas:
1. Añadir REPOCIV_TOKEN en .env/.env.example.
2. Frontend manda X-RepoCiv-Token.
3. bridge.py rechaza POST sin token.
4. CORS solo permite http://localhost:5273 y http://127.0.0.1:5273.
5. Límite de body, por ejemplo 128 KB.
6. Validar comandos entrantes con schemas Python.
7. Rate limit simple por IP/ruta.
8. Endpoint /ready además de /health.

Criterio:
- npm test pasa.
- build pasa.
- requests sin token fallan 401.
- origin no autorizado falla.
- comandos malformados fallan 400.

### Fase 2 — Event sourcing y replay

Objetivo: toda acción queda registrada y se puede reconstruir la sesión.

Tareas:
1. Crear server/event_store.py o store SQLite.
2. Persistir CommandCreated, CommandQueued, CommandStarted, AgentOutputChunk, CommandCompleted, CommandFailed.
3. Endpoint GET /events?since=...
4. Frontend consume event stream o polling.
5. Pantalla Timeline/Chronicle.
6. Botón replay last mission.

Criterio:
- reiniciar bridge no pierde misiones previas.
- Quest Board se reconstruye desde events.
- errores quedan visibles.

### Fase 3 — Command Bus + Policy Engine

Objetivo: separar intención visual de ejecución real.

Tareas:
1. Sustituir POST genérico unit_command por POST /commands.
2. Crear Command schema.
3. Crear policy.py con reglas:
   - leer archivos: auto-safe
   - test/build: auto-safe
   - escribir archivos: approve o auto-safe según repo
   - git commit: approve
   - delete/rm/destructive: approve always
   - send_message/external: approve always salvo permiso explícito
4. Approval queue: /approvals pending, approve/reject.
5. UI Approval Panel.

Criterio:
- ningún write real se ejecuta sin política.
- usuario puede aprobar/rechazar desde RepoCiv.

### Fase 4 — Scheduler real de agentes

Objetivo: cola permanente, prioridades reales y control de concurrencia.

Tareas:
1. Integrar priorityMatrix al dispatch real.
2. Crear MissionQueue persistente.
3. Worker loop en bridge/orchestrator.
4. Agent leases: una misión por agente salvo batch workers.
5. Cancel/retry/timeouts.
6. Heartbeat por agente.
7. Fatigue/context budget afecta scheduling.

Criterio:
- una misión sobrevive refresh/restart.
- si agente falla, misión queda failed o retryable.
- Priority Matrix altera el orden real, no solo la UI.

### Fase 5 — Spatial directives

Objetivo: usar el mapa como lenguaje de control.

Gestos iniciales:
1. Drag unit -> city/repo: asignar agente a repo.
2. Drag unit -> file/workbench local: crear misión sobre archivo.
3. Shift+drag ruta entre ciudades: trade route / workflow multi-repo.
4. Area select: batch audit de varios repos.
5. Right-click city: command palette contextual.
6. Drop command card sobre unit: asignar directiva.

Traducción:
- gesto espacial -> SpatialDirective -> Command draft -> policy -> queue.

Criterio:
- cada gesto muestra preview textual antes de ejecutar.
- no hay acción irreversible por gesto accidental.

### Fase 6 — Agent capability model

Objetivo: agentes no son nombres; son contratos.

Tareas:
1. Definir capabilities por agente.
2. Exponer en UI qué puede hacer cada unidad.
3. Tool permissions por repo.
4. Skill binding: una misión puede requerir skill.
5. Memory/context pack: cada misión recibe contexto mínimo.

Criterio:
- LexO no ejecuta tareas generales de shell salvo permiso.
- Worker no toca legal/vault si no corresponde.
- DAVI puede orquestar, pero policy limita ejecución.

### Fase 7 — Observabilidad operacional

Objetivo: saber qué está pasando sin leer logs crudos.

Paneles:
1. Agent status: idle/running/blocked/offline/context-low.
2. Queue depth.
3. Error rate.
4. Mission duration p50/p95.
5. Tool calls por agente.
6. GPU/CPU/mem/disk.
7. Cost/model usage si aplica.
8. Last N failures.

Criterio:
- al abrir RepoCiv, en 10 segundos sé si el sistema está sano.

### Fase 8 — Persistencia y startup permanente ✅ COMPLETADO (2026-04-29)

Objetivo: consola permanente de verdad.

Tareas:
1. ✅ Crear scripts/dev-start.sh y scripts/healthcheck.sh.
2. ✅ systemd user service implementado (deploy/systemd/).
3. ✅ Recovery de procesos colgados (Restart=on-failure).
4. ⚠️ Lockfile de puerto (parcial: systemd reinicia si puerto ocupado).
5. ⚠️ Backup de SQLite/events (script existe, falta automatizar).
6. ✅ Smoke test automático al arrancar (scripts/smoke-test.sh).

Criterio:
- ✅ puedo reiniciar WSL y levantar RepoCiv con un comando (`systemctl --user start repociv.target`).
- ✅ no quedan zombie agents (systemd gestiona ciclos de vida).

Archivos:
- `deploy/systemd/repociv-bridge.service`
- `deploy/systemd/repociv-frontend.service`
- `deploy/systemd/repociv.target`
- `deploy/systemd/README.md`

### Fase 9 — Directives learning layer, no activation fantasy

Objetivo: aprender qué gestos/directivas producen buenos resultados.

Tareas:
1. Registrar gesture -> command -> outcome.
2. Métricas de éxito por tipo de directiva.
3. Sugerencias: “cuando arrastras DAVI a repo con tests rotos, normalmente quieres run_tests+fix”.
4. Plantillas de directiva por patrón.
5. Replay de secuencias exitosas.

Criterio:
- RepoCiv empieza a autocompletar directivas, pero no ejecuta sin policy.

---

## 5. Relación con el video sobre capability directions

El video describe una hipótesis de representación interna: capacidades como direcciones lineales en el espacio latente, transferibles entre modelos si sus espacios están alineados.

RepoCiv NO debe prometer eso directamente, porque no estamos interviniendo activaciones del modelo. Pero sí hay una analogía operacional fuerte:

- En el paper/video, una “dirección” activa circuitos latentes ya existentes.
- En RepoCiv, una “directiva espacial” activa workflows/capabilities ya existentes en agentes y herramientas.
- El mapa no instala capacidades nuevas; selecciona puertas, reduce ambigüedad y fuerza trayectorias iniciales mejores.

La idea útil para diseño es: representar tareas espacialmente puede hacer de steering externo. No cambia los pesos ni las activaciones internas, pero cambia el contexto, el affordance y el prompt/command generado. Eso puede ser suficiente para mejorar desempeño si el agente ya tiene la capacidad latente.

---

## 6. Orden de ejecución recomendado

P0:
1. bridge hardening
2. command schema
3. event store
4. approval/policy

P1:
5. scheduler persistente
6. priorityMatrix real
7. spatial directives preview
8. agent capabilities

P2:
9. observability panels
10. startup permanent service
11. directive learning
12. visual polish Civ-like

---

## 7. Primer sprint concreto

Sprint A — 1 a 2 días

1. Crear .env.example seguro.
2. Token auth + CORS restringido en bridge.py.
3. Command schema Python + frontend client.
4. Event store JSONL simple.
5. Reemplazar unit_command por command draft mínimo.
6. Tests de bridgeSchema + priorityMatrix.
7. npm run check = tsc + test + build.

Definition of Done:
- npm run check OK.
- POST sin token falla.
- Command queda persistido como JSONL.
- UI muestra estado command queued/running/done.
- Ninguna acción real ocurre fuera de policy.
