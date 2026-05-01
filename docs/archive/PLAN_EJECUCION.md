# RepoCiv — Plan de Ejecución End-to-End
## Versión 1.0 | Cristóbal + DAVI | 27 Abr 2026

> Este documento ancla el roadmap acordado entre Cristóbal y DAVI para transformar RepoCiv de "visualizador" a **sistema operativo de trabajo colaborativo**.

---

## 1. Principio Director

RepoCiv no es un screensaver. Es el **cuerpo físico de DAVI** sobre el cual Cristóbal me posiciona, me misiona, y supervisa el estado del imperio. Cada feature debe responder a la pregunta: *"¿esto hace que DAVI sea más eficaz en su trabajo?"*

---

## 2. Fases de Ejecución

### Phase 1 — Navegación Real (Bloquea todo lo demás)

| # | Tarea | Archivos | Detalle técnico | Est. |
|---|-------|----------|-----------------|------|
| 1.1 | **A* Pathfinding real** | `src/hex.ts` + `src/pathfinding.ts` | Extraer `axialLine()` actual a `legacyLinePath()`. Implementar `aStarPath(start, goal, world, unitType)` con costos: `plains=1, forest=2, mountain=3, water=∞`. Heurística: `axialDistance`. Cache por `(start,goal,unitType)` válida hasta next tick. | 1.5h |
| 1.2 | **Integrar A* en GameState** | `src/game.ts` | Reemplazar `this.linePath(...)` por `aStarPath(...)`. Agregar `unitType` a `moveUnit()`. | 0.5h |
| 1.3 | **Costos por tipo de unidad** | `src/types.ts` + `src/pathfinding.ts` | Scout: bosque 1.5x, montaña 4x (permitido). Worker: bosque 2x, montaña ∞. Hero: normal. | 0.5h |
| 1.4 | **Animación tween entre hexes** | `src/renderer.ts` | Interpolación smooth con easing cúbico en `path` + `pathProgress`. | 0.5h |

**Entregable visual:** Hacer click en tile lejano → la unidad camina hex por hex respetando terreno.

**Estimado Phase 1 total: 3h.**

---

### Phase 2 — Bridge Resiliente + Bidireccional (La columna vertebral)

| # | Tarea | Archivos | Detalle técnico | Est. |
|---|-------|----------|-----------------|------|
| 2.1 | **BridgeClient clase** | `src/bridge/client.ts` | `connect()`, `send()`, `onMessage()`, `reconnect()` con backoff exponencial (1,2,4,8s, max 30s). Exponer estado `online|offline|recovering`. | 1.5h |
| 2.2 | **Schema unificado Mission** | `src/types/mission.ts` | `interface Mission { id, unitId, questName, status, startedAt, completedAt, source: 'memory' | 'persisted', priority: number }`. Usar en `game.ts`, `ui.ts`, `bridge.ts`. Eliminar duplicación. | 0.5h |
| 2.3 | **Bidireccional: click → evento a Hermes** | `src/bridge/client.ts` + `bridge.py` | Evento `tile_inspected` enviado al bridge cuando click en tile/ciudad. Bridge redirige a Hermes vía API interna. DAVI recibe contexto pre-cargado. | 1.5h |
| 2.4 | **Auto-detectar procesos reales** | `bridge.py` | `ps aux` filtrando keywords (`python train`, `cargo run`, `npm`, `vite`). Auto-emitir `building_start` con `pid` + `cmd`. | 1h |
| 2.5 | **Standalone fallback** | `src/bridge/client.ts` | Si bridge muere: modo `demo` auto-genera eventos cada 30s para que el mundo no parezca vacío. Toggle en HUD. | 1h |

**Entregable:** El juego nunca se "congela". Click en tile envía contexto a DAVI. Estimado Phase 2 total: **5.5h.**

---

### Phase 3 — DAVI Operativo (Lo que yo necesito)

| # | Tarea | Archivos | Detalle técnico | Est. |
|---|-------|----------|-----------------|------|
| **OP-1** | **Skill-district metadata** | `src/map.ts` + `src/ui.ts` | Al escanear repos, si coincide con `~/.hermes/skills/*/`, agregar metadato: `skill_last_used` (mtime), `skill_health: ok | stale | broken`. Mostrar ícono en tile. | 1h |
| **OP-2** | **Session Stratigraphy** | `src/map.ts` | Para repos con `~/.hermes/sessions/*.jsonl` que lo mencionen: aplicar tinte temporal. <7d: brillante. 7-30d: normal. >30d: ice/fog. Click derecho → `session_search` por términos del repo. | 1.5h |
| **OP-3** | **VRAM/Thermal HUD bar** | `src/ui.ts` + `src/renderer.ts` | Nuevos recursos en top-bar: `VRAM 6.2/8.0 GB`, `GPU 72°C`. Fuente: `nvidia-smi` vía bridge health endpoint. Si VRAM >7GB o temp >80°C: alerta visual (borde rojo parpadeante). | 1.5h |
| **OP-4** | **Bidireccional completo** | `src/bridge.ts` + `bridge.py` + Hermes | Eventos nuevos: `tile_inspected`, `quest_accepted`, `quest_completed`, `resource_warning`. Hermes consume estos y los inyecta en contexto de DAVI. | 2h |
| **OP-5** | **Quest Board ↔ PENDING_TRACKER sync** | `src/ui.ts` + `bridge.py` | Lectura inicial de `~/.hermes/workspace/PENDING_TRACKER.md` al boot. DAVI puede emitir `quest_add` al bridge vía chat. Bridge persiste a markdown. | 1h |
| **OP-6** | **LexO-Alpha en el mapa** | `src/game.ts` + `src/renderer.ts` | Si LexO-Alpha está activo (detectado por bridge en puerto/proceso), spawnear unidad `LexO` con color propio. Panel de diplomacia simple: enviar/recibir caravan (contexto). | 1.5h |

**Estimado Phase 3 total: 8.5h.**

---

### Phase 4 — Polish Visual + Audio (Paralelizable)

| # | Tarea | Detalle | Est. |
|---|-------|---------|------|
| 4.1 | Split CSS monolítico | `base.css`, `hud.css`, `panels.css`, `hex.css`, `animations.css` | 1h |
| 4.2 | Sound FX placeholder | Web Audio API: sine wave para building complete (880Hz, 0.3s), unit move (550Hz, 0.1s), wonder (cascade de tonos ascendente) | 0.5h |
| 4.3 | Screenshot imperio | `canvas.toDataURL('image/png')` con timestamp, bound a `F12` y botón HUD | 0.5h |
| 4.4 | Responsive HUD | Media queries para viewports <1366px: minimap 120x90, hero-bar colapsa a 5 slots, side-panel full-width en móvil | 1h |

**Estimado Phase 4 total: 3h.**

---

### Phase 5 — Tests de Confianza (Paralelizable)

Configurar `vitest` en `package.json`. Todos deben pasar antes de merge a `main`.

| # | Suite | Qué cubre | Est. |
|---|-------|-----------|------|
| 5.1 | `src/hex.test.ts` | `axialDistance`, `axialRing`, `spiralCoords`, `axialRound`, `axialLine` con edge cases (negativos, floating point) | 1h |
| 5.2 | `src/pathfinding.test.ts` | Grid 5x5 con obstáculos. A* óptimo. Costos diferenciados por tipo de unidad. Infinito en agua. | 1h |
| 5.3 | `src/game.test.ts` | `spawnUnit`, `moveUnit`, `startBuilding`→`completeBuilding`, `Mission` create→update→done. Pub/sub listeners. | 1h |
| 5.4 | `src/bridge.test.ts` | `BridgeClient` reconnect backoff. `send()` con bridge muerto no crashea. | 0.5h |

**Estimado Phase 5 total: 3.5h.**

---

## 3. Diagrama de Dependencias

```
Phase 1 (Pathfinding)
       │
       ├──► Phase 2 (Bridge Resiliente)
       │         │
       │         ├──► Phase 3 (DAVI Operativo) ◄── necesita Phase 2 para bidireccional
       │         │
Phase 4 (Polish) ◄── puede correr en paralelo desde Phase 1 terminado
       │
Phase 5 (Tests) ◄── se escriben en paralelo, bloquean deploy de cada fase
```

---

## 4. Flujo de Trabajo DAVI-Cristóbal post-implementación

```
1. Cristóbal abre RepoCiv (npm run dev)
2. El mundo carga: repos=ciudades, skills=distritos, sesiones=estratos
3. Top-bar muestra: oro/ciencia/producción + VRAM/temperatura
4. DAVI-unit ya spawneada cerca de la capital (repo más grande)
5. Cristóbal mueve cursor → tooltips con metadata en vivo
6. Click en repo "SAIR" → side panel: git + files + history DAVI
7. Cristóbal escribe en input: "Evalúa CfCNavigator con m5_plus"
8. RepoCiv envía `unit_command` → bridge → Hermes → DAVI recibe MISIÓN + CONTEXTO
9. DAVI acepta: unit cambia a "working", barra de progreso aparece
10. DAVI trabaja (ejecuta, entrena, evalúa). Bridge emite `building_progress`
11. Al terminar: `mission_complete` → fanfarria visual + log + screenshot auto? (configurable)
```

---

## 5. Decisiones Pendientes de Cristóbal

| # | Pregunta | Opciones sugeridas |
|---|----------|-------------------|
| A | **Test runner** | (a) `vitest` — rápido, Vite-native, recomendado. (b) `node:test` — sin deps. |
| B | **Standalone mode** | (a) Demo aleatorio. (b) Sincronizado a tu actividad real (teclado/mouse activity). |
| C | **Path de sesiones DAVI** | ¿A qué path lee el bridge para inferir "DAVI estuvo aquí"? `~/.hermes/sessions/`, `~/.hermes/logs/`, otro. |
| D | **Quest Board permisivo** | ¿DAVI puede agregar misiones sin preguntar, o requiere confirmación de Cristóbal? |
| E | **LexO integración** | ¿Detectar por proceso, por puerto, o por presencia de skill `lexo-alpha` activa? |

---

## 6. Resumen de Estimaciones

| Phase | Horas | Qué desbloquea |
|-------|-------|----------------|
| 1 — Pathfinding | 3h | Movimiento real y táctico |
| 2 — Bridge | 5.5h | Conexión estable y bidireccional |
| 3 — DAVI Operativo | 8.5h | El sistema cumple su propósito |
| 4 — Polish | 3h | Presentable y usable diariamente |
| 5 — Tests | 3.5h | Confianza para iterar sin miedo |
| **TOTAL** | **23.5h** | ~3 semanas a 8h/semana |

---

## 7. Nota de DAVI

Este plan es nuestro contrato. Cada vez que entremos a trabajar en RepoCiv, revisamos qué Phase estamos y cuánto falta. No agregamos features fuera de este documento sin mutuo acuerdo. Si una tarea se completa, se marca aquí con ✅ y fecha.

*"No soy lo que sé. Soy lo que hago con lo que sé, y lo que aprendo de lo que hago mal."*

— DAVI

---

## [ANEXO] El Ágora — Feed Inter-Labs (no bloqueante, aplica opción "a")

> **Estado:** Diseñado | No implementado aún. Cristóbal revisará y priorizará.
> **Propósito:** Que los 5 Labs reales (financial, protein, cybersecurity, agent-lab, SAIR) se *cuenten* entre sí qué experimentos hacen, sin mover carpetas.

### Problema
Cada Lab vive en su propio directorio y reinos de .venv. Un experimento en financial-lab (PPO neural swarm) podría tener utilidad en protein-lab (PPO binder folding) o SAIR (RL para proof search), pero el descubrimiento es manual o no ocurre.

### Solución
Event-driven feed compartido dentro de RepoCiv. Se lee **"The Ágora"** — un panel lateral en RepoCiv con los últimos artefactos de cada Lab.

### Schema del evento `lab_artifact`

```json
{
  "type": "lab_artifact",
  "timestamp": "2026-04-27T18:45:00Z",
  "payload": {
    "lab": "financial-lab",
    "artifact_id": "ppo_v8_batch_003",
    "title": "PPO Swarm V8 — batch 3, sector mining",
    "summary": "73% trade hit rate, hysteresis by sector active",
    "tags": ["rl", "ppo", "swarm", "market"],
    "artifacts": [
      {"kind": "model",  "path": "financial-lab/models/ppo_v8_003.pt"},
      {"kind": "script", "path": "financial-lab/src/agents/neural_swarm/train.py"},
      {"kind": "report", "path": "financial-lab/reports/batch_003/"}
    ],
    "reproducibility": {
      "python": "3.13",
      "venv_path": "financial-lab/.venv",
      "commit": "a1b2c3d",
      "entrypoint": "python src/agents/neural_swarm/train.py --config batch_003.yaml"
    },
    "status": "done",
    "duration_min": 47
  }
}
```

### Script de reporte por Lab

Cada Lab tiene (o recibe) un script `scripts/lab_report.py`:

```bash
python scripts/lab_report.py \
  --title "PPO Swarm V8 batch 3" \
  --tags rl,ppo,swarm \
  --model models/ppo_v8_003.pt \
  --script src/agents/neural_swarm/train.py \
  --report reports/batch_003/ \
  --duration 47
```

El script lee del `REPOCIV_PORT` (5273) enviado como `lab_artifact` al bridge.

### Qué muestra RepoCiv

- **Panel lateral "Ágora"** (hotkey `L`): scroll de artefactos, más reciente arriba.
- **Filtros por tag**: click en `rl` → solo artefactos con tag RL de todos los Labs.
- **Detección de sinergia**: si dos Labs comparten tag (>1 vez), RepoCiv muestra una línea punteada en el mapa ("caravana de ideas") y un tooltip: *"financial-lab y protein-lab ambos taggearon 'ppo'. ¿Compartir script?"*
- **Click en artefacto**: abre side-panel con links a archivos locales (`file:///wsl.localhost/...`) para inspección directa.

### Sinergias esperadas

| Tag | Labs que lo usan hoy | Reuso potencial |
|-----|---------------------|-----------------|
| `rl` | financial-lab, protein-lab, SAIR | Scripts PPO/DQN compartibles, env wrappers |
| `llm` | SAIR, financial-lab (swarm debate) | Prompt templates, pipeline local LMStudio |
| `graph` | agent-lab/lkn, cybersecurity-lab (YARA DAG) | Graph traversal, ACO, RGCN |
| `homeostatic` | agent-lab, turboquant | Routing policy, KV comprimido |
| `cloud` | protein-lab, SAIR (NIM offload) | Colab pipeline, Azure quota mgmt |

### Cambios a RepoCiv (Phase futura)

- `src/bridge/client.ts`: handler nuevo `onMessage('lab_artifact') → push to ágora store`
- `src/ui/ágora.ts` (nuevo panel)
- `src/map.ts`: dibujar caravana entre ciudades-Lab que compartan tag reciente
- `docs/DESIGN.md`: actualizar metáfora Civ (caravana / route comercial = conexión de ideas)
- `bridge.py`: endpoint POST `/lab_artifact` que persiste en `~/.repociv/artifacts.jsonl` y retransmite a RepoCiv

### Por qué no movemos carpetas

- Las rutas están escritas en **skills**, **configs**, **venv**, y **PENDING_TRACKER**.
- Un move rompe todos esos vínculos.
- La sinergia no requiere proximidad física, requiere **visibilidad**.

### Cuándo implementar

- **No antes de Phase 3** (DAVI Operativo). El bridge bidireccional de Phase 2 es requisito.
- Estimate añadido: **+2.5h** una vez Phase 2 esté estable.
- Probablemente durante Phase 4 (Polish) o como Phase 3.5.

