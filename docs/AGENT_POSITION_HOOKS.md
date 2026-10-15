# Hooks de posición de agentes

## Qué está instalado

Integración de metadatos de Claude Code, Codex, Hermes (solo perfil default),
Devin CLI, MiniMax Code y OpenCode. Los hooks existentes de Suvadu y otras
automatizaciones se conservan. No se modificó el núcleo de Hermes ni otros
perfiles. OpenClaw no estaba instalado; queda fuera del alcance.

| CLI | Hooks | Prueba con modelo real |
|---|---|---|
| Claude Code | 6 eventos en `~/.claude/settings.json` | Aprobada |
| Codex | 5 eventos en `~/.codex/hooks.json` | Aprobada tras reparar Code Mode; revisión independiente pendiente |
| Hermes (default) | 4 eventos en `~/.hermes/config.yaml` | Prueba controlada con el diagnóstico nativo, sin misión con modelo |
| Devin CLI | 5 eventos en `~/.config/devin/config.json` (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`) | Aprobada (`devin-bubble-seahorse` en `formal-math-lab` → `AgentPosition:session_start` / `session_end`) |
| MiniMax Code (`mcode`) | 5 eventos en `~/.minimax/plugins/repociv-hooks/hooks/hooks.json` (plugin local compatible) | Aprobada (`mvs_298c65644d3d490c9d31b9d75dea05a3` → `ext-mcode-298c6564` en `formal-math-lab` + `AgentPosition:session_start`) |
| OpenCode | Plugin global `~/.config/opencode/plugins/repociv-hooks.js` (descubrimiento automático v2, sin editar config) | Aprobada: `opencode run` 2.0.29 con proveedor OpenAI-compatible mock local → `session_start`/`turn_start`/`tool_use`/`turn_end`/`session_end` aceptados por un `PositionStore` real, con `authority=tool` |
| OpenClaw | No instalado | Fuera de alcance |

Detalle de las pruebas con modelo en «Prueba real con modelos», al final.

Flujo: hook nativo → `server/agent_hook_client.py` → POST autenticado a
`http://127.0.0.1:5274/api/agent-events` → `PositionStore` → tracker existente → mapa.
Cada cambio de ciudad deja además una fila en `events.jsonl` (ver «Registro en el event store»).
No se crea ninguna identidad a partir de un hook. Si llega antes de que una fuente
existente detecte la sesión, se conserva la ubicación y se aplica cuando aparece
esa identidad verificada. Esto puede retrasar la aparición inicial hasta el próximo
poll, pero evita unidades provisionales, duplicados y contadores inventados.

## Autoridad de ubicación

- Se priorizan `tool_input.workdir`, `cwd` explícito de herramienta y rutas de archivos
  (incluida la forma camelCase `filePath` que emite OpenCode).
- Una ruta relativa se resuelve contra el cwd recibido; el servidor elige el repo mapeado
  más específico que contiene la ruta. No se aceptan `cityId`/`unitId` del cliente.
- Solo se reconoce un `cd` literal al comienzo de un comando shell. No se interpretan
  expansiones, globbing, prosa, código entre comillas o heredocs.
- Codex en Code Mode no entrega el workdir en el hook. El cliente lo toma del
  `CommandExecution` completado en el rollout nativo de esa misma sesión, emparejado
  por IDs exactos de sesión, turno y herramienta, y solo si terminó con código 0.
  Si falta o es ambiguo, vale el cwd recibido.
- Si no hay datos concretos, el cwd nativo sirve como fallback. El cwd de arranque
  de un hijo de compresión Hermes no borra el último workdir concreto de su linaje.
- La fuente Hermes entrega IDs del linaje de compresión verificado, no IDs arbitrarios
  del payload. Se conserva la misma unidad al cambiar de sesión nativa. El cierre de
  un ancestro no cierra al hijo activo.
- Repos fuera del mapa no inventan ciudades. Eventos de ciclo sin repo válido conservan
  una posición reciente para no perderla al terminar el turno.

El overlay es volátil, TTL 600 segundos, máximo 1024 registros; la reconciliación
de unidades está serializada. Si el poll está ocupado, el hook guarda su ubicación
sin esperar el lock y se aplica en el siguiente poll. Las fuentes anteriores continúan operando si
el bridge/hook falla o expira la ubicación. La posición visible es la última ubicación
observable: no se deduce intención desde el texto del agente.

El endpoint devuelve 503 con un error genérico si falla el servicio de posición o
el estado de repos; no expone rutas privadas ni corta la conexión sin HTTP. La
lista de repos se lee una sola vez, fuera del lock de escritura. Metadatos inválidos
devuelven 400, distinguibles de fallos operativos. Suvadu conserva sus IDs originales;
se usa una clave de correspondencia adicional para su variante native_id prefijada.
Un profile Hermes vacío se normaliza a default.

## Registro en el event store

El overlay en memoria no sobrevive a un reinicio del bridge. Para dejar rastro,
`post_agent_events` agrega una fila `AgentPosition:<event>` a `events.jsonl` cuando
una sesión se ubica por primera vez, cambia de ciudad o termina. Las pistas repetidas
para la misma ciudad no escriben nada. Una sesión que vuelve tras expirar el TTL
cuenta como primera ubicación.

- La fila lleva `cli`, `profile`, `sessionId` y `cityId`. No lleva el cwd, rutas de
  archivos ni argumentos de herramientas. `cityId` codifica la ruta del repo seleccionado.
- `commandId` queda vacío: el panel de Actividad agrupa filas en ejecuciones por
  `commandId`, y una sesión nativa no es un comando de RepoCiv.
- En el panel de Actividad estas filas aparecen como «sin correlación», con tipo y
  hora. Sus campos de `data` no están en la allowlist de `/log?metadata=1`.
- Si falla la escritura, el hook igual recibe 200.

Verificado con dos pruebas dirigidas y contra un event store real en un directorio
temporal (4 pistas → 3 filas). En el bridge vivo, tras reiniciarlo, dos sesiones
reales de Claude Code dejaron una fila cada una: una en la capital y otra en un
repo seleccionado. Las pistas siguientes de la misma sesión no agregaron filas.
No se observó en vivo un cambio de ciudad ni un cierre de sesión.

## Eventos y consentimiento

Claude: SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure, Stop, SessionEnd.
Codex: los mismos salvo PostToolUseFailure, no admitido por esta instalación.
Codex usa `~/.codex/hooks.json`, no notify ni wrapper. Sus hooks RepoCiv quedaron
habilitados mediante la UI nativa de consentimiento; no se editaron hashes manualmente.
Hermes: on_session_start, post_tool_call, on_session_end (fin de turno),
on_session_finalize (cierre de sesión). Sus comandos fueron registrados en la
allowlist oficial, sin reemplazar otros hooks.
OpenCode: el plugin usa la API nativa v2 — `prompt` (primer evento → `session_start`,
luego `turn_start`), `execute.before` → `tool_use`, `session.execution.succeeded/failed`
→ `turn_end`, `session.deleted` → `session_end`. Solo se envían session_id, cwd y la
ruta/comando concreto de la herramienta (las claves `filePath`/`file_path`/`path`/
`workdir`/`command` del input, filtradas); el prompt y los resultados nunca salen.
La entrega es fail-open vía `spawn` detached, igual que el resto de los hooks.
`session.execution.*` puede llegar repetido si el servicio opencode de vida larga
recargó el plugin (suscriptores viejos aún vivos): RepoCiv trata `turn_end` como
heartbeat idempotente, no como par estricto de turno.

Las sesiones CLI ya abiertas pueden necesitar reinicio para releer su configuración.

## Privacidad y reversión

El helper envía exclusivamente cli/event/session_id/profile/cwd/authority cuando
corresponde, nunca prompts, respuestas, resultados ni el payload completo.
Solo permite loopback, falla abierto y no devuelve instrucciones al CLI.
El bridge no conserva ese cwd: guarda la referencia al repo seleccionado que lo contiene.
La credencial va en X-RepoCiv-Token y reside en `~/.config/repociv/hooks/client.json`
con modo 0600. No copiar ese archivo a Git ni a informes.

Instalador de alcance propio, idempotente entre intérpretes y con backups privados en
`~/.config/repociv/hooks/backups/`. Para retirar únicamente nuestros comandos:

```sh
cd ~/.hermes/workspace/ACTIVE/repociv
.venv/bin/python -m server.agent_hook_install remove
```

La remoción no borra los hooks ajenos ni revoca manualmente el historial de confianza
Codex/Hermes. Conserva el cliente privado y los backups por seguridad de reversión.
Para instalar otra vez se necesita REPOCIV_TOKEN en el entorno privado, nunca en la
línea de comandos ni en el chat.

## Verificación efectuada

1. Suite completa `scripts/check.sh`: exit 0; 1329 pruebas Python, 2 omitidas;
   1126 pruebas del frontend. TypeScript, ESLint, Prettier, Ruff, build y budgets OK.
   Knip es informativo; mypy no estaba instalado y se omitió, como informa el gate.
2. Comparación con backups: hooks previos y configuración ajena preservados en
   Claude/Codex/Hermes; cliente 0600. Codex tiene 9 entradas confiadas, incluidas
   las 5 nuevas de RepoCiv y las 4 existentes.
3. Prueba CONTROLADA usando el diagnóstico nativo Hermes `shell_hooks.run_once`,
   metadatos explícitos de lectura git status, bridge y navegador reales: la misma
   unidad `ext-hermes-c8fc9fd1` pasó de formal-math-lab (q=0,r=1) a financial-lab
   (q=2,r=3). La identidad y el sessionId del directorio frontend se conservaron;
   había exactamente una unidad con ese ID. Incluyó continuidad del linaje de
   compresión. Evidencia sanitizada en `docs/hooks-verification.json`.

**Límite de evidencia de esta etapa:** la prueba visual end-to-end aquí fue Hermes.
Las misiones con modelo en Claude y Codex se ejecutaron después; ver «Prueba real
con modelos».

Referencia inicial: `/home/gris96/figures/repociv-vs-agentcraft/hooks-mapping/hooks-mapping.md`.
Sus sketches restantes son históricos; para código vigente consultar los módulos
`server/agent_hook_client.py`, `server/agent_positions.py`, `server/agent_hook_install.py`.


## Correcciones tras revisión adversarial

Los dos bloqueantes señalados fueron reproducidos antes de corregirlos (7 casos
rojos incluyendo variantes) y pasaron después. Verificación posterior:

- 134 pruebas dirigidas aprobadas; Ruff sobre server completo: exit 0.
- Backend completo: 1342 aprobadas, 2 omitidas (exit 0).
- Tres pruebas con BridgeHandler HTTP real: fallo de registro → 503 genérico;
  recuperación → 400 para metadatos inválidos, luego 200 para un hook válido.
- Servicio local recargado y saludable; hooks controlados de Claude/Codex aceptados
  sin crear sesiones fantasma mientras ninguna fuente verificó su identidad.

Estos resultados son posteriores al gate integral de la sección anterior; el
frontend no cambió. No sustituyen la prueba con misiones reales de Claude/Codex.


## Segunda revisión: hallazgos contrastados con versión actual

El informe secundario describía varios problemas ya corregidos. La inspección local
solo encontró una entrada propia por evento en los tres CLI; no confirmó la supuesta
duplicación instalada. Sí se reprodujo la no-idempotencia al cambiar intérprete.

Correcciones adicionales:

- Identidad semántica del hook = script exacto + CLI + evento, no ruta del Python.
  Conserva el primer comando literal (y su consentimiento), elimina solo variantes
  propias duplicadas y no toca Suvadu ni otros clones. La remoción reconoce todas
  las variantes de intérprete de ese mismo script.
- Presupuesto independiente de posiciones: 600 POST/min/IP; los controles normales
  mantienen 60/min/IP. Ambos quedan detrás de autenticación; ninguno consume al otro.
- El endpoint de posición no admite modo auth-off: sin token configurado devuelve
  503 position_auth_required. Credencial ausente/errónea con token configurado: 401.
  Esto no es aislamiento de procesos del mismo UID que pueden leer el cliente privado.
- Durante un poll ocupado se acepta el hint en su store thread-safe y se difiere la
  reconciliación; el HTTP no espera por los subprocess/DB de ese poll.
- first_ms se reinicia al ingresar tras el TTL de la ubicación anterior.

12 regresiones fallaron en una copia aislada de la implementación previa; después
55 pruebas dirigidas (orden inverso) pasaron. Gate integral actualizado: 1355 Python
aprobadas, 2 omitidas; 1126 frontend aprobadas, lint/build/budgets OK, exit 0.
Knip informativo, mypy omitido porque no está instalado.

Servicio recargado tras comprobar cero misiones internas activas. Verificación real
sin mutar identidades: 61 POST de hooks con metadatos inválidos → 400, un POST normal
al endpoint inexistente → 404 (no 429), hook sin token → 401, health y lectura del
directorio de sesiones OK. No fue necesario reescribir configs privadas: todos los
hooks propios siguen siendo únicos y cambiar intérprete sería un no-op semántico.

No hay nueva prueba visual ni misión con modelo Claude/Codex en esta revisión.
La recanonización de ciudades por observación sigue siendo una optimización pendiente;
no se atribuye una prueba de carga grande a los resultados funcionales.


## Prueba real con modelos

Posterior a las dos revisiones. Modelos reales por sus CLI nativas, con comandos de
solo lectura en formal-math-lab y financial-lab, sin pistas sintéticas. Registro
completo en `REAL_CLI_POSITION_TEST_2026-10-12.md`.

- **Claude Code: aprobado.** La misma unidad pasó de formal-math-lab (0,1) a
  financial-lab (2,3) y se mantuvo allí.
- **Codex: falló en la primera corrida, aprobado tras la reparación.** En Code Mode
  el workdir va dentro del cuerpo JavaScript de la herramienta `exec`, que el
  adaptador no analiza a propósito, y la unidad quedó en formal-math-lab. La
  reparación es la correlación con el rollout nativo descrita en «Autoridad de
  ubicación». En la repetición, la misma sesión y unidad pasaron de (0,1) a (2,3).
  Evidencia: `evidence/codex-code-mode-fixed-2026-10-12.json`.
- **OpenCode: aprobado (2026-10-15) con proveedor mock local.** `opencode run`
  (v2.0.29) contra un proveedor OpenAI-compatible descartable en `127.0.0.1:8899`/
  `8900` (`provider.opencode.options.baseURL`), porque el free tier de esta máquina
  bloquea los modelos alojados por CLI/API. Con el plugin global instalado, un
  `PositionStore` real detrás del bridge real (puerto efímero, token de prueba)
  recibió: `session_start` + `turn_start` al primer prompt, un `tool_use` con
  `authority=tool` y la ruta resuelta del `cd` de una tool `shell`, `turn_end` al
  terminar la ejecución y `session_end` al borrar la sesión. Todos los cuerpos
  llevaron solo `{cli, event, session_id, cwd, authority}`; un payload manual con
  `content`/`prompt` secretos no filtró ninguna cadena (la ruta del `filePath` se
  resolvió con `authority=tool`). El plugin se instaló y se retiró con el marcador
  de propiedad, sin tocar `opencode.jsonc` ni los hooks ajenos.

Límites de esta evidencia:

- OpenCode usó un modelo servido por el mock local: valida la integración (plugin,
  cliente, bridge, store), no un modelo alojado. No se probaron la TUI interactiva
  ni `session.execution.failed`.
- En una sesión de servicio opencode de vida larga que recarga el plugin (varios
  ciclos de instalación durante la prueba), el mismo evento nativo se entregó hasta
  ~10 veces (una por carga viva del plugin). El store es idempotente para pistas
  iguales y `turn_end` no cambia la ubicación; con el plugin cargado una vez tras un
  arranque limpio del servicio no se midió (el servicio es compartido y no se
  reinicia en la verificación).

- La evidencia de la reparación declara su revisión como «pending independent review».
- `server/agent_hook_client.py` se modificó a las 11:10, después de la repetición
  registrada a las 11:02. Las 88 pruebas dirigidas pasan sobre la versión final,
  pero la corrida real de Codex no se repitió sobre ella.
- Hermes sigue sin misión con modelo: su prueba fue la controlada de la sección
  «Verificación efectuada».
