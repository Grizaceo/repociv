# Manifiesto de Transformación: RepoCiv — Hacia un Agent OS de Grado Industrial

**Fecha:** 2026-05-01
**Visión:** Convertir RepoCiv en el primer sistema de orquestación que implementa el paradigma "Agent OS" (MemGPT) con el rigor de control de LangGraph y la especialización de roles de CrewAI.

---

## 1. El Estado del Arte (Benchmarking & SOTA)

Tras auditar 96 repositorios y contrastar con el SOTA 2025-2026, RepoCiv se sitúa en una posición privilegiada pero crítica:

- **Mercado (LangGraph/CrewAI):** La industria ha abandonado los loops autónomos (AutoGPT) en favor de **Máquinas de Estado Deterministas**. LangGraph lidera por su persistencia de estado (checkpoints), algo que RepoCiv ya tiene en su ADN (`workspace_issue.py`).
- **Academia (SICA/MemGPT):** El SOTA académico propone que los agentes no solo "hagan", sino que "evolucionen" sus herramientas (Self-Improving Coding Agents). La memoria ya no es un "chat history", sino un sistema de **paginación de contexto** (paging) similar a un Sistema Operativo.
- **Protocolo A2A:** Emerge el estándar de comunicación entre agentes donde el "Sentinel File" (archivo de estado en disco) es la fuente de verdad, superando a las colas de mensajes volátiles.

---

## 2. Los Pilares de la Transformación

### Pilar I: De Phase Machine a "State Graph" (Inspiración LangGraph)
`task_orchestrator.py` debe dejar de ser una lista de pasos y convertirse en un Grafo de Decisión.
- **Nodos:** Diagnose, Plan, Fix, Verify.
- **Edges:** Condicionales basados en el resultado de tests o aprobación humana.
- **Checkpoints:** Cada nodo en el grafo es un "safe-point" persistido en `state.json`, permitiendo pausar y reanudar sesiones complejas sin pérdida de contexto.

### Pilar II: Arquitectura "Agent OS" (Inspiración MemGPT)
RepoCiv debe gestionar el contexto como un Sistema Operativo gestiona la RAM.
- **Main Context (L1):** El prompt activo del subagente.
- **External Context (L2):** Los archivos `.md` numerados en `output/` (Artifact-driven context).
- **Swap Manager:** Un subagente especializado cuya única tarea es resumir y archivar la historia de la sesión para mantener el "signal-to-noise ratio" alto.

### Pilar III: Tríada Actor-Crítico-Reflector (SOTA Académico)
No más agentes monolíticos. Cada issue debe ser atendido por un equipo mínimo:
- **Actor (WORKER):** Ejecuta el código (Modelo: Haiku).
- **Crítico (SCOUT/LEXO):** Evalúa el código en un **Sandbox Docker** (Modelo: Sonnet).
- **Reflector (DAVI):** Analiza por qué falló el Actor y actualiza la estrategia antes del siguiente intento (Modelo: Opus).

---

## 3. Hoja de Ruta Quirúrgica (Auditable)

### Fase 1: Gobernanza y "Phase Gates" (Mes 1)
- **Acción:** Integrar el endpoint `/approvals` del bridge directamente en el flujo de `task_orchestrator.py`.
- **Referencia:** `full-stack-orchestration` (Checkpoint Pattern).
- **Resultado:** Ningún plan se ejecuta sin aprobación explícita del "Imperial Lead" (Usuario).

### Fase 2: Model Tiering y Especialización (Mes 2)
- **Acción:** Configurar `agent_runner.py` para asignar Haiku a tareas de `edit_file` y Sonnet a `inspect_repo`.
- **Referencia:** `agent-orchestration/multi-agent-optimize` (CostOptimizer).
- **Resultado:** Reducción de costos de tokens en un 70% y aumento de velocidad en un 50%.

### Fase 3: Aislamiento via Worktrees (Mes 3)
- **Acción:** Operacionalizar `workspace_issue.py` para que cada issue viva en un `git worktree` dedicado.
- **Referencia:** `sortie/WORKFLOW.md` (Isolation via Branches).
- **Resultado:** Capacidad de procesar múltiples issues en paralelo sobre el mismo repositorio sin conflictos.

---

## 4. Conclusión Estratégica

RepoCiv tiene los "hierros" (infraestructura de persistencia) para ser el líder. Al implementar estos patrones de **SOTA y Mercado**, deja de ser un dashboard visual para convertirse en el **Cerebro Operativo** de tu flota de agentes.

---
*Este manifiesto es la base técnica para la evolución de RepoCiv v2.0.*
