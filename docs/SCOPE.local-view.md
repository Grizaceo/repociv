# Vista Local — Scope

> **La Vista Local tiene su propio documento de scope.** El repo tiene uno
> (`SCOPE.md`) y aplica la misma regla: si una propuesta no encaja con lo que
> dice este documento, no entra. Mantenerlo honesto importa más que hacerlo
> aspiracional.
>
> Pregunta abierta: **¿es la Vista Local un proyecto con identidad propia?** La
> respuesta vigente es *rama propia ahora, scope propio ahora, proyecto
> separado más adelante — y solo si aparece una señal*. Ver §"Proyecto
> propio" abajo.

---

## Qué es la Vista Local

Una oficina isométrica 2.5D estilo RimWorld, **generada proceduralmente a
partir de la estructura real de un repo**: cada sala es una carpeta, cada
workbench es un archivo priorizado por la Priority Matrix. Se entra con
doble-click en una ciudad del mapa hexagonal.

Son **dos escalas del mismo mundo**:

| | Vista macro (mapa hexagonal) | Vista local (oficina) |
|---|---|---|
| Unidad de análisis | el workspace: N repos | un repo |
| Render | Three.js (`?renderer=webgl`) o 2D | 2D canvas isométrico (`isoLocalRenderer.ts`) |
| Objeto en pantalla | ciudad | sala, workbench, agente |
| Ver `SCOPE.md` | sí | este documento |

La Vista Local **no** puede correr sin el mapa macro: consume datos del
bridge de RepoCiv (`/subagents`, unidades, misiones, workbenches) y comparte
transporte, auth y ledger con él. Esa es la razón por la que hoy es una
rama, no un proyecto.

---

## Lo que **sí** está en scope

- **Capa de actividad sobre la unidad.** La actividad real del agente —leer,
  editar, correr comandos, delegar— es visible en el piso de la oficina. El
  chat sigue siendo la vía para leer *qué* pasó en detalle; la vista local es
  la vía para ver *qué clase de cosa* está pasando, de un vistazo.
  - Un solo primitivo: un overlay transitorio con un vocabulario de glifos.
    Cada tool-call → glifo + color. El overlay se encadena: un agente que
    lee, edita y testea muestra los tres en rotación.
  - El subagente es el caso caro: cuando el agente delega, el subagente deja
    de ser un glifo y se vuelve una unidad real en el piso, hija de la unidad
  manager, que camina a su propio workbench y vuelve al terminar.
- **Chat de vista local**, con los mismos datos que el chat de RepoCiv pero
  con presentación distincta (más empresarial, tipo vista de teléfono). No es
  un rediseño del chat de RepoCiv: es el mismo origen de datos con otra skin,
  porque en vista local el contexto es un repo solo y el chat tiene que
  competir por atención con el mapa que está al lado.
- Agregar una capa encima de lo que ya existe. Módulos nuevos + un import.

---

## Lo que **no** está en scope

- **Partir el proyecto.** Ver §"Proyecto propio".
- Agregar paneles nuevos al HUD macro.
- Rediseñar la Vista Local en general (renderers, layout, isométrica).
- Refactorizar `localMap.ts` (1397 líneas) o `isoLocalRenderer.ts` (~1670
  líneas). Mezclan responsabilidades, pero eso es un PR aparte.
- **Features agentivas activas por default.** El repo tiene un principio
  explícito de opt-in: nada que sugiera, analice ni automatice arranca activo.
  La capa de actividad *describe*; no interpreta, no propone, no actúa.
- Tocar la vista macro para que la vista local funcione. Si hace falta, es
  señal de que estamos en la frontera equivocada: se anota y se sigue, o se
  corta y se pregunta.

---

## Estado actual (rama `feat/local-view-activity`)

**Slice 1 — "el verbo de debugging": hecho.**

Un solo glifo hardcodeado que se enciende ante *cualquier* `tool_use` del
stream del harness y se apaga 1,5 s después. El objetivo del slice no era la
feature completa sino **forzar todo el camino end-to-end y probarlo**:

```
server/subagent_tracker.py   _handle_tool_activity → emite unit_tool_call
  ↓ (send_to_repociv → fan-out SSE/WS, server/sse_server.py:58)
src/bridgeSchema.ts          esquema Valibot (sin esto el evento se cae en silencio)
src/bridgeMessageHandlers.ts handler → ctx.state.noteUnitActivity
src/game.ts                  → LocalWorldManager.noteUnitActivity
src/localWorldManager.ts     unit.activity = {toolName, at}; decae en tick()
src/localActivity.ts         TTL + seam del glifo (puro, testeado)
src/isoLocalRenderer.ts      dibuja el glifo atenuado por TTL restante
```

El `tool_use` **sigue sin ser texto de chat**. Ese filtro
(`agent_runner._parse_cursor_ndjson_chunk`) es correcto para el chat y no se
toca: la feature solo *agrega* un consumidor del mismo evento de stream.

### Cobertura por harness — leer antes de_demoar

`unit_tool_call` solo lo emiten los harnesses que **traen eventos de tool-call
en el stream**. Hoy son dos, y lo declaran en
`server/mission_harness.py` (`SWARM_CAPABILITIES`):

| Harness | Eventos de tool-call | La actividad se ve |
|---|---|---|
| `claude-code` | sí (`--output-format stream-json`) | **sí** |
| `cursor` | sí (`--output-format stream-json`) | **sí** |
| `hermes` (HTTP) | **no** — `stream: False`, devuelve el texto final | no |
| `hermes-cli` | no (stdout plano) | no |
| `openclaw` / `codex` / `container` | no | no |

**Consecuencia práctica:** con la cascada por defecto
(`hermes → claude-code → openclaw`), una unidad que corre bajo hermes HTTP
**no muestra actividad**. La feature no está rota — está sin datos en ese
harness. Cubrirlo es una decisión abierta, no un bug escondido.

---

### Slice 2 — chat de vista local: hecho

El **mismo transcript** que muestra el side panel, con otra presentación: un
feed angosto tipo teléfono, dockeado a la derecha, que compite por atención con
el mapa que tiene al lado.

Es literalmente el mismo origen de datos con otra skin:

```
server  ──(chat_chunk, igual que siempre)──▶  bridgeMessageHandlers
                                                   │  appendChatChunk
                                                   ▼
                                            chatHistory / chatBuffers   ← única fuente
                                                   │
                              ┌────────────────────┴────────────────────┐
                              ▼                                         ▼
                    side panel (#chat-messages)          #local-chat-feed  ← el feed
                    (src/ui/chat/*)                    (src/ui/localChat/*)
```

- `src/ui/chat/history.ts` gana `subscribeChatChunks()`: un hook de ~10 líneas
  que **notifica** y no escribe. El side panel no se toca ni se redisena.
- `src/ui/localChat/thread.ts` decide qué hilos pertenecen a la oficina y
  **arma el HTML como string puro**. `feed.ts` solo pone ese string en
  `innerHTML` y maneja el scroll.
- Los subagentes quedan fuera del feed a propósito: son efímeros y su salida
  llega por el hilo del padre. Duplicar el hilo mostraría la misma
  conversación dos veces.
- Se monta con `onEnterLocalView` y se desmonta con `onExitLocalView`
  (`src/renderer.ts`), así que nunca queda pegado sobre el mapa macro.

**El HTML del feed es puro a propósito:** este repo no tiene entorno de test
DOM (no hay jsdom, y los 1000+ tests existentes son lógica pura — el DOM se
cubre con Playwright). Armar el markup como datos permite testear la
presentación sin agregar una dependencia; el test e2e cubre el montaje real.

**Testing de esta slice:** 28 tests de `thread.test.ts` (selección de hilos,
slot de streaming vacío, escape de markup del lado usuario) + un caso e2e que
verifica que el feed aparece al entrar a la vista local y desaparece al salir.

---

### Atribución: qué cuerpo se enciende (decidido)

El bridge **no** cambia. `unit_tool_call` sigue llevando `unit` = macro unit, o
sea la semántica de RepoCiv queda intacta: **todo tool-calling se asocia al
agente que trabaja en el repo, tenga o no subagentes.** La vista macro no se
entera de que esta feature existe.

Lo que sí es decisión de la vista local es *a qué cuerpo se le enciende el
pulso*, y vive en un solo lugar:

```
resolveActivityTarget(units, eventUnitId)   ← src/localActivity.ts
```

**Política: se enciende el agente que trabaja en el repo.** Si el evento llega
por `macroUnitId`, se prefiere el no-efímero aunque el delegate aparezca
primero en la lista.

**Por qué los subagentes no tienen pulso propio todavía — y no es una decisión,
es falta de dato.** El stream del harness atribuye toda tool-call a la unidad
padre. Los tool-calls internos de un subagente en background **no llegan como
eventos separados**: vuelven plegados dentro del `tool_result` del Task.
`subagent_tracker._tool_use_map` mapea únicamente el `tool_use_id` **del propio
Task** a su subagente — responde *"de quién es este resultado"*, nunca *"qué
child corrió este tool"*.

Por eso, cuando solo quedan delegates efímeros en la oficina, la función
devuelve `null`: encender un child en nombre del padre sería un reclamo que el
stream no sostiene, y **un pulso que miente es peor que no tener pulso**.

Cuando exista telemetría por hijo, **esta función es lo único que se mueve**.

---

## Proyecto propio: la pregunta abierta

*"¿Es la Vista Local un proyecto con identidad propia?"*

**Respuesta vigente: rama propia ahora, scope propio ahora, proyecto separado
más adelante — y solo si aparece una de estas tres señales:**

1. que la vista local necesite correr sin el mapa macro;
2. que necesite un contrato de datos propio que no sea el del bridge;
3. que tenga un segundo consumidor.

**Ninguna de las tres es cierta hoy.** La vista local consume datos del bridge
de RepoCiv (`/subagents`, unidades, misiones) y separarse ahora significaría
mantener dos bridges o un contrato nuevo entre ellos — que es exactamente el
problema de divergencia dev/prod que la auditoría reciente encontró en
`vite-plugins/repociv.ts`, replicado en un repo nuevo.

Lo que sí se hizo desde el día uno es el documento de scope: la versión barata
de la separación, que da el beneficio principal (un lugar donde decir "esto es
de la vista local, esto no") sin el costo de dos proyectos.

**Para revisitarla:** si la Vista Local alguna vez corre headless, o un cliente
distinto (CLI, panel remoto) consume el mismo modelo, la señal 1 o la 3 está
encendida y esta decisión hay que reabrirla explícitamente.

---

## Dónde tocar

| Necesitás… | Mirá |
|---|---|
| Saber qué renderer dibuja la vista local | `src/isoLocalRenderer.ts` (vivo) — el 3D de `src/three/` es opt-in con `?local3d=1`, apagado por defecto |
| Agregar un dibujo a una unidad | `drawIsoUnit` en `src/isoLocalRenderer.ts:781` (contexto ya traducido a la unidad) |
| Cambiar el pulso o el glifo | `src/localActivity.ts` (puro; el vocabulario por tool va acá en el slice 2) |
| Cambiar la presentación del chat local | `src/ui/localChat/thread.ts` (markup puro) + `src/styles/panels/local-chat.css` |
| Entender de dónde sale el evento | `server/subagent_tracker.py` |
| Agregar un tipo de evento nuevo | `types.ts` (union `BridgeEvent`) + `bridgeSchema.ts` (Valibot) + `bridgeMessageHandlers.ts` (handler). **Los tres**, o el evento se cae en silencio |

Unidades de bridge **no** llegan a `LocalUnit` por eventos genéricos: la única
puerta es `syncSubagentSpawn`. Un overlay nuevo necesita su propio camino
explícito.

**Testing en esta rama:** este repo no tiene entorno DOM en vitest (no hay
jsdom). La regla que se siguió: la lógica y el markup van en funciones puras y
se testean con vitest; el montaje real se cubre con Playwright
(`e2e/local-view.spec.ts`). Si una feature de la vista local necesita
verificar comportamiento DOM con detalle, es una señal de que hay que
extraer más lógica a funciones puras — no de agregar jsdom.
