# Prompt de apertura — rama `feat/local-view-activity`

> Copiar desde la línea `---` hacia abajo en una sesión nueva de agente, con la rama creada.
> Contexto verificado contra el repo en `1b85f88`. Los datos de la sección "Lo que ya existe"
> son reales, no supuestos — no hace falta redescubrirlos.

---

## Contexto: qué es RepoCiv y qué we're tocando

RepoCiv es un dashboard hexagonal estilo Civilization que visualiza un workspace de
repos como ciudades en un mapa. Single-user, local-first, alpha.

Estamos trabajando en la **Vista Local**: al hacer doble-click en una ciudad (un repo)
se entra a una oficina isométrica 2.5D estilo RimWorld **generada proceduralmente a
partir de la estructura real del repo** — cada sala es una carpeta, cada workbench es un
archivo priorizado por la Priority Matrix.

Contexto para la rama: no estamos en el repo upstream de Hermes, estamos en RepoCiv.
Mapa hexagonal = vista macro (multirepo). Vista local = un repo. Son dos escalas del
mismo mundo; esta rama trabaja **solo** la local.

## El objetivo

Hoy un agente que trabaja en un repo es una unidad que camina a un workbench y se queda
ahí. Eso miente: el agente está haciendo **varias cosas a la vez** — leyendo archivos,
editando, corriendo comandos, delegando en subagentes, revisando. La vista local no
representa nada de eso.

**Queremos que la actividad real del agente sea visible en el piso de la oficina**, sin
dejar de ser legible de un vistazo, y manteniendo el acceso al chat del agente como
siempre (el chat sigue siendo la vía para leer lo que pasa en detalle; la vista local es
la vía para ver *qué clase de cosa* está pasando).

### La idea central: un solo primitivo, dos fidelidades

Tu intuición original tenía dos formas — "subagentes como personajes que trabajan bajo el
manager" y "globos de pensamiento estilo Sims que muestran un símbolo según el
tool-calling". **Son la misma feature en dos fidelidades, y conviene construir una sobre
la otra**:

- **Primitivo único: un overlay de actividad sobre la unidad**, con un **vocabulario de
  glifos**. Cada tool-call se mapea a un glifo + un color. `read_file` → ojo. `edit_file`
  → lápiz. `bash` → engranaje. `web_fetch` → antena. `grep` → lupa. El overlay se
  encadena, así que un agente que lee, edita y testea muestra los tres en rotación, y el
  usuario capta "está en fase de test" sin leer una palabra.
- **El subagente es el caso caro**: cuando el agente delega (Task tool), el subagente
  deja de ser un glifo y se vuelve **una unidad real en el piso**, hija de la unidad
  manager, que camina a su propio workbench. Cuando termina, vuelve a su manager.

Esto te da un primer slice barato y verificable (glifos, un solo agente) antes del
complejo (unidades subagente, paths, ciclo de vida, color). No inviertas el orden.

### El chat en vista local

Segunda mitad: la vista local **hoy no tiene chat** (verificado: cero referencias a chat
en `localWorldManager.ts` / `localRenderer.ts`). Hay que construirlo.

Dirección que querés: el mismo chat de RepoCiv en estructura y datos, pero con una
**presentación distincta** — más empresarial, como la vista de un teléfono donde van
llegando los mensajes. No es un rediseño del chat de RepoCiv: es el mismo origen de
datos con otra skin, porque en vista local el contexto es un solo repo y el chat tiene que
competir por atención con el mapa que está al lado.

## Lo que ya existe (no lo re-descubras, no lo reescribas)

**El dato que hace esto viable: el stream del harness YA trae los tool-calls, y el bridge
los está descartando.** En `server/agent_runner.py:1171`:

```python
# Tool-use events are noise — don't surface them as chat text
if event_type in ("tool_use", "tool_result", "ping", "heartbeat"):
    return ""
```

Eso es una decisión de diseño reasonable para el chat (tool_use no es texto legible) y
**equivocada para la vista local**. El fix es no eliminar el evento del stream, sino
dejar de usarlo como texto de chat y empezar a emitirlo como evento de actividad
estructurado. Es el backend de esta feature y probablemente el cambio más chico y más
importante de toda la rama.

**El modelo de subagentes ya existe y está bien hecho.** `server/subagent_tracker.py`:
- `_tool_use_map: dict[str, str]` mapea `tool_use_id → subagent_id`, o sea ya sabe
  cuándo un tool-call es la resolución de una delegación.
- `map_kind_to_unit_type()` ya traduce el tipo de subagente a tipo de unidad del juego
  (`explore`/`cursor-guide`/`ci-investigator` → `scout`, `shell`/`best-of-n-runner`/
  `generalpurpose` → `worker`). **La tabla de glifos puede colgarse de acá** en vez de
  inventar un vocabulario paralelo.
- Endpoint `GET /subagents` ya expuesto en `server/routes/core.py:264`.

O sea: la Backend **ya tiene el modelo de datos de "varios agentes haciendo varias cosas"**.
Lo que falta es la capa de visualización. Esta feature es más pequeña de lo que parece.

**La FSM de la unidad local ya es extensible.** `LocalUnit` en `src/types.ts` ya tiene
estados (`walking_to_workbench`, trabajando, descansando). `LocalNpc` tiene
`type: 'manager'` con un comentario `// future: receptionist, security` — el concepto de
"personaje con rol" ya está previsto. Los workbench y las salas se derivan de datos reales
del repo, así que un subagente puede tener workbench sin inventar nada.

**Los glifos no son un problema técnico.** `@formkit/auto-animate` ya está en
dependencias, hay un `src/localRenderer/overlays.ts` (97 líneas) donde ya viven overlays,
y hay `particles.ts` para las transiciones. El sistema de overlay ya tiene dónde crecer.

## Cómo trabajar en esta rama

**TDD, como el resto del repo.** El proyecto tiene 1029 tests de vitest y 1205 de
pytest, todos verdes, y un `scripts/check.sh` que es la única fuente de verdad del gate.
Nada entra al trunk con el gate rojo.

**El gate corre con `bash scripts/check.sh`** (tsc, eslint, prettier, vitest+coverage,
vite build, ruff, pytest+coverage, budgets de assets y de bundle). Corrélo antes de dar
cada slice por terminado. `npm run check` es un subconjunto — no alcanza.

**Tests de los dos renderers.** La vista local tiene `src/isoLocalRenderer.ts` (1666
líneas) y `src/localRenderer/` (8 archivos). Averiguá cuál está vivo hoy antes de
escribir código: hay renderer de 2D y de 3D y no necesariamente ambos están en uso.
`e2e/local-view.spec.ts` y `e2e/local-view-memory.spec.ts` existen y hoy solo assertan
que renderiza y que no hay errores JS.

**Presupuesto de bundle.** El gate exige que el JS eager se quede en **≤185KB gzip** y
que Three.js siga siendo lazy (nunca en el bundle eager del modo 2D — ya hubo una
regresión de eso). Si los glifos son SVG/CSS, entran casi gratis. Si los dibujás en
canvas, cuidá el presupuesto. No rompas este gate: es la mitad de lo que hace que la app
ruede rápido.

**No toques la vista macro.** Esta rama es de la vista local. Si encontrás que algo hay que
cambiar en el mapa hexagonal o en el bridge para que esto funcione, es una señal de que
estamos tocando la frontera equivocada — anotá la necesidad y seguí, o cortá y preguntá.

## Secuencia sugerida

Hacé el primer slice **end-to-end y verificable**, no una capa de fundación. El orden
por ratio de valor a esfuerzo:

1. **El verbo de debugging, no la feature completa**: en vez de "un sistema de glifos",
   hacé "un solo glifo hardcodeado que se enciende cuando llega *cualquier* tool_use y se
   apaga 1.5s después". Eso obliga a todo el camino: emitir el evento desde el bridge,
   transportarlo, recibirlo en el cliente, y dibujarlo. Verificá que se ve. Es el slice
   que prueba que la idea es viable, y vale más que un diseño correcto no testeado.
2. **El vocabulario de glifos**: tabla `tool_name → glifo/color`, con un fallback
   honesto para tools desconocidos (no inventar un glifo por cada tool que veas — la
   lista es abierta y se va a desincronizar).
3. **El chat de vista local**, con la presentación "teléfono". Es independiente de los
   glifos: se puede hacer en paralelo y no bloquea.
4. **Los subagentes como unidades**, que es el 20% del valor y el 80% de la complejidad
   (ciclo de vida, paths, si puede spawn, telemetría de subagente, qué pasa si el padre
   muere).

Cada slice: tests, gate verde, y una línea en `docs/` si cambia algo que otro necesita
saber.

## Fuera de scope para esta rama

- **No partas el proyecto todavía.** Ver la sección "Scope" más abajo — hay un veredicto y
  no es el que quizás esperás.
- No agregues panel nuevo al HUD macro.
- No rediseñes la Vista Local en general (renderers, layout, isométrica) — solo agregale
  una capa de actividad encima.
- No reescribas `localMap.ts` ni `isoLocalRenderer.ts`. Son archivos grandes (1397 y 1666
  líneas) y mezclan responsabilidades, pero refactorizarlos es un PR aparte, no este.
  Si necesitás tocar algo grande, preferí el módulo nuevo y un import.
- No agregues features agentivas por default. El repo tiene un principio explícito de
  opt-in: nada que sugiera, analice o automatice arranca activo.

## Un aviso de la auditoría reciente

La última auditoría encontró que **la API de dev no es la API de producción**:
`vite-plugins/repociv.ts` sirve 6 endpoints que no existen en el bridge, y toda la suite
e2e corre contra `npm run dev`. Si vas a testear esta feature e2e, sabé que estás
probando el dev, no producción. Para el slice 1 el test unitario con un stream de eventos
falso es más rápido y más confiable que un e2e — empezá por ahí.

---

## Pregunta abierta que la rama debe responder

*"¿Es la Vista Local un proyecto con identidad propia?"*

Mi lectura, para que la contrastes: **rama propia ahora, scope doc propio ahora, proyecto
separado más adelante — y solo si aparece una de estas señales:** que la vista local
necesite correr sin el mapa macro; que necesite un contrato de datos propio que no sea el
del bridge; o que tenga un segundo consumidor.

Ninguna de las tres es cierta hoy: la vista local consume datos del bridge de RepoCiv
(`/subagents`, unidades, misiones), y separarse ahora significaría mantener dos bridges o
un contrato nuevo entre ellos — que es exactamente el problema de divergencia dev/prod
que acabamos de auditar, pero replicado en un repo nuevo.

Lo que sí vale hacer desde el día uno: que esta rama tenga **su propio documento de scope**
(`docs/SCOPE.local-view.md`) que diga qué es la vista local y qué no, exactamente como
`SCOPE.md` lo hace para el repo. Es la versión barata de la separación y te da el
beneficio principal — un lugar donde decir "esto es de la vista local, esto no" — sin el
costo de dos proyectos.

Cuando termines el slice 1, decime si el verbo de debugging se sintió bien y ahí
decidimos con datos si el paso 4 (subagentes como unidades) vale el costo, o si los
glifos solos ya cumplen la fantasía.
