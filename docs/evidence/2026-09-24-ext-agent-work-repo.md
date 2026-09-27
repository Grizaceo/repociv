# Evidencia: el agente va al repo donde trabaja ahora

**Fecha**: 2026-09-24
**Rama**: `fix/ext-agent-work-repo`
**Base**: `main` @ `53df8b3`
**Método**: TDD (tests primero, rojos por la razón correcta), verificación
contra la `~/.hermes` real y E2E con un bridge de la rama en `:5374`.

## Síntoma

Un Hermes CLI trabajando en `ACTIVE/discord-music-bot` (una ciudad del mapa)
aparecía junto a la **capital**. Además, el panel listaba la misma sesión
varias veces (`-1`, `-2`, `-3`): `job-search-cristobal` tres veces, `.hermes`
dos veces, más clones «sin repo».

## Causas

1. **El `cwd` de arranque le ganaba a la actividad.** Esa sesión se lanzó desde
   `~` (`sessions.cwd = /home/gris96`). Con `cwd` presente, `_observe_multi` ni
   miraba los tool calls, y `city_for("/home/gris96")` → capital. Sus 30+ tool
   calls apuntaban a `discord-music-bot`.
2. **53df8b3 contaba carpetas, no repos.** `_work_repo` devolvía la propia
   carpeta cuando no había `.git`: cada subcarpeta de una ciudad sin git era un
   «repo» aparte (→ clones en la misma ciudad), y `~` o `/tmp` también (→ clones
   «sin repo» en la capital). Los índices `-N` además cambiaban de orden entre
   polls y entre sesiones de una misma cadena de compresión.

## Decisión del usuario

«Una unidad, repo actual»: cada sesión es **una** unidad, en el repo donde
trabaja ahora; si cambia de repo, se muda. Reemplaza los clones de 53df8b3.

## Fix

| Pieza | Dónde | Qué hace |
|---|---|---|
| `Observation.work_dirs` | `server/suvadu_tracker.py` | Carpetas que tocó la actividad reciente, la más nueva primero, una por mención |
| `_work_dirs(conn, chain)` | `server/hermes_sessions.py` | Las extrae de las últimas 60 tool calls (`path`/`workdir`/`cd`) de **toda la cadena de compresión**, siempre (tenga o no `cwd`) |
| `work_place(path)` | `server/suvadu_tracker.py` | Repo de una carpeta con las reglas de `city_for`, salvo que fuera de todo repo devuelve `None` (no «capital») y un repo oculto solo reclama su raíz |
| `busiest(...)` | idem | Gana el repo con más menciones entre las últimas 12 (mínimo 3); empate → el más reciente. Si nadie llega, decide el `cwd` como siempre |
| memo por sesión | `_Rows.work_dirs` | Reusa las carpetas mientras `(message_count, tool_call_count, last_activity_at)` no cambie. Hermes sube `message_count` en cada inserción (verificado: 60 = 60, 120 = 120, 320 = 320 en la base real) |
| reconexión | `src/externalAgents.ts` | `externalAgentEvents` recibe unidades + ciudades y muda (despawn + spawn) las `ext-*` que cambiaron de ciudad mientras el navegador no escuchaba. `cityForRef` es la misma resolución que usa el handler de `unit_spawn` |

## TDD

Rojos primero, por la razón correcta:

- `test_activity_beats_a_launch_cwd_outside_any_repo` → `['capital'] == [beta]`
- `test_one_unit_where_the_session_works_now` → unidad en alpha + clon
- `test_folders_without_git_count_toward_their_city` → `['capital']`
- `test_the_unit_follows_the_session_to_its_next_repo` → clon que queda en alpha
- `test_a_child_fresh_from_compression_stays_in_its_repo` → `'capital'`
- `test_work_place_counts_only_folders_inside_a_repo` (tracker)
- Frontend: 3 tests de `externalAgentEvents` (mudar al reconectar, no tocar lo
  que ya está en su lugar, réplica completa capital → ciudad)

## Verificación con datos reales

Poll del tracker de la rama contra `~/.hermes` (29 bases) y la selección real:

| | `main` | rama |
|---|---|---|
| `ext-hermes-096186b7` (discord bot, CLI desde `~`) | capital | **discord-music-bot** |
| filas de mapa en el panel | 161 | 99 (una por sesión) |
| filas `.hermes` | 61 | 0 |
| poll | 301 ms | 627 ms el primero, **~130 ms** los siguientes (memo) |

E2E: bridge vivo `:5274` (main) contra bridge de la rama `:5374`, misma base:
`hermes-default-20260924_192345_88e905` → capital vs **discord-music-bot**;
`…215936_54a804` → 4 filas vs 1; `…005705_e82414` → 3 filas vs 1; clones con
sufijo 62 vs 0.

## Gate

`scripts/check.sh`: tsc, eslint, prettier, vitest, build, ruff y budgets en
verde. pytest: 24 fallos en `test_command_security.py`,
`test_http_routes_files.py` y `test_repo_roots_state_realpath.py`, **idénticos
en `main`** (vienen de la restauración de `repo_roots_state.py`, 3121d1b) y
ajenos a este cambio. Suites tocadas: 89 passed (Hermes + tracker), 61 passed
(`externalAgents` + `bridge`).

## Límites conocidos

- Claude Code / Codex / Cursor (Suvadu) siguen ubicados por su `cwd`. Casi
  siempre se lanzan dentro del repo; uno lanzado desde `~` seguiría en la
  capital. Leer carpetas de su actividad implicaría leer comandos o
  transcripts, algo que hoy el tracker no hace por privacidad.
- Una mirada de ≥3 archivos a otro repo, si domina las últimas 12 menciones,
  muda la unidad hasta que la sesión vuelva a su repo.
