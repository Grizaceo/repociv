# RepoCiv — Auditoría total y rehabilitación del gate

**Fecha:** 2026-07-24
**Rama:** `feat/parent-folder-map-autolayout`
**Base:** `main` (`1088dfa`)
**Objetivo:** auditoría completa; dejar el repo completamente funcional (gate
verde) y bien documentado para poder retomarlo sin fricción.

## Veredicto

El repo estaba en muy buen estado (la frontera de seguridad es sólida y fue
verificada de nuevo). El gate `scripts/check.sh` fallaba en **un solo punto**
(npm audit) y `pip-audit` no era hermético. Tras esta auditoría **el gate pasa
completo** y quedan reparados dos bugs latentes reales, varias contradicciones
de documentación, y se añade un punto de entrada de retomabilidad
(`docs/STATE.md`).

## Método

Auditoría multi-dimensión (5 agentes en paralelo leyendo código real +
verificación adversarial de cada hallazgo concreto): gate/reproducibilidad,
correctness+seguridad backend, correctness frontend, docs/retomabilidad, e
higiene/dead-code. Resultado: **7 hallazgos confirmados, 0 refutados**, más
diez advisories. La frontera de seguridad (token/Origin en cada mutación,
membresía de repo seleccionado, contención realpath/symlink, riesgo
server-owned con piso de aprobación, atomicidad del parent-map) se re-verificó
correcta en cada ruta trazada.

## Hallazgos y remediación

### Gate (dejar el build verde)

1. **npm audit era el único gate rojo** (P0). `brace-expansion`/`postcss` (high,
   transitivos) + `valibot` (moderate, directo). El `set -e` de
   `security-audit.sh` enmascaraba los pasos posteriores.
   → `valibot ^1.4.2`, overrides `postcss ^8.5.23` + `brace-expansion ^5.0.8`.
   Lock diff mínimo (0 binarios de plataforma), `tsc` + tests de schema verdes.
   El API vulnerable de valibot (`record()/flatten()`) no se usa en `src`.

2. **pip-audit no era hermético** (P1). `python` resuelve al miniconda global,
   así que auditaba el entorno global (96 vulns ajenas), no `requirements.lock`.
   → `pip-audit -r requirements.lock --no-deps`.

3. **El lock tenía 11 advisories reales** (descubierto al hacerlo hermético;
   CVEs de 2026-07 posteriores al cierre del 2026-07-16). Todos vía `mcp`.
   → `mcp>=1.28.1` en `requirements.txt`; lock regenerado con `pip-compile`
   (`starlette 1.3.1`, `python-multipart 0.0.32`, `pydantic-settings 2.14.2`,
   `cryptography 49.0.0`). Verificado en **venv limpio**: instala,
   `mcp.server.fastmcp` importa, **837 passed / 1 skipped**, `pip-audit` = 0.
   De paso se corrigió que el lock estaba desincronizado con `requirements.txt`
   (faltaba el árbol de pip-audit; sobraba `pytest-asyncio`, sin tests async).

### Correctness (bugs latentes reales reparados)

4. **WS command double-unwrap** (P2, `server/bridge.py`). `websocket_handler` ya
   desenvuelve el envelope `{type:"command", data:{…}}` y pasa el comando
   interno; el handler volvía a exigir `type == "command"`, así que **todo
   comando por WS se ack'eaba pero nunca se despachaba** (silencioso). Latente:
   el frontend usa HTTP y `WebSocketClient.sendCommand` no tiene llamadores.
   → se extrajo `_normalize_ws_command` (nivel módulo, testeable) y el handler
   trata `data` como el comando ya-desenvuelto. Nuevos tests de regresión cubren
   ambas formas (envelope y flat) + passthrough. `12 passed / 1 skipped`.

5. **SSE nunca se cerraba al reconectar WS** (P2, `src/bridge.ts`). En
   `onStatusChange('connected')` se ponía `sseConnected=false` (no-op: ningún
   consumidor lo lee como gate) pero no se cerraba el `EventSource`, así que tras
   una recuperación de WS cada evento se procesaba **dos veces** (contadores
   dobles, spawns/notificaciones duplicados).
   → se cierra el SSE y se cancela el timer de reconexión al conectar WS.
   `tsc` + 38 tests de bridge/websocket verdes.

### Documentación (retomabilidad)

6. **`docs/ROADMAP.md`** decía que el render 3D/WebGL estaba "fuera de scope" y
   era solo experimental — pero shipeó y es trunk oficial. → sección corregida +
   banner de "snapshot histórico May-2026; la autoridad de scope es SCOPE.md".
7. **README (es/en)** mapeaba `N`→Gaceta; el código bindea `N`→wizard de nuevo
   perfil, y `H`→panel de capas estaba sin documentar. → tablas corregidas contra
   `hotkeys.ts`; la Gaceta es un panel del HUD sin hotkey dedicado.
8. **`docs/SCOPE.md`** decía "v2.0" mientras todo lo demás dice `v0.1.0-alpha`.
   → aclarado: v0.1.0-alpha es la release; "v2.0" es el hito interno de
   scope/arquitectura.
9. **`docs/GETTING_STARTED.md`** listaba `aiohttp`/`requests` (removidos). →
   lista de deps corregida contra `requirements.txt`.
10. **`docs/API.md`** no documentaba los endpoints locales del plugin Vite. →
    nueva sección "Local endpoints (Vite plugin)" (repos, selección,
    `repo/inspect`, `map-from-parent`, files).

### Higiene

- `.gitignore`: `execplan/` está ignorado pero `REPOCIV_TOTAL_REHABILITATION.md`
  es una excepción trackeada → se hizo explícita con `!…`.
- `.nvmrc` 20→22 (node real v22). `.python-version` se deja en 3.11 (floor de
  `requires-python`; el lock se compila con 3.13 — documentado en STATE).
- Sin dead code accionable: knip no reporta archivos/deps sin usar; sus ~174
  "unused exports" son ruido (verificado). Artefactos runtime en root están
  gitignored. Sin borrados de riesgo recomendados.

## Verificación final

`scripts/check.sh` **verde de punta a punta** (ver §"Verificación" del commit).
Suite backend en venv limpio con deps bumpeados: 837 passed, 1 skipped.
Frontend: `tsc`, eslint, prettier, vitest+coverage, build, budgets — verde.
Seguridad: npm 0, pip-audit hermético 0, secret scan limpio, 53 tests frontend
+ 123 backend de seguridad.

## Diferido (documentado, no reparado)

Deuda visual 3D P1/P2 (audit 2026-07-16); `main.ts` async city-add (edge case);
caveats de cursor-agent sin instalación real. Ver `docs/STATE.md` §6.
