# Addendum: Patrones Avanzados de Orquestación (Delta Audit)

**Fecha:** 2026-05-01
**Referencia:** Complemento al `implementation_plan.md` v2.0
**Origen:** Deep-dive de 97 repositorios en `orchestrator-audit/repos/`

Este documento detalla hallazgos de "bajo nivel" y técnicas avanzadas descubiertas durante la auditoría profunda que NO están cubiertas en el plan base pero que representan el siguiente nivel de madurez para el Agent OS de RepoCiv.

---

## 1. Seguridad de Grado Kernel (Aislar el "Cerebro")

*Para integrar en la **Fase 1.5 (Security Harness)** y **Fase 5 (Docker Enforcement)**.*

*   **A1. Monitoreo eBPF (Fuente: `Loom`):** 
    *   **Técnica:** Interceptar syscalls (`execve`, `connect`, `openat`) directamente en el kernel.
    *   **Utilidad:** Permite detectar si un agente intenta conectarse a una IP externa o leer archivos fuera de su sandbox sin depender de los logs del runtime. Es invisible para el agente.
*   **A2. Linux Landlock (Fuente: `NemoClaw`):**
    *   **Técnica:** Restricción granular de FS a nivel de proceso.
    *   **Utilidad:** Incluso si el agente "escapa" de Docker, el kernel le impide leer cualquier directorio que no haya sido explícitamente habilitado. Proporciona defensa en profundidad real.
*   **A3. Runtime Preload Patching (Fuente: `NemoClaw`):**
    *   **Técnica:** Uso de `LD_PRELOAD` o `NODE_OPTIONS=--require`.
    *   **Utilidad:** Interceptar y sanitizar variables de entorno o buffers de memoria que contengan secretos (API Keys, SSH tokens) antes de que el proceso del agente pueda verlos o enviarlos.

---

## 2. Escalabilidad y Movilidad (El "Imperio Distribuido")

*Para integrar en una futura **Fase 6 (Mesh Networking)**.*

*   **B1. P2P Mesh Discovery (Fuente: `ai-maestro`):**
    *   **Técnica:** Protocolo de intercambio de pares (Peer Exchange) con `propagationId`.
    *   **Utilidad:** Permite que múltiples máquinas ejecutando RepoCiv se encuentren y sincronicen el estado del "Imperial Map" sin un servidor central.
*   **B2. Agentes Portátiles (ZIP Migration):**
    *   **Técnica:** Empaquetado atómico de `agent.db` (SQLite) + historial + archivos de issue.
    *   **Utilidad:** Permite mover una misión activa de un host saturado a uno con más recursos (ej. mover de una laptop a un servidor GPU) simplemente enviando un archivo ZIP.

---

## 3. Dinámica de Supervivencia y Costo

*Para integrar en la **Fase 2 (Model Router)**.*

*   **C1. Economic Survival Model (Fuente: `ClawWork`):**
    *   **Técnica:** `Task Valuation` + `Agent Balance`.
    *   **Utilidad:** Asignar un "pago" en créditos a cada tarea. Si el agente gasta más en tokens de lo que "gana" resolviendo tareas con éxito (validado por el Ledger), entra en bancarrota y se detiene. Esto fuerza la eficiencia.
*   **C2. Payment-to-Quality Mapping:**
    *   **Fórmula:** `Payment = score × (est_hours × rate)`.
    *   **Utilidad:** Incentiva al orquestador a usar modelos más baratos (Haiku) para tareas de bajo valor y reservar los caros (Opus) para tareas críticas.

---

## 4. UX & Terminal Visuals (HUD Industrial)

*Para integrar en el **Frontend (Canvas/HUD)**.*

*   **D1. Subagent Tree Panel (Fuente: `Ralph-TUI`):**
    *   **Visualización:** Árbol jerárquico de procesos (`DAVI` -> `SCOUT` -> `WORKER`).
    *   **Data:** Mostrar live duration y estado de "pensamiento" (tokens/sec) por cada nodo del árbol.
*   **D2. Merge Queue View:**
    *   **Visualización:** Un carril separado en el Kanban para la fase de "Síntesis" (Swarm Debate), donde el usuario ve visualmente cómo se consolidan las opiniones de los agentes antes del commit final.

---

## 5. Gestión de Contexto "Lazy"

*Para integrar en la **Fase 4 (World Model)**.*

*   **E1. Gap-Line IPC Expansion (Fuente: `parallel-code`):**
    *   **Técnica:** No inyectar el archivo completo, sino solo los "hunks" del diff.
    *   **Utilidad:** Si el agente necesita ver 10 líneas arriba/abajo de un cambio, las solicita vía IPC. Esto mantiene el contexto "limpio" y ahorra miles de tokens en archivos grandes.
