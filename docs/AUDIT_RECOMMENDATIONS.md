# RepoCiv - Auditoria end-to-end y plan de mejoras

Fecha de esta pasada: 2026-06-01

## Resumen ejecutivo

RepoCiv esta en buen estado funcional para alpha single-user. La superficie principal
esta cubierta por tests frontend y backend, el hardening critico ya esta aplicado, y
los problemas bloqueantes encontrados en esta pasada fueron de testabilidad/entorno,
no de regresion funcional.

Los cambios implementados en esta pasada aislan el directorio de configuracion usado
por pytest, agregan una API explicita para rebindear el estado persistente del
bridge, amplian la telemetria local de dogfooding a hotkeys, registran uso de
endpoints del bridge y corrigen el bootstrap para respetar selecciones de repos ya
guardadas. Esto mantiene las features actuales y permite ejecutar la suite en
entornos read-only o CI.

## Evidencia actual

- `npm run format:check`: pasa.
- `npm run lint`: pasa con `--max-warnings=0`.
- `npm run check`: pasa (`tsc --noEmit`, 409 tests frontend, build Vite).
- `npm run test:e2e`: 4 tests Playwright pasan.
- `pytest -q server`: 644 tests backend pasan, 1 skipped, ejecutado fuera del
  sandbox porque los tests HTTP/WebSocket necesitan sockets localhost.

## Cambios implementados

### A1 - Aislar estado de backend en tests

Problema:

- `server.bridge` inicializa stores en import usando `REPOCIV_CONFIG_DIR` o
  `~/.repociv`.
- En entornos con home read-only, la coleccion de pytest fallaba antes de ejecutar
  tests al intentar crear `~/.repociv/directive_records.jsonl`.

Solucion:

- `conftest.py` define `REPOCIV_CONFIG_DIR` con un directorio temporal antes de que
  los tests importen modulos de `server`.
- El comportamiento normal de desarrollo y runtime no cambia porque se usa
  `os.environ.setdefault(...)`.

Criterio de aceptacion:

- La coleccion de pytest ya no depende de permisos de escritura en el home real.
- La suite backend completa pasa cuando se ejecuta con permisos para sockets locales.

### A2 - Inicializacion explicita e idempotente del bridge

Problema:

- `server.bridge` inicializaba stores persistentes directamente en el cuerpo del
  modulo.
- Eso hacia mas dificil testear o rebindear el estado sin tocar globals internos uno
  por uno.

Solucion:

- `server.bridge.init_bridge_state(config_dir)` centraliza la inicializacion de
  `event_store`, `sessions`, `run_state`, `workspace_issue`, `checkpoint`,
  `directive_store` y templates de directivas.
- La funcion actualiza `CONFIG_DIR` y `MISSIONS_FILE`, crea el directorio si falta y
  es idempotente.
- El modulo sigue llamando `init_bridge_state(CONFIG_DIR)` en import para preservar
  compatibilidad con `python3 -m server.bridge` y con callers existentes.

Criterio de aceptacion:

- `pytest -q server/test_bridge_integration.py -k init_bridge_state` pasa.
- `pytest -q server/test_bridge_integration.py` pasa con sockets localhost
  permitidos.

### A3 - Telemetria local de hotkeys para dogfooding

Problema:

- `docs/SCOPE.md` pide registrar hotkeys y paneles para decidir poda por uso real.
- `src/ui/analytics.ts` registraba paneles abiertos por clicks, pero no hotkeys.

Solucion:

- `trackHotkey(hotkey)` persiste conteos en `localStorage('repociv:analytics')`.
- La carga de analytics migra payloads antiguos sin `hotkeysUsed`.
- `wireHotkeys(...)` registra hotkeys ejecutadas y tambien registra aperturas de
  paneles activadas por hotkeys cuando existe un predicado `isXOpen()`.
- El panel Stats de la capital muestra el total de hotkeys usadas.

Criterio de aceptacion:

- `npx vitest run src/ui/analytics.test.ts` pasa.
- `npx tsc --noEmit` pasa.
- `npm run format:check` pasa.

### A4 - Telemetria local de endpoints del bridge

Problema:

- `docs/SCOPE.md` pide usar telemetria de endpoints para podar rutas muertas.
- El bridge no exponia un agregado simple de uso por ruta.
- Al probar `/metrics` se detecto que `http_routes.get_metrics` importaba
  `compute_metrics` desde `server.bridge`, donde no existe.

Solucion:

- `server/endpoint_usage.py` registra conteos agregados por metodo, ruta
  normalizada y status en `endpoint_usage.json`.
- `BridgeHandler` registra uso desde `_json`, `_respond`, `_err_json` y SSE.
- `/metrics` incluye `endpointUsage` con las rutas mas usadas.
- `get_metrics` importa `compute_metrics` desde `server.metrics`, corrigiendo el
  bug de runtime del endpoint.

Criterio de aceptacion:

- `pytest -q server/test_endpoint_usage.py` pasa.
- `pytest -q server/test_bridge_integration.py` pasa con sockets localhost
  permitidos.
- `pytest -q server/test_metrics.py server/test_endpoint_usage.py` pasa.

### A5 - Bootstrap de onboarding respeta selecciones persistidas

Problema:

- `src/main.ts` llamaba siempre `runRepoOnboarding()`.
- Eso forzaba el modal de seleccion en cada arranque aunque existiera
  `repociv:selected-repos:v1`, bloqueando flujos de usuario recurrente y e2e.

Solucion:

- El bootstrap usa `openOnboardingPanel()`, que ya contiene la logica de saltar el
  onboarding cuando hay una seleccion valida o cuando hay seleccion guardada y
  `/api/repos` falla.
- Los e2e escriben una seleccion real en `localStorage` y validan que el mapa
  arranque directo, que DAVI aparezca, que el bridge procese comandos y que el
  error de `/api/repos` siga visible sin pantalla vacia.

Criterio de aceptacion:

- `npm run test:e2e` pasa con 4 tests.
- `npm run check` pasa despues del cambio en `src/main.ts`.

### A6 - Smoke script compatible con `.env` no trivial

Problema:

- `scripts/smoke-test.sh` cargaba `.env` con `export $(... | xargs)`, lo que parte
  valores con espacios y caracteres shell.

Solucion:

- El script usa `set -a; source "$REPO_ROOT/.env"; set +a`, igual que
  `scripts/healthcheck.sh`.

Criterio de aceptacion:

- `bash -n scripts/smoke-test.sh scripts/healthcheck.sh` pasa.

## Hallazgos previos cerrados por el estado actual

Estos items estaban en auditorias anteriores, pero el codigo actual ya los resuelve:

- `scripts/healthcheck.sh` carga `.env` con `set -a; source ...; set +a`, sin
  `xargs`, por lo que no parte tokens con espacios.
- `server/bridge.py` ya usa `hmac.compare_digest(...)` para validar
  `X-RepoCiv-Token`.
- `index.html` ya no carga dependencias desde CDN para `lucide`, Popper, Tippy o
  auto-animate; las dependencias relevantes estan en `package.json`.
- La doble asignacion historica de F6 y la referencia `refreshCityList()` ya no
  aparecen como defectos activos en la superficie revisada.
- El split de `graph_relations.py` ya existe como facade sobre modulos separados.

## Riesgos vigentes

### R1 - Imports con efectos secundarios en backend

Estado: mitigado parcialmente con API explicita.

`server.bridge` todavia auto-inicializa stores al importarse para compatibilidad,
pero la inicializacion ya esta centralizada y se puede rebindear con
`init_bridge_state(config_dir)`.

Plan:

1. Mantener auto-init mientras `BridgeHandler` siga siendo el entrypoint principal.
2. Mover tests nuevos que necesiten estado aislado a `init_bridge_state(tmp_path)`.
3. Solo considerar eliminar auto-init cuando el bridge tenga una factory/entrypoint
   explicito y tests de runtime equivalentes.

No ejecutar como refactor masivo hasta que haya una razon funcional: toca core del
bridge.

### R2 - `bridge.py` sigue siendo el modulo de mayor riesgo

Estado: aceptable para alpha, pero caro de auditar.

Aunque ya hay modulos extraidos (`pending_tracker.py`, `provider_registry.py`,
`sse_server.py`, `http_routes.py`, etc.), `bridge.py` todavia concentra routing,
auth, rate limiting, estado de fatiga, misiones y handlers HTTP.

Plan:

1. No reescribir.
2. Extraer solo handlers por rutas cuando un bug o test nuevo lo justifique.
3. Preservar `BridgeHandler` como facade publica hasta que el alpha dogfooding
   demuestre que el bridge es friccion real.

### R3 - Tests con sockets dependen del entorno

Estado: esperado.

Los tests HTTP/WebSocket fallan dentro de sandboxes que bloquean `socket.socket`.
No es una falla de RepoCiv, pero debe quedar documentado para CI/agentes.

Plan:

1. Ejecutar `pytest -q server` en un entorno con sockets localhost permitidos.
2. Si CI tambien bloquea sockets, marcar solo esos tests con un fixture de
   capacidad que haga skip cuando no se pueda abrir un socket local.
3. No mockear esos tests por defecto: validan comportamiento real de HTTP/WebSocket.

### R4 - Poda de UI pendiente de dogfooding

Estado: instrumentacion ampliada, decision de poda pendiente de datos.

`docs/SCOPE.md` exige no agregar features grandes y decidir poda por uso real. La
telemetria de paneles/capas/hotkeys/endpoints existe parcialmente, pero la poda
todavia requiere datos de 4 semanas.

Plan:

1. Mantener telemetria local de paneles, capas, hotkeys y endpoints.
2. Revisar datos despues del periodo de dogfooding.
3. Remover o archivar paneles sin uso real solo con evidencia.

## Plan de arreglos y mejoras

### Fase 0 - Gates y reproducibilidad

Estado: cerrado en esta pasada.

- Mantener `npm run format:check`, `npm run lint`, `npx tsc --noEmit`,
  `npm run test`, `npm run test:e2e` y `pytest -q server` como gates minimos.
- Documentar que los tests backend de sockets requieren localhost permitido.
- Evitar escrituras al home real durante tests.
- Usar `init_bridge_state(tmp_path)` en tests que necesiten stores backend aislados.

### Fase 1 - Hardening compatible con alpha

Estado: mayormente cerrado.

- Mantener comparacion constante de token.
- Mantener healthcheck robusto con `.env`.
- Revisar warnings de auth cuando `REPOCIV_REMOTE=true`.
- No agregar controles multi-tenant, Landlock, eBPF ni mesh networking: fuera de
  scope actual.

### Fase 2 - Refactor quirurgico del bridge

Estado: backlog controlado.

- Mantener `init_bridge_state(...)` como punto unico para rebinding de stores.
- Seguir moviendo rutas a modulos pequenos cuando se toque una ruta por bug.
- Agregar tests antes de cada extraccion para preservar contratos.

### Fase 3 - Dogfooding y poda

Estado: pendiente de datos.

- Registrar uso de paneles, hotkeys y endpoints.
- Revisar despues del periodo definido en `docs/SCOPE.md`.
- Podar superficie UI/backend sin uso real, manteniendo las features actuales que si
  se usan.

## No hacer en esta etapa

- No introducir multi-tenant.
- No cambiar Canvas 2D por WebGL/Three.js en trunk.
- No agregar features cosmeticas grandes sin dolor observado.
- No hacer una reescritura global de `bridge.py`.
- No eliminar paneles sin telemetria de uso real.
