# Visualización de Workflows de IA: Ideación y Referencias

Este documento consolida las ideas, paradigmas y referencias sobre cómo visualizar, gestionar y orquestar flujos de trabajo de ingeniería de software (especialmente con agentes de IA) utilizando metáforas visuales derivadas de videojuegos de gestión y estrategia.

---

## Estado de decisiones (2026-04-28)

| Paradigma | Decisión | Detalle |
|---|---|---|
| RTS / Civ (§1) | ✅ **Implementado** (Phases 1–5) | Vista macro del workspace. Base del proyecto. |
| Colonia / RimWorld (§2) | ✅ **Aprobado para implementar** | Vista local de cada repo. Phases 6–7 del roadmap. |
| Logística / Factorio (§3) | ❌ **Descartado** | Baja accionabilidad en repos estáticos; retomar solo si RepoCiv cubre sistemas en producción. |
| Bajo nivel / Zachtronics (§4) | ❌ **Descartado** | Compite con el IDE real sin diferenciarse. |
| Frostpunk (economía de tokens) | ⏸ **Diferido** | Phase 8 del roadmap. Requiere tracking real de tokens desde OpenClaw. |
| XCOM (fatiga de contexto) | ✅ **Aprobado** | Phase 9 del roadmap. Proxy por longitud de chunks hasta tracking real. |
| Slay-the-Spire (deckbuilding) | ❌ **Descartado** | Compite con el sistema de prioridades RimWorld. |

**Ver roadmap completo en:** `ROADMAP_RIMWORLD_FROSTPUNK.md`

---

## 1. El Paradigma RTS / Orquestación (El modelo AgentCraft / Civilization)
Este es el modelo actual de **RepoCiv** y proyectos como **AgentCraft**.
*   **Concepto:** Un mapa global ("Overworld") donde el usuario actúa como el "Comandante". Los agentes (Cursor, Sonnet, Opus) son "unidades" que se seleccionan, se les asignan misiones y se mueven por el mapa.
*   **Ventajas:** Excelente para una vista macro de alto nivel (el espacio de trabajo completo, dependencias entre repositorios). Fomenta la idea de "conquistar" problemas técnicos y visualizar el estado de salud global de un proyecto.
*   **Desventajas:** La metáfora se rompe al hacer zoom. Representar cada archivo o función como un "territorio" o "hexágono" crea un ruido visual inmanejable (*sprawl*).
*   **Referencias:** *AgentCraft* (UI RTS para Docker/agentes), *Civilization V/VI* (Mapa macro), *Screeps* (RTS donde programas las unidades).

---

## 2. El Paradigma de Colonia / Micro-Management (El modelo RimWorld / Prison Architect)
La evolución natural para hacer "zoom-in" en un repositorio específico.
*   **Concepto:** Una vista Top-Down ortogonal (2D Grid). En lugar de naciones y ejércitos, manejas una "colonia" o "fábrica". 
*   **Mapeo a Ingeniería:**
    *   **Mapa:** El repositorio.
    *   **Habitaciones / Zonas:** Carpetas (ej. `src/`, `tests/`).
    *   **Bancos de trabajo (Workbenches):** Archivos individuales.
    *   **Peones (Agentes):** Agentes de IA especializados (Linter, Tester, Refactorizador).
    *   **Sistema de Prioridades:** El núcleo de RimWorld. Defines qué trabajos son críticos (ej. "Fixear el Build" tiene prioridad 1, "Documentar" prioridad 4). Los agentes evalúan su cola de tareas y actúan de forma autónoma.
    *   **Deuda Técnica:** Se visualiza como "suciedad" o "escombros" en las habitaciones que debe ser barrida.
*   **Ventajas:** Transforma la lectura de logs de terminal en una experiencia visual donde "ves" a los agentes trabajando. El sistema de prioridades es perfecto para la asignación asíncrona de LLMs.
*   **Referencias:** *RimWorld*, *Prison Architect*, *Dwarf Fortress*.

---

## 3. El Paradigma de Logística y Flujo de Datos (El modelo Factorio / Satisfactory)
Ideal para visualizar arquitecturas de sistemas, pipelines de CI/CD o el flujo de datos entre microservicios.
*   **Concepto:** Construir y optimizar cintas transportadoras, máquinas ensambladoras y tuberías para automatizar la producción.
*   **Mapeo a Ingeniería:**
    *   **Cintas Transportadoras:** El flujo de datos, colas de mensajes (Kafka/RabbitMQ) o el event loop.
    *   **Ensambladoras:** Funciones puras, contenedores Docker, o transformadores de datos.
    *   **Cuellos de botella:** Representan ineficiencias computacionales, latencia de red o APIs lentas.
    *   **Espagueti (Spaghetti Code):** Si el diseño está mal estructurado, las cintas se cruzan de manera caótica, visualizando literalmente la deuda técnica arquitectónica.
*   **Ventajas:** Es la mejor metáfora visual para el acoplamiento de sistemas y la optimización de rendimiento.
*   **Referencias:** *Factorio*, *Satisfactory*, *Shapez 2* (enfocado en transformaciones puras sin mecánicas de supervivencia).

---

## 4. El Paradigma de Bajo Nivel / Sistemas Embebidos (El modelo Zachtronics)
Ideal para debugging, optimización de algoritmos o resolución de puzzles de código específicos.
*   **Concepto:** Espacios muy reducidos donde debes programar microcontroladores, ensambladores o brazos robóticos utilizando un conjunto limitado de instrucciones.
*   **Mapeo a Ingeniería:**
    *   **Opus Magnum / SpaceChem:** Metáforas para la ejecución paso a paso y la optimización de ciclos de CPU (concurrencia vs latencia vs espacio).
    *   **TIS-100 / Shenzhen I/O:** Programación en ensamblador y transferencia de registros en paralelo.
    *   **Exapunks:** Ideal para visualizar sistemas distribuidos, seguridad (red team/blue team) y agentes moviéndose entre hosts (redes).
*   **Ventajas:** Exige y visualiza una optimización quirúrgica. Es la antítesis de la vista "Macro", enfocándose en la belleza algorítmica de un solo archivo o función.
*   **Referencias:** Toda la biblioteca de *Zachtronics*, *Human Resource Machine* (manejo de memoria y punteros visualizados como oficinistas).

---

## Propuesta de Diseño (Híbrido RepoCiv)

Para maximizar la utilidad de la orquestación de agentes en `repociv`, la recomendación es implementar un **Seamless Zoom (Zoom Semántico)**:

1.  **Zoom Out Máximo (Vista Civ):** Ves todo el *Workspace*. Los hexágonos representan repositorios o dominios. Asignas misiones a largo plazo (Epics) a agentes "Manager" (ej. Opus).
2.  **Zoom Medio (Vista RimWorld):** Haces clic en un hexágono. La vista transiciona a un grid 2D cuadrado (el repositorio). Ves a los agentes "Worker" (ej. Sonnet/Haiku) caminando entre las "habitaciones" (carpetas), resolviendo tickets en los "bancos de trabajo" (archivos). Aquí manejas las prioridades de los agentes (Bugfixing vs Refactoring vs Feature).
3.  **Zoom In Máximo (Vista Zachtronics / Factorio):** Haces doble clic en un archivo/workbench. Se abre el editor real (tu IDE integrado) pero con visualizaciones de flujo de datos (AST) para ver qué líneas de código se están ejecutando o modificando en tiempo real.

Este enfoque evita la sobrecarga cognitiva de un solo paradigma y aplica la visualización correcta según el nivel de abstracción del problema técnico.