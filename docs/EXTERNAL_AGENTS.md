# Agentes externos en el mapa (Suvadu)

RepoCiv muestra como unidades del mapa a los agentes de IA que trabajan en tus repos
aunque no los haya lanzado RepoCiv: Claude Code en otra terminal, Codex, Cursor,
OpenCode. La fuente es [Suvadu](https://github.com/AppachiTech/suvadu) (`suv`), que
registra esas sesiones localmente vía hooks.

```
suv agent sessions ─┐                      unit_spawn / unit_state / unit_despawn
suv history (agent) ┴─► server/suvadu_tracker.py ──────────────────────────────► mapa
                          (cada ~30 s, argv, sin shell)   GET /api/external-agents
                                                          MCP external_agents_list
```

## Panel de Agentes (F8)

El botón 🤖 del HUD (o **F8**, o la paleta de comandos → "Agentes") abre una lista con
**todos** los agentes, estén o no en un repo que es ciudad de tu mapa:

- **Activos:** sesiones con actividad dentro de la ventana (10 min). También están en el
  mapa.
- **Últimas 24 h:** las mismas sesiones cuando ya quedaron quietas
  (`REPOCIV_EXT_AGENTS_RECENT_H`).
- **Unidades RepoCiv:** las unidades propias. El click abre su panel de unidad/chat de
  siempre.

Cada tarjeta muestra dónde trabaja el agente:
- `📍 <ciudad>` si su repo es una ciudad del mapa;
- `🏛 repociv` si trabaja en RepoCiv mismo, que es la capital;
- `⊘ <repo> · fuera del mapa` si su repo no está en el mapa. En ese caso la unidad espera
  en la capital.

Click en una tarjeta:
- abre el **chat de solo lectura** (prompts y respuestas guardados por Suvadu);
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
`GET /health` → `externalAgents` y las unidades que ya estaban envejecen solas.

## Qué aparece y dónde

| Regla | Detalle |
|---|---|
| Unidad | `ext-<agente>-<native_id[:8]>`, efímera, fuera de la barra de héroes |
| Tipo | `claude-code → claude`, `codex → codex`, resto → `scout` |
| Misión | `<agente> · <modelo>` |
| Ciudad | 1) la ciudad cuyo `repoPath` es el prefijo más largo del `cwd` (por componentes: `repociv-old` no calza con `repociv`); 2) el propio checkout de RepoCiv → la capital (RepoCiv nunca es ciudad: el escaneo lo salta); 3) si no, el repo git que contiene el `cwd`, y el navegador cae a la capital si esa ciudad no está en su mapa; 4) sin repo → capital |
| `working` | última actividad hace ≤ `REPOCIV_EXT_AGENTS_WORKING_MIN` (2 min) |
| `idle` | más vieja que eso pero dentro de la ventana |
| despawn | sin actividad en `REPOCIV_EXT_AGENTS_WINDOW_MIN` (10 min) |

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

Consecuencia: un agente que piensa varios minutos sin ejecutar comandos pasa a `idle`
hasta su próximo comando o fin de turno.

## Privacidad

- **Metadatos, siempre:** los eventos del mapa (SSE/WS), `GET /api/external-agents[/sessions]`
  y la tool MCP llevan solo agente, ciudad/repo, modelo, conteos, primera y última
  actividad. Ni prompts, ni comandos, ni `cwd`.
- **Chat, solo a pedido:** `GET /api/external-agents/<sesión>/chat` (con token) devuelve
  prompts y respuestas cuando abrís el chat en el panel. Solo para sesiones que el tracker
  listó; nunca se difunde por SSE/WS ni se expone por MCP. Los comandos de shell no se
  muestran.
- **Salud:** `/health` (sin token) muestra solo la salud del tracker.

Quien llegue a la UI (tailnet) con el token embebido puede leer esos chats. Es la misma
frontera que ya tenía el resto del bridge.

## Configuración

| Variable | Default | |
|---|---|---|
| `SUVADU_BIN` | `~/.cargo/bin/suv` | ruta al binario |
| `REPOCIV_EXT_AGENTS` | `1` | `0` = no arrancar el tracker |
| `REPOCIV_EXT_AGENTS_WINDOW_MIN` | `10` | ventana de actividad |
| `REPOCIV_EXT_AGENTS_WORKING_MIN` | `2` | umbral working → idle (≤ ventana) |
| `REPOCIV_EXT_AGENTS_POLL_S` | `30` | intervalo de sondeo (mín. 5) |
| `REPOCIV_EXT_AGENTS_RECENT_H` | `24` | cuánto atrás lista el panel de Agentes (≥ ventana) |

## Limitaciones conocidas

- **Misiones de RepoCiv duplicadas.** Los `claude --print` que lanza el propio
  `agent_runner` también pasan por los hooks de Suvadu, así que mientras corren se ven
  dos veces: la unidad de la misión y una `ext-claude-code-*` en la misma ciudad.
  Arreglo propuesto: lanzar esas misiones con `--session-id <uuid>` (hoy usan
  `--continue`) y que el tracker excluya esos ids.
- Codex / Cursor / OpenCode dependen de que su integración de Suvadu registre sesiones;
  solo Claude Code está verificado en esta máquina.
- Suvadu es local: agentes de otras máquinas no aparecen.
- **Largo del chat:** Suvadu guarda hasta ~4 000 caracteres por mensaje (se marca
  "…recortado"). El panel muestra los últimos 80 mensajes.
- **Refresh:** el import a pedido solo existe para Claude Code
  (`~/.claude/projects/*/<id>.jsonl`) y Codex (`~/.codex/sessions/…`).
- **Ids de ciudad:** las ciudades que crea `generateWorld` usan `id = nombre del repo` y
  las que se agregan después usan `id = repo:<base64>`. El cliente resuelve ambas formas
  por `repoPath` (`findCityByRef`).
