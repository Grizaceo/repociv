# RepoCiv — Plan de utilidad: senior + novato (ambos conocedores de Civ V)

> Fecha: 2026-06-20. Basado en evaluación de la **UI real** (capturas vía
> kimi-webbridge sobre Chrome con GPU: modo 2D `flat` por defecto y 3D
> `?renderer=webgl`) + el audit `docs/AUDIT_2026-06-19.md`.
> Dirección acordada con el owner: subir **utilidad** sin romper scope, robándole
> a Civ V su **disclosure progresivo** (no solo su estética).

---

## Lo que se observó en la UI real (evidencia, no intuición)

- **Modo 2D (default):** mapa hex legible de lejos pero **saturado de labels de
  ciudad** (pills negras pequeñas, se solapan) — es un muro de texto al primer
  vistazo. HUD chico relativo al mapa.
- **Modo 3D (`webgl`):** se ve **notablemente más Civ V** — relieve, bosques,
  ciudades 3D sobre plazas de piedra, hora dorada. Vende la metáfora mucho mejor
  que el 2D. *El producto se subvende al arrancar en 2D.*
- **HUD denso:** 23 botones visibles + leyenda de ~12 hotkeys siempre en pantalla
  (`Q/W/E/L/O/C/X` spawn, `1-9` selección, `ENTER` chat, `H` capas, `F6` gran
  libro, `F9` quests, `F10` crónica, `A` aprobaciones, `?` ayuda).
- **Spawn = 7 tipos de agente** (DAVI, Worker, Scout, LexO, OpenClaw, Claude,
  Codex) en 7 hotkeys. ⚠️ *DAVI/LexO aparecen en el build corriendo pese a que
  el commit `55b9dc0` los "removió de la superficie shipped" — confirmar si es
  drift o build viejo (ver D1).*
- **Barra de recursos:** oro/ciencia/industria (gamificados, **no** métricas
  reales de agentes) + VRAM/GPU temp (reales) + estado del bridge + GACETA
  (widget de noticias, badge "99+").
- **Sin guía al cargar:** ningún panel de unidad seleccionada ni onboarding
  visible → el novato no tiene un "¿y ahora qué?".

---

## Nota honesta (con la UI ya vista): **7.5 → 7.5/10**, pero el desglose cambia

| Dimensión | Antes (solo código) | Con UI real | Nota |
|---|---|---|---|
| Estética / metáfora | "fuerte" | Confirmada en 3D; el 2D la diluye | A− (3D) / B− (2D default) |
| Claridad de producto / UX | C+ | Confirmada: 23 botones + 12 hotkeys sin jerarquía, sin on-ramp | C+ |
| Densidad para senior | — | Buena base (todo por teclado) pero plana | B |
| Primera impresión novato | — | Sobrecargada; 3D escondido detrás de un opt-in | C |

El nudo sigue igual: **ingeniería 9, producto 6**. La UI confirma que el problema
no es falta de features sino **falta de jerarquía y de pedagogía**.

---

## Plan — 4 fases, ordenadas por palanca

### Fase A — Medición primero (gate de toda poda) · esfuerzo M
Sin datos, cada decisión de UI es opinión. Ya existe `_trackLayerToggle()`
(`src/ui/layers.ts`) y `server/endpoint_usage.py`.

- **A1.** Extender el tracking a **todos** los toggles de panel + hotkeys (un
  `trackPanelOpen(id)` único que registre `{id, ts}` en `localStorage` y, opcional,
  POST a `/metrics`). 
- **A2.** Un mini-panel "Uso" (dev-only) que liste paneles/endpoints con **0
  invocaciones en N días** → alimenta el roadmap de poda del SCOPE.
- **Entrega:** datos para saber qué **profundizar** (senior) y qué **esconder**
  (novato). Prerequisito de B1 y de la poda de los ~21 paneles.

### Fase B — On-ramp del novato (disclosure progresivo estilo Civ V) · esfuerzo M-L
- **B1. Modo Quick vs Advanced** (como el setup de partida de Civ V).
  Default **Quick**: solo el núcleo visible — spawn de agente, chat, aprobaciones,
  capas. El resto de la botonera (replay, observabilidad, pendientes, log,
  asignación, crónica, quests, gran libro…) detrás de un "Avanzado / ⋯".
  Persistir la elección. *Es la palanca #1 contra la saturación observada.*
- **B2. Tour guiado de primer arranque** (`src/ui/onboardingPanel.ts` ya existe,
  626 LOC). 4 coachmarks: "esta ciudad = tu repo → seleccionala → mandá un agente
  (Q) → mirá el resultado en el chat". Civ V tiene asesor; esto es su equivalente.
- **B3. Tooltips que enseñan, no que describen.** Hover en unidad → "Agente
  WORKER: stateless, hace tareas puntuales" en vez de jerga (`Tensor Context`,
  `SICA`, `FrugalGPT`).
- **B4. Legibilidad 2D** — declutter de labels: colapsar/clusterizar a bajo zoom,
  revelar al hover/zoom (resuelve el muro de pills observado). Toca
  `src/renderer.ts` (draw de labels) + LOD ya existente.
- **B5. Primera impresión** — *decisión del owner:* ¿default a 3D (vende mejor)
  o un chooser 2D/3D de una sola vez en el primer arranque? Respeta el invariante
  de switching (ya blindado por `renderMode.test.ts`).

### Fase C — Densidad para el senior · esfuerzo M
- **C1. Command palette (`Ctrl-K`)** — spawnear / asignar misión / aprobar /
  saltar a ciudad / cambiar 2D-3D sin cazar botones. Es el "next turn" de Civ V
  traducido a velocidad operativa. Reusa `src/commandBus.ts` + el registro de
  hotkeys (`src/ui/hudWiring/hotkeys.ts`).
- **C2. Promover el MCP server (43 tools) a feature de primera clase.** Manejar
  RepoCiv desde otra ventana de Claude/Cursor/Codex es el verdadero superpoder del
  senior y hoy está enterrado en `docs/MCP.md`. Añadir: recetas en el README +
  un indicador visible "MCP conectado" en el HUD.
- **C3. Telemetría operativa real** (distinta del oro/ciencia/industria
  cosmético): tokens gastados, latencia, profundidad de cola, tasa de aprobación.
  El bridge ya expone `metrics_snapshot`. Es el "score/great works" de Civ V pero
  **accionable**.

### Fase D — Limpieza y coherencia · esfuerzo S
- **D1.** Reconciliar el roster: DAVI/LexO aparecen en el spawn cluster pese al
  commit que los removió de la superficie shipped → confirmar build/intención.
- **D2.** GACETA (noticias, "99+"): ¿se gana el espacio? Lo decide la telemetría (A).
- **D3.** Conectar la salida de telemetría (A2) al **roadmap de poda** del SCOPE
  (Replay/Observability/Quest/Recovery/Harness/Timeline son los sospechosos).

---

## Secuencia recomendada

1. **A1+A2** (medición) — desbloquea decisiones basadas en datos.
2. **B1** (Quick/Advanced) + **C1** (command palette) — el par de mayor impacto:
   el novato ve menos, el senior hace más, ambos con el mismo cambio de jerarquía.
3. **B2+B3+B4** (tour, tooltips, legibilidad 2D) — pulido del on-ramp.
4. **C2+C3** (MCP first-class, telemetría real) — profundidad para el senior.
5. **D** + poda informada por A2.

## Por qué esto sube la nota
Civ V es profundo para expertos *y* abordable para novatos por **disclosure
progresivo** (barra de recursos, asesor, tooltips on-hover, city screen on-demand,
tech tree que revela complejidad de a poco). RepoCiv copió la estética; este plan
copia la **pedagogía**: medir (A) → esconder lo que el novato no necesita y
revelar bajo demanda (B) → dar densidad de teclado y observabilidad real al senior
(C). Sin tocar el scope ni reescribir capas.
