# Agentes externos en el mapa (Suvadu y Hermes)

RepoCiv muestra como unidades del mapa a los agentes de IA que trabajan en tus repos
aunque no los haya lanzado RepoCiv: Claude Code en otra terminal, Codex, Cursor,
OpenCode y los chats de Hermes. Hay dos fuentes:

- [Suvadu](https://github.com/AppachiTech/suvadu) (`suv`), que registra las sesiones de
  Claude Code, Codex, Cursor… localmente vía hooks;
- los `state.db` de Hermes (`~/.hermes/state.db` y uno por perfil), leídos en solo
  lectura. Suvadu no tiene integración para Hermes, y Hermes ejecuta sus tools sin hooks
  de shell. Ver [Hermes](#hermes).

```
suv agent sessions ─┐
suv history (agent) ┤                                 unit_spawn / unit_state / unit_despawn
~/.hermes/**/state.db ┴─► server/suvadu_tracker.py ──────────────────────────────────► mapa
  (server/hermes_sessions.py)  (cada ~30 s)           GET /api/external-agents
                                                      MCP external_agents_list
```

## Panel de Agentes (F8)

El botón 🤖 del HUD (o **F8**, o la paleta de comandos → "Agentes") abre una lista con
**todos** los agentes, estén o no en un repo que es ciudad de tu mapa:

- **Activos:** sesiones con actividad dentro de la ventana (10 min). También están en el
  mapa.
- **Últimas 24 h:** las mismas sesiones cuando ya quedaron quietas
  (`REPOCIV_EXT_AGENTS_RECENT_H`).
- **Cron (Hermes)** y **Gateway (Hermes)**: tareas programadas y chats de Telegram / API
  de Hermes. Solo se listan aquí, nunca en el mapa. Vienen plegadas; el título dice
  cuántas hay activas.
- **Unidades RepoCiv:** las unidades propias. El click abre su panel de unidad/chat de
  siempre.

Las sesiones que conviene no interrumpir llevan un distintivo: **trabajando**
(usó una herramienta recién) o **pensando…** (su proceso sigue vivo pero quedó
callado). Ver [Vivo o callado](#vivo-o-callado).

Cada tarjeta muestra dónde trabaja el agente:
- `📍 <ciudad>` si su repo es una ciudad del mapa;
- `🏛 repociv` si trabaja en RepoCiv mismo, que es la capital;
- `⊘ <repo> · fuera del mapa` si su repo no está en el mapa. En ese caso la unidad espera
  en la capital.

Click en una tarjeta:
- abre el **chat de solo lectura** (prompts y respuestas guardados por Suvadu o por
  Hermes);
- lleva la cámara a su unidad, o a su ciudad si la sesión ya no está activa.

En el chat, ↻ pide a Suvadu reimportar el transcript nativo (`suv agent import-session`,
incremental), porque Suvadu por sí solo lo hace recién al terminar cada turno. Abrir el
chat de una sesión activa lo hace una vez automáticamente.

Click sobre una unidad `ext-*` en el mapa abre su chat en este panel. Antes abría el panel
de unidad de RepoCiv, con un compositor de misiones que no tiene sentido para un agente
ajeno.

## Requisitos

- `suv` instalado (`cargo install suvadu`) y con los hooks del agente:
  `suv init claude-code`, `suv init codex`, `suv init cursor`… `suv doctor` debe pasar.
- El bridge busca el binario en `SUVADU_BIN` (default `~/.cargo/bin/suv`); no depende del `PATH`.

Si `suv` falta o falla, no se rompe nada: el tracker reporta el código de error en
`GET /health` → `externalAgents` y las unidades que ya estaban envejecen solas. Cada fuente
tiene su propio estado en `externalAgents.sources.{suvadu,hermes}`; `ok` es verdadero solo
si todas funcionaron y `error` es el código de la primera que falló.

## Qué aparece y dónde

| Regla | Detalle |
|---|---|
| Unidad | `ext-<agente>-<native_id[:8]>` (Hermes: `ext-hermes-<hash8>`), efímera, fuera de la barra de héroes |
| Tipo | `claude-code → claude`, `codex → codex`, Hermes → `hero` (perfiles `lexo*` → `lexo`), resto → `scout` |
| Misión | `<agente> · <modelo>` (Hermes: `<perfil> · <modelo> · <origen>`) |
| Ciudad | 1) la ciudad cuyo `repoPath` es el prefijo más largo del `cwd` (por componentes: `repociv-old` no calza con `repociv`); 2) el propio checkout de RepoCiv → la capital (RepoCiv nunca es ciudad: el escaneo lo salta); 3) si no, el repo git que contiene el `cwd`, y el navegador cae a la capital si esa ciudad no está en su mapa; 4) sin repo → capital |
| `working` | última actividad hace ≤ `REPOCIV_EXT_AGENTS_WORKING_MIN` (2 min) |
| `thinking` | más vieja que eso, pero **un proceso sigue sosteniendo la sesión** (ver [Vivo o callado](#vivo-o-callado)) |
| `idle` | más vieja que eso y nada la sostiene |
| despawn | sin actividad en `REPOCIV_EXT_AGENTS_WINDOW_MIN` (10 min), o Hermes cerró la sesión |

Los repos candidatos del paso 1 son los `selectedRepoPaths` de
`~/.local/state/repociv/state.json` (lo que elegiste en el onboarding). El paso 3 cubre
el caso en que el navegador tenga otra selección guardada en `localStorage`.

Los eventos no se repiten entre ciclos: un spawn por sesión y un `unit_state` solo
cuando cambia. Como SSE/WS no reenvía eventos pasados, el cliente pide
`GET /api/external-agents` en cada (re)conexión y reconcilia (`src/externalAgents.ts`).
Los cambios de estado de unidades `ext-*` no tocan el ticker global de operación.

### Por qué dos fuentes

`suv agent sessions` solo reimporta una sesión de Claude Code en
`UserPromptSubmit` / `Stop` / `SessionEnd`. Durante un turno largo su
`last_activity_at` se congela, y una sesión nueva no aparece hasta que termina su
primer turno. Los comandos, en cambio, se registran en vivo (hook `PostToolUse`) con
el mismo id de sesión (`claude-<native_id>`), así que `suv history --executor agent`
sirve de latido. Del historial solo se leen `session_id`, `executor`, `cwd` y
`started_at`; el texto del comando nunca se lee ni se guarda.

Consecuencia: un agente que piensa varios minutos sin ejecutar comandos deja de
emitir latido hasta su próximo comando o fin de turno.

### Vivo o callado

Ese reloj congelado mentía justo cuando más importa: decía `idle` —«escribile»—
mientras el agente estaba en plena tarea. `server/session_liveness.py` responde
una pregunta distinta y verificable: *¿queda un proceso sosteniendo esta sesión?*

| Fuente | Señal | Fuerza |
|---|---|---|
| Hermes | `~/.hermes/runtime/active_sessions.json`: el arriendo que Hermes usa para que dos procesos no escriban una sesión, con su `pid` | exacta (id de sesión ↔ pid, revalidando que el pid siga siendo un proceso `hermes`) |
| Suvadu (Claude Code, Codex, Cursor…) | escaneo de `/proc`: binarios de agente y su `cwd` | aproximada: no distingue dos sesiones en el mismo directorio |

Sin actividad fresca pero con proceso vivo, el estado es `thinking`, y el panel
dice «pensando…». Es deliberadamente ambiguo: **puede estar razonando o
esperando tu respuesta en su terminal**, y el bridge no puede distinguirlo. Las
dos lecturas llevan al mismo consejo, que es el punto: no le dispares un mensaje
a ciegas.

El sesgo del escaneo de `/proc` es hacia «vivo» a propósito — un falso «ocupado»
cuesta una espera, un falso `idle` interrumpe a un agente trabajando. Solo lee
pids, nombres de binario y directorios: ningún prompt, comando ni transcript.
Sin `/proc` (fuera de Linux) no hay lectura y los estados vuelven a depender solo
de los timestamps, como antes.

Dos límites conocidos: el mapa no habla `thinking` (su vocabulario de unidades es
`working`/`idle`, así que ahí una sesión pensando se ve trabajando), y pasada la
ventana una sesión se lee `inactive` aunque su proceso siga vivo — que es también
cuando su unidad deja el mapa.

### Misiones de RepoCiv (sin duplicados)

Los `claude --print` que lanza el propio `agent_runner` también pasan por los hooks de
Suvadu. Para que no aparezcan dos veces (la unidad de la misión y una
`ext-claude-code-*` al lado), cada misión corre con un id de sesión explícito
(`server/claude_sessions.py`, estado en `~/.repociv/claude-sessions.json`):

- una unidad *stateful* retoma su propio hilo por (unidad, ciudad) con
  `--resume <id>`, o abre uno con `--session-id <uuid>` si no hay transcript;
- una misión *stateless* usa un `--session-id` nuevo cada vez.

El tracker descarta esos ids y a sus subagentes. Antes se usaba `--continue`, que
retoma la conversación más reciente del directorio y podía ser una sesión tuya.

## Hermes

`server/hermes_sessions.py` lee `~/.hermes/state.db` (perfil `default`) y
`~/.hermes/profiles/*/state.db`. El archivo raíz pesa ~7 GB y Hermes escribe en él
todo el tiempo, así que:

- **Solo lectura:** cada conexión es `file:…?mode=ro`, con `busy_timeout` de 0,5 s,
  `PRAGMA query_only` y un plazo de 2 s por base (3 s para el chat) vía progress handler.
  Nunca escribe, ni hace VACUUM, checkpoint o rebuild de FTS.
- **Sin transacciones colgadas:** cada sondeo abre la conexión, consulta y la cierra.
- **Consultas acotadas:** la lista usa `idx_sessions_effective_activity`
  (`WHERE COALESCE(last_activity_at, started_at) >= ?`, con esa expresión textual para
  que el planner use el índice) y `LIMIT 200` por base. Los padres se buscan por clave
  primaria y el último mensaje por `idx_messages_session`. Medido el 2026-09-19 con 29
  bases: ~25 ms por sondeo en total, ~1 ms por chat.

| Origen (`sessions.source`) | Dónde |
|---|---|
| `cli`, `desktop`, `tui`, `hermes_browser`, `kanban`, `subagent` | mapa + Activos |
| `cron` | solo panel, sección Cron |
| cualquier otro (`telegram`, `discord`, `api_server`…) | solo panel, sección Gateway |
| `tool` (misiones de RepoCiv) | nunca |

Un subagente va a la sección de la sesión que lo lanzó: un subagente de un cron queda
en Cron.

- **Actividad:** se mide con `last_activity_at` (Hermes lo actualiza aprox. una vez por
  minuto) o con el último mensaje, lo que sea más reciente. Nunca con
  `ended_at IS NULL`: cientos de sesiones quedaron sin cerrar. Si Hermes cerró la sesión
  (`ended_at` posterior a la última actividad), la unidad sale del mapa en el siguiente
  sondeo.
- **Compresión:** cuando Hermes comprime una conversación larga, cierra la sesión con
  `end_reason='compression'` y sigue en una sesión hija. Toda la cadena conserva una sola
  unidad (el id sale de la primera sesión), y su chat se lee a través de la cadena. Un
  subagente (`source='subagent'`) no es una continuación: tiene su propia unidad y la
  etiqueta "subagente".
- **Ciudad:** `git_repo_root` si existe; si no, `cwd`. Con la regla de siempre
  (`city_for`). Las sesiones de desktop suelen no tener `cwd`, así que caen en la
  capital.
- **Sin duplicados:**
  - Las misiones Hermes que lanza RepoCiv (`hermes chat … --source tool`) ya tienen su
    unidad. Se excluyen por `source='tool'` y por los ids de
    `~/.repociv/hermes-sessions.json`. También sus subagentes.
  - Mientras la fuente Hermes funcione y lea el perfil `lexo-alpha`, el detector de LexO
    por `ps` (`process_scanner.detect_lexo`) no crea unidades `LEXO-*` y retira las que
    había. Si la fuente falla, el detector vuelve a funcionar solo.
  - Las sesiones con `hidden=1` no se muestran.
- **Chat:** turnos `user` y `assistant`, de hasta 4 000 caracteres cada uno. De las tools
  solo se muestran los nombres ("🔧 terminal ×3 · read_file"): el SQL nunca selecciona la
  salida de una tool ni sus argumentos. Se omite lo que Hermes tampoco muestra
  (`display_kind` no nulo, mensajes inactivos) y el resumen de compactación. El título
  de la sesión sale del contenido, así que viaja solo con el chat.

## Privacidad

- **Metadatos, siempre:** los eventos del mapa (SSE/WS), `GET /api/external-agents[/sessions]`
  y la tool MCP llevan solo agente, perfil, origen, ciudad/repo, modelo, conteos, primera
  y última actividad. Ni prompts, ni comandos, ni títulos, ni `cwd`.
- **Chat, solo a pedido:** `GET /api/external-agents/<sesión>/chat` (con token) devuelve
  prompts y respuestas cuando abrís el chat en el panel. Solo para sesiones que el tracker
  listó; nunca se difunde por SSE/WS ni se expone por MCP. Ni los comandos de shell ni la
  salida de las tools se muestran.
- **Salud:** `/health` (sin token) muestra solo la salud del tracker.

Quien llegue a la UI (tailnet) con el token embebido puede leer esos chats. Es la misma
frontera que ya tenía el resto del bridge.

## Configuración

| Variable | Default | |
|---|---|---|
| `SUVADU_BIN` | `~/.cargo/bin/suv` | ruta al binario |
| `REPOCIV_EXT_AGENTS` | `1` | `0` = no arrancar el tracker |
| `REPOCIV_EXT_AGENTS_WINDOW_MIN` | `10` | ventana de actividad |
| `REPOCIV_EXT_AGENTS_WORKING_MIN` | `2` | umbral working → thinking/idle (≤ ventana) |
| `REPOCIV_EXT_AGENTS_POLL_S` | `30` | intervalo de sondeo (mín. 5) |
| `REPOCIV_EXT_AGENTS_RECENT_H` | `24` | cuánto atrás lista el panel de Agentes (≥ ventana) |
| `REPOCIV_HERMES_SESSIONS` | `1` | `0` = no leer los `state.db` de Hermes |
| `REPOCIV_HERMES_HOME` | `~/.hermes` | raíz de Hermes (`state.db`, `profiles/*/state.db`) |
| `REPOCIV_HERMES_PROFILES_EXCLUDE` | — | perfiles a ignorar, separados por comas (`default` es la raíz) |

## Limitaciones conocidas

- Codex / Cursor / OpenCode dependen de que su integración de Suvadu registre sesiones;
  solo Claude Code está verificado en esta máquina.
- Suvadu y Hermes son locales: agentes de otras máquinas no aparecen.
- **Hermes en vivo:** `last_activity_at` se actualiza aprox. una vez por minuto, pero el
  último mensaje se lee en cada sondeo, así que una sesión nueva aparece en ≤ 30 s
  apenas escribe su primer mensaje.
- **Largo del chat:** Suvadu guarda hasta ~4 000 caracteres por mensaje (se marca
  "…recortado"). El panel muestra los últimos 80 mensajes.
- **Refresh:** el import a pedido solo existe para Claude Code
  (`~/.claude/projects/*/<id>.jsonl`) y Codex (`~/.codex/sessions/…`).
- **Ids de ciudad:** las ciudades que crea `generateWorld` usan `id = nombre del repo` y
  las que se agregan después usan `id = repo:<base64>`. El cliente resuelve ambas formas
  por `repoPath` (`findCityByRef`).
