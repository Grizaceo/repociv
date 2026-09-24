# Evidencia: unidades Hermes en la ciudad de su carpeta (cwd derivado)

**Fecha**: 2026-09-23
**Rama**: `fix/ext-agent-map-placement`
**Base**: `main` @ `65f4b2c`
**Método**: TDD (tests primero), verificación E2E contra un bridge propio en
puerto aparte, gate completo `scripts/check.sh`.

## El bug (P1)

Las tres unidades `ext-hermes-*` activas aparecían alrededor de la **capital**
aunque su carpeta de trabajo fuera una ciudad del mapa:

```
ext-hermes-16e2d8bd  cityId=capital  repo=(vacío)
ext-hermes-533a6b00  cityId=capital  repo=(vacío)
ext-hermes-246be7eb  cityId=capital  repo=(vacío)
ext-claude-code-0891bbbe  cityId=repo:L2hvbWUu…  repo=lexo-alpha
```

## Causa raíz

- `sessions.cwd` dejó de persistirse en las sesiones de desktop (regla
  deliberada de Hermes del 2026-09-18): 109/109 sesiones desktop de los últimos
  días traen `cwd = NULL`, y `git_repo_root` nunca se llenó (0 filas).
- `HermesSource._observe` construía `Observation(cwd=row.cwd)`; con `cwd`
  vacío, el tracker resuelve `city_for("")` → **capital**. El resto de la
  cadena (`reconcile → city_of → city_for`) ya funcionaba bien con cwd real.

El único camino RepoCiv-side es derivar la carpeta **de la propia actividad de
la sesión**: su `state.db` guarda los `path`/`workdir` de sus tool calls y los
`cd` de sus comandos.

## Fix implementado

| Pieza | Dónde | Qué hace |
|---|---|---|
| `_derive_cwd(conn, sid)` | `server/hermes_sessions.py` | Deriva el repo git de la actividad reciente: parsea los `arguments` (JSON) de los tool calls, junta candidatos `path`/`workdir` y `cd`; cuenta por repo git envolvente; gana el que acumula **≥3 menciones** (`_DERIVE_MIN_HITS`), best-effort: error de sqlite → capital, como antes |
| `_work_repo(path)` | idem | Un ancestro **oculto** (`~/.hermes`, cachés de tooling) no captura la unidad: solo gana si el hint vive ahí (`~/.dotfiles/x`). Sin esto, un archivo bajo un scratch derivaba hasta el `.git` de `~/.hermes` |
| `_observe` | idem | `cwd = row.cwd or _derive_cwd(conn, row.id)` |

Reutiliza `_enclosing_git_repo` del tracker (sin ciclo de imports) y valida
`isdir` del directorio antes de contar. `docs/EXTERNAL_AGENTS.md` documenta la
regla nueva en «Qué aparece y dónde».

## TDD

Dos tests rojos primero, en `server/test_hermes_sessions.py`:

- `test_cwd_derived_from_tool_paths_when_the_row_has_none` — 3 `path` al mismo
  repo ganan ciudad; 1 mención suelta queda en capital.
- `test_cwd_derived_from_terminal_cd_when_the_row_has_none` — 3 `cd` al mismo
  repo ganan ciudad.

Rojo inicial por la razón correcta (`'capital' == 'repo:…'`), verde tras el
fix. Suite del módulo: **31 passed** (29 base + 2 nuevos); tracker: 52 passed.

## Verificación E2E (bridge propio, puerto aparte)

Misma `~/.hermes/state.db` **real**, sin tocar el stack vivo: bridge de `main`
en `:5274` (código viejo) contra bridge de la rama en `:5374`:

| Unidad | :5274 (main) | :5374 (rama) |
|---|---|---|
| `ext-hermes-ef3ff23e` | `capital`, `repo=''` | **`repo:…job-search-cristobal`**, `repo='job-search-cristobal'` |
| `ext-hermes-7ccc6ddd` | `capital`, `repo=''` | `capital`, `repo='repociv'` (RepoCiv nunca es ciudad: regla 2 de `city_for`) |
| `ext-hermes-cb02be60` | `capital`, `repo=''` | `capital`, `repo=''` (sin ≥3 menciones): no se mueve |

La unidad de la carpeta `job-search-cristobal` migró de la capital a su ciudad
con datos reales; las otras dos se comportan como manda la regla (capital por
diseño / umbral no alcanzado).

## Gate

`bash scripts/check.sh` → **All checks green** (exit 0):

- vitest **1014 passed**; tsc, eslint (max-warnings 0), prettier, build — verdes;
- pytest **1190 passed, 2 skipped**, cobertura **81.38%** (piso 50%);
- ruff server/ — verde.

## Límites conocidos

- Derivación **best-effort**: cualquier error de sqlite conserva la capital
  (idéntico a antes del fix).
- El umbral ≥3 es deliberado: mejor capital que una ciudad equivocada por una
  mirada de paso.
- El fix es RepoCiv-side: no cambia a Hermes ni pide que vuelva a persistir
  `cwd`.
- P2 (ciudades no seleccionadas), P3 (localStorage vs state.json) y P4
  (spawn por carpeta) quedan fuera de este cambio: son decisiones del usuario.

## Puesta en vivo

El 2026-09-23 el stack vivo se relanzó **fuera de la sesión de chat** (camino de
diseño: `setsid` + `scripts/dev-start.sh` desprendido, patrón de
`scripts/repociv-app.sh`), para que corra el código de esta rama y no muera con
el chat que lo lanza.

Verificación:

- supervisor **90461** — `SID=PGID=90461`, **PPID 1231** = `systemd --user`
  (`1231 → 1`): ya no cuelga de la app de Hermes.
- bridge **90483** y Vite **90500** corren bajo ese supervisor.
- La API viva sirve unidades **derivadas** (`repo:…`, `lexo-alpha`): el proceso
  que atiende a la app es el código nuevo.

Nota forense: el traceback de `datetime` en `~/.repociv/logs/bridge.log`
proviene de una corrida vieja (encabezado del archivo, previo a los reinicios)
en `_endpoint_usage.record`; `~/.repociv/endpoint_usage.json` se escribe al día
— no está relacionado con este cambio.
